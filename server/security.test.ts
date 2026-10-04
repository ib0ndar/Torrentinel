import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "./app.js";
import { AttemptLimiter } from "./attempt-limiter.js";
import { fetchCover } from "./cover-fetch.js";
import { createDatabase } from "./db.js";
import { effectiveBaseUrl, personalMirrorAllowed } from "./mirrors.js";
import { Scheduler } from "./scheduler.js";
import { SecretVault } from "./secrets.js";
import type { TelegramService } from "./telegram.js";
import { fingerprintRelease } from "./trackers/core/parsing.js";
import { trackerRegistry } from "./trackers/index.js";
import { parseRutorDirect } from "./trackers/plugins/rutor/parser.js";

// Password hashing dominates these tests; emulated container builds run them many times slower.
const PASSWORD_HASHING_TIMEOUT_MS = 300_000;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function application() {
  const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-security-"));
  const created = await createApplication({
    databasePath: join(dataDir, "test.db"),
    encryptionKeyPath: join(dataDir, "master.key"),
    logger: false,
    staticAssets: false,
  });
  cleanup.push(async () => { await created.app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return created;
}

function sessionCookie(header: string | string[] | undefined): string {
  return (Array.isArray(header) ? header : [header ?? ""]).find((value) => value.startsWith("torrentinel_session="))!.split(";", 1)[0];
}

async function readyAdmin(app: Awaited<ReturnType<typeof application>>["app"]): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  const cookie = sessionCookie(login.headers["set-cookie"]);
  await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword: "admin", newPassword: "Admin-Security-2026!" } });
  return cookie;
}

async function readyUser(app: Awaited<ReturnType<typeof application>>["app"], adminCookie: string, username: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: adminCookie }, payload: { username, password: "initial-password" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "initial-password" } });
  const cookie = sessionCookie(login.headers["set-cookie"]);
  await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword: "initial-password", newPassword: "changed-password" } });
  return cookie;
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as { port: number }).port };
}

