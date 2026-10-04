import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { isPublicAddress } from "../../../egress.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const REPLY = { succeeded: 0, failure: 1, notAllowed: 2, hostUnreachable: 4, refused: 5, commandUnsupported: 7, addressUnsupported: 8 } as const;

export type HostResolver = (hostname: string) => Promise<string[]>;

export interface BrowserEgressProxy {
  /** Proxy URL for Chrome's proxy setting. */
  server: string;
  close(): Promise<void>;
}

const resolveHost: HostResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

/**
 * A local SOCKS5 proxy for the integrated browser. Chrome sends every connection through it (pages,
 * frames in other processes, workers, service workers and WebSockets) and resolves no host names
 * itself, so the decision is made on the address actually connected to and cannot be changed by a
 * second DNS answer. Trusted tracker hosts may be anywhere, including an administrator's mirror on
 * the local network; every other destination must be a public internet address.
 */
export async function startBrowserEgressProxy(
  isTrustedHost: (hostname: string) => boolean,
  resolve: HostResolver = resolveHost,
): Promise<BrowserEgressProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };
  const server: Server = createServer((client) => {
    track(client);
    void relay(client, isTrustedHost, resolve, track).catch(() => client.destroy());
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const { port } = server.address() as { port: number };
  return {
    server: `socks5://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

async function relay(
  client: Socket,
  isTrustedHost: (hostname: string) => boolean,
  resolve: HostResolver,
  track: (socket: Socket) => void,
): Promise<void> {
  client.setNoDelay(true);
  client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
  const reader = byteReader(client);
  const reply = (code: number): void => void client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));

  const [version, methodCount] = await reader.read(2);
  if (version !== 5) return void client.destroy();
  const methods = await reader.read(methodCount);
  if (!methods.includes(0)) return void client.end(Buffer.from([5, 0xff]));
  client.write(Buffer.from([5, 0]));

  const [, command, , addressType] = await reader.read(4);
  let hostname: string;
  if (addressType === 1) hostname = [...await reader.read(4)].join(".");
  else if (addressType === 3) hostname = (await reader.read((await reader.read(1))[0])).toString("latin1").toLocaleLowerCase("en-US");
  else if (addressType === 4) hostname = ipv6Text(await reader.read(16));
  else return reply(REPLY.addressUnsupported);
  const port = (await reader.read(2)).readUInt16BE(0);
  if (command !== 1) return reply(REPLY.commandUnsupported);

  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    return reply(REPLY.hostUnreachable);
  }
  if (addresses.length === 0) return reply(REPLY.hostUnreachable);
  if (!isTrustedHost(hostname) && addresses.some((address) => !isPublicAddress(address))) return reply(REPLY.notAllowed);

  const upstream = await connectFirst(addresses, port);
  if (!upstream) return reply(REPLY.refused);
  track(upstream);
  client.setTimeout(0);
  const leftover = reader.detach();
  client.write(Buffer.from([5, REPLY.succeeded, 0, 1, 0, 0, 0, 0, 0, 0]));
  if (leftover.length > 0) upstream.write(leftover);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}

async function connectFirst(addresses: string[], port: number): Promise<Socket | undefined> {
  for (const address of addresses) {
    const socket = await new Promise<Socket | undefined>((done) => {
      const candidate = connect({ host: address, port });
      candidate.setTimeout(HANDSHAKE_TIMEOUT_MS, () => candidate.destroy(new Error("connection timed out")));
      candidate.once("connect", () => {
        candidate.setTimeout(0);
        done(candidate);
      });
      candidate.once("error", () => done(undefined));
    });
    if (socket) {
      socket.setNoDelay(true);
      return socket;
    }
  }
  return undefined;
}

function byteReader(socket: Socket) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  let pending: { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void } | undefined;
  const flush = () => {
    if (!pending || buffered.length < pending.size) return;
    const { size, resolve } = pending;
    pending = undefined;
    const bytes = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    resolve(bytes);
  };
  const onData = (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    // A SOCKS handshake is a few hundred bytes; anything larger is not a well-behaved client.
    if (buffered.length > 65_536) socket.destroy();
    else flush();
  };
  const onClose = () => {
    closed = true;
    pending?.reject(new Error("connection closed during the SOCKS handshake"));
  };
  socket.on("data", onData);
  socket.once("close", onClose);
  return {
    read: (size: number) => new Promise<Buffer>((resolve, reject) => {
      if (closed) return reject(new Error("connection closed during the SOCKS handshake"));
      pending = { size, resolve, reject };
      flush();
    }),
    /** Stops reading and returns bytes the client already sent past the handshake. */
    detach: () => {
      socket.pause();
      socket.off("data", onData);
      socket.off("close", onClose);
      return buffered;
    },
  };
}

function ipv6Text(bytes: Buffer): string {
  const groups = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16));
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}
