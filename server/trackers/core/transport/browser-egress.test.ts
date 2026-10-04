import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startBrowserEgressProxy, type BrowserEgressProxy, type HostResolver } from "./browser-egress.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function echoServer(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

async function proxy(isTrustedHost: (hostname: string) => boolean, resolve?: HostResolver): Promise<number> {
  const started: BrowserEgressProxy = await startBrowserEgressProxy(isTrustedHost, resolve);
  cleanup.push(() => started.close());
  return Number(new URL(started.server).port);
}

/** Minimal SOCKS5 client: returns the reply code and, on success, the open tunnel. */
async function socksConnect(proxyPort: number, host: string, port: number, command = 1): Promise<{ code: number; socket: Socket }> {
  const socket = connect({ host: "127.0.0.1", port: proxyPort });
  cleanup.push(async () => { socket.destroy(); });
  let buffered = Buffer.alloc(0);
  let waiting: (() => void) | undefined;
  socket.on("data", (data) => { buffered = Buffer.concat([buffered, data]); waiting?.(); });
  const read = async (size: number) => {
    while (buffered.length < size) await new Promise<void>((resolve) => { waiting = resolve; });
    const bytes = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return bytes;
  };
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(Buffer.from([5, 1, 0]));
  expect([...await read(2)]).toEqual([5, 0]);
  const address = /^\d+\.\d+\.\d+\.\d+$/u.test(host)
    ? Buffer.from([1, ...host.split(".").map(Number)])
    : Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host, "latin1")]);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, command, 0]), address, portBytes]));
  const reply = await read(10);
  socket.removeAllListeners("data");
  return { code: reply[1], socket };
}

describe("integrated browser egress proxy", () => {
  it("relays connections to trusted hosts in both directions", async () => {
    const echo = await echoServer();
    const proxyPort = await proxy((hostname) => hostname === "127.0.0.1");
    const { code, socket } = await socksConnect(proxyPort, "127.0.0.1", echo);
    expect(code).toBe(0);
    const reply = new Promise<string>((resolve) => socket.once("data", (data) => resolve(data.toString())));
    socket.write("ping");
    expect(await reply).toBe("ping");
  });

  it("refuses local addresses for untrusted hosts, whether given as an address or a name", async () => {
    const echo = await echoServer();
    const proxyPort = await proxy(() => false);
    expect((await socksConnect(proxyPort, "127.0.0.1", echo)).code).toBe(2);
    expect((await socksConnect(proxyPort, "localhost", echo)).code).toBe(2);
  });

  it("decides on the address it connects to, not on an earlier DNS answer", async () => {
    const echo = await echoServer();
    const answers: Record<string, string[]> = { "rebinding.example": ["127.0.0.1"], "mixed.example": ["8.8.8.8", "192.168.1.1"] };
    const proxyPort = await proxy(() => false, async (hostname) => answers[hostname] ?? []);
    expect((await socksConnect(proxyPort, "rebinding.example", echo)).code).toBe(2);
    expect((await socksConnect(proxyPort, "mixed.example", echo)).code).toBe(2);
    expect((await socksConnect(proxyPort, "unknown.example", echo)).code).toBe(4);
  });

  it("only supports CONNECT", async () => {
    const proxyPort = await proxy(() => true);
    expect((await socksConnect(proxyPort, "127.0.0.1", 9, 3)).code).toBe(7);
  });
});