describe("personal tracker mirrors", () => {
  it("only allow the tracker's own domains or the global mirror", () => {
    expect(personalMirrorAllowed("rutracker", "https://rutracker.net", "https://rutracker.org")).toBe(true);
    expect(personalMirrorAllowed("rutracker", "https://www.rutracker.org", "https://rutracker.org")).toBe(true);
    expect(personalMirrorAllowed("kinozal", "http://192.168.1.5:8080", "http://192.168.1.5:8080")).toBe(true);
    expect(personalMirrorAllowed("rutracker", "http://127.0.0.1:8080", "https://rutracker.org")).toBe(false);
    expect(personalMirrorAllowed("rutracker", "https://rutracker.org:2222", "https://rutracker.org")).toBe(false);
    expect(personalMirrorAllowed("rutracker", "https://rutracker.org.evil.example", "https://rutracker.org")).toBe(false);
    expect(personalMirrorAllowed("rutor", "https://kinozal.tv", "https://rutor.is")).toBe(false);
    expect(effectiveBaseUrl("rutor", "http://10.0.0.1", "https://rutor.is")).toBe("https://rutor.is");
    expect(effectiveBaseUrl("rutor", "https://rutor.info", "https://rutor.is")).toBe("https://rutor.info");
  });

  it("are rejected through the API and ignored when an older stored value is no longer allowed", async () => {
    const { app, db } = await application();
    const adminCookie = await readyAdmin(app);
    const userCookie = await readyUser(app, adminCookie, "member");

    for (const [url, payload] of [
      ["/api/trackers/rutor/mirror", { baseUrl: "http://127.0.0.1:9000" }],
      ["/api/trackers/rutor/settings", { baseUrl: "http://169.254.169.254" }],
    ] as const) {
      const response = await app.inject({ method: "PUT", url, headers: { cookie: userCookie }, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Personal mirrors are limited to the tracker's own domains and the global mirror");
    }
    const allowed = await app.inject({ method: "PUT", url: "/api/trackers/rutor/mirror", headers: { cookie: userCookie }, payload: { baseUrl: "https://rutor.info" } });
    expect(allowed.statusCode).toBe(200);

    const user = db.prepare("SELECT id FROM users WHERE username = 'member'").get() as { id: string };
    db.prepare("UPDATE user_tracker_mirrors SET base_url = 'http://127.0.0.1:9000' WHERE user_id = ?").run(user.id);
    const trackers = (await app.inject({ method: "GET", url: "/api/trackers", headers: { cookie: userCookie } })).json().trackers as Array<{ key: string; baseUrl: string; hasOverride: boolean }>;
    expect(trackers.find((tracker) => tracker.key === "rutor")).toMatchObject({ baseUrl: "https://rutor.is", hasOverride: false });
  }, PASSWORD_HASHING_TIMEOUT_MS);
});

describe("scheduler isolation", () => {
  function directFixture() {
    const db = createDatabase(":memory:");
    const timestamp = new Date().toISOString();
    const insertUser = (id: string, disabled: number) => {
      db.prepare(`INSERT INTO users (id, username, password_hash, is_admin, disabled, created_at, updated_at) VALUES (?, ?, 'x', 0, ?, ?, ?)`)
        .run(id, id, disabled, timestamp, timestamp);
      db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Inbox', ?, ?)").run(`${id}-inbox`, id, timestamp, timestamp);
      db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, required_terms, ignored_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'direct', '', 'https://rutor.is/torrent/1', '[]', '[]', ?, ?)`).run(`${id}-sub`, id, `${id}-inbox`, timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutor')").run(`${id}-sub`);
    };
    insertUser("active-user", 0);
    insertUser("disabled-user", 1);
    db.prepare("INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at) VALUES ('active-user', 'rutor', 'http://127.0.0.1:9000', ?)").run(timestamp);
    const plugin = trackerRegistry.get("rutor")!;
    const fetchSnapshot = vi.spyOn(plugin.direct!, "fetchSnapshot").mockImplementation(async (url) => {
      const release = { trackerKey: "rutor" as const, externalId: "1", title: "Release", url };
      return { ...release, fingerprint: fingerprintRelease(release) };
    });
    const telegram = { canNotify: () => false, notifyRelease: vi.fn() } as unknown as TelegramService;
    return { db, fetchSnapshot, scheduler: new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 3))) };
  }

  it("skips disabled accounts and never uses a disallowed stored mirror", async () => {
    const { fetchSnapshot, scheduler } = directFixture();
    await scheduler.run("test");
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(fetchSnapshot.mock.calls[0][1]).toMatchObject({ userId: "active-user", baseUrl: "https://rutor.is" });
    await scheduler.stop();
  });
});

describe("sign-in throttling", () => {
  it("limits repeated failures per account and address, and rejects unknown accounts the same way", async () => {
    const { app } = await application();
    await readyAdmin(app);
    const unknown = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "nobody", password: "guess" } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe("Invalid username or password");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: `wrong-${attempt}` } });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "Admin-Security-2026!" } });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json().error).toBe("Too many sign-in attempts. Try again later.");

    const fromElsewhere = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.7", payload: { username: "admin", password: "Admin-Security-2026!" } });
    expect(fromElsewhere.statusCode).toBe(200);
  }, PASSWORD_HASHING_TIMEOUT_MS);

  it("limits current-password guesses on the password change form", async () => {
    const { app } = await application();
    const cookie = await readyAdmin(app);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword: `wrong-${attempt}`, newPassword: "Another-Password-1" } });
      expect(response.statusCode).toBe(400);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword: "Admin-Security-2026!", newPassword: "Another-Password-1" } });
    expect(blocked.statusCode).toBe(429);
  }, PASSWORD_HASHING_TIMEOUT_MS);

  it("forgets failures once the window has passed", () => {
    let now = 0;
    const limiter = new AttemptLimiter(1_000, () => now);
    const rules = [{ key: "account", limit: 2 }];
    limiter.recordFailure(rules);
    limiter.recordFailure(rules);
    expect(limiter.retryAfterMs(rules)).toBe(1_000);
    now = 999;
    expect(limiter.retryAfterMs(rules)).toBe(1);
    now = 1_000;
    expect(limiter.retryAfterMs(rules)).toBe(0);
  });
});

describe("cross-site request protection", () => {
  it("rejects state-changing requests from other sites and accepts same-origin ones", async () => {
    const { app } = await application();
    const login = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { username: "admin", password: "admin" } });
    expect((await login({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await login({ "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await login({ origin: "https://evil.example", host: "torrentinel.example" })).statusCode).toBe(403);
    expect((await login({ origin: "null", host: "torrentinel.example" })).statusCode).toBe(403);
    expect((await login({ "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await login({ origin: "https://torrentinel.example", host: "torrentinel.example" })).statusCode).toBe(200);
    expect((await login({ origin: "https://torrentinel.example", host: "127.0.0.1:8080", "x-forwarded-host": "torrentinel.example" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(200);
  }, PASSWORD_HASHING_TIMEOUT_MS);
});

describe("cover downloads", () => {
  it("refuse local addresses unless they belong to the release page's own host", async () => {
    const hits: string[] = [];
    const { port } = await listen((request, response) => {
      hits.push(request.url || "");
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://localhost:${port}/cover.png` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end("png");
    });
    const init = () => ({ headers: {}, signal: AbortSignal.timeout(5_000) });

    await expect(fetchCover(`http://127.0.0.1:${port}/cover.png`, init())).rejects.toThrow("not a public internet address");
    const trusted = await fetchCover(`http://127.0.0.1:${port}/cover.png`, { ...init(), trustedHostname: "127.0.0.1" });
    expect(trusted.status).toBe(200);
    await expect(fetchCover(`http://127.0.0.1:${port}/redirect`, { ...init(), trustedHostname: "127.0.0.1" })).rejects.toThrow();
    expect(hits).toEqual(["/cover.png", "/redirect"]);
  });
});

describe("scraped links", () => {
  it("keep only HTTP(S) download links and real magnet links", () => {
    const release = parseRutorDirect(`<html><h1>Release</h1>
      <a href="magnet:javascript:alert(1)">bad magnet</a>
      <a href="javascript:alert(document.domain)//download/">torrent</a></html>`, "https://rutor.is/torrent/1");
    expect(release.magnet).toBeUndefined();
    expect(release.torrentUrl).toBeUndefined();
    const valid = parseRutorDirect(`<html><h1>Release</h1>
      <a href="magnet:?xt=urn:btih:${"A".repeat(40)}">magnet</a><a href="/download/1">torrent</a></html>`, "https://rutor.is/torrent/1");
    expect(valid.magnet).toBe(`magnet:?xt=urn:btih:${"A".repeat(40)}`);
    expect(valid.torrentUrl).toBe("https://rutor.is/download/1");
  });
});
