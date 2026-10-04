import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication, hostAllowed } from "./app.js";
import { config } from "./config.js";
import { INITIAL_ADMIN_PASSWORD_FILE } from "./initial-admin.js";

// Password hashing dominates these tests; emulated container builds run them many times slower.
const PASSWORD_HASHING_TIMEOUT_MS = 300_000;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "torrentinel-initial-admin-"));
  directories.push(directory);
  return directory;
}

async function open(directory: string, initialAdminPassword?: string) {
  return createApplication({ databasePath: join(directory, "test.db"), encryptionKeyPath: join(directory, "master.key"), logger: false, staticAssets: false, initialAdminPassword });
}

type App = Awaited<ReturnType<typeof open>>["app"];
const login = (app: App, password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password } });
const cookieOf = (header: string | string[] | undefined) => (Array.isArray(header) ? header : [header ?? ""]).find((value) => value.startsWith("torrentinel_session="))!.split(";", 1)[0];

describe("first-run administrator password", () => {
  it("is generated, kept private until it is changed, and never admin/admin", async () => {
    const directory = dataDirectory(), file = join(directory, INITIAL_ADMIN_PASSWORD_FILE);
    let { app } = await open(directory);
    expect((await login(app, "admin")).statusCode).toBe(401);
    const password = readFileSync(file, "utf8").trim();
    expect(password).toMatch(/^[2-9a-zA-Z]{5}(-[2-9a-zA-Z]{5}){4}$/u);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await app.close();

    // A restart before the first sign-in keeps the same password.
    ({ app } = await open(directory));
    expect(readFileSync(file, "utf8").trim()).toBe(password);
    const signedIn = await login(app, password);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().user).toMatchObject({ mustChangePassword: true, passwordChangeReason: "initial" });
    const changed = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie: cookieOf(signedIn.headers["set-cookie"]) },
      payload: { currentPassword: password, newPassword: "Chosen-Password-2026" } });
    expect(changed.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    await app.close();

    ({ app } = await open(directory));
    expect(existsSync(file)).toBe(false);
    expect((await login(app, "Chosen-Password-2026")).statusCode).toBe(200);
    await app.close();
  }, PASSWORD_HASHING_TIMEOUT_MS);

  it("uses INITIAL_ADMIN_PASSWORD when the operator sets one", async () => {
    const directory = dataDirectory();
    const { app } = await open(directory, "Operator-Chosen-1");
    expect(existsSync(join(directory, INITIAL_ADMIN_PASSWORD_FILE))).toBe(false);
    expect((await login(app, "Operator-Chosen-1")).statusCode).toBe(200);
    await app.close();
  }, PASSWORD_HASHING_TIMEOUT_MS);

  it("replaces admin/admin on installations that were never set up and ends sessions that used it", async () => {
    const directory = dataDirectory();
    let { app } = await open(directory, "admin");
    const legacySession = cookieOf((await login(app, "admin")).headers["set-cookie"]);
    await app.close();

    ({ app } = await open(directory));
    expect((await login(app, "admin")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: legacySession } })).statusCode).toBe(401);
    const password = readFileSync(join(directory, INITIAL_ADMIN_PASSWORD_FILE), "utf8").trim();
    expect((await login(app, password)).statusCode).toBe(200);
    await app.close();
  }, PASSWORD_HASHING_TIMEOUT_MS);
});

describe("host name check", () => {
  it("serves addresses and local names, and refuses other domains unless configured", async () => {
    for (const host of ["127.0.0.1:8080", "192.168.0.250:8999", "[::1]:8080", "localhost:5173", "nas:8999", "nas.", "torrentinel.lan", "media.home.arpa", "box.local", undefined]) {
      expect(hostAllowed(host), String(host)).toBe(true);
    }
    for (const host of ["evil.example", "evil.example:8999", "rebind.attacker.com", "evil.example@127.0.0.1", "torrentinel.example.com", ""]) {
      expect(hostAllowed(host), host).toBe(false);
    }
    const saved = [...config.allowedHosts];
    config.allowedHosts.push("torrentinel.example.com", ".example.org");
    try {
      expect(hostAllowed("torrentinel.example.com")).toBe(true);
      expect(hostAllowed("TORRENTINEL.example.com:443")).toBe(true);
      expect(hostAllowed("media.example.org")).toBe(true);
      expect(hostAllowed("example.org")).toBe(true);
      expect(hostAllowed("example.org.evil.example")).toBe(false);
    } finally {
      config.allowedHosts.splice(0, config.allowedHosts.length, ...saved);
    }
  });

  it("refuses requests addressed to an unknown domain before anything else runs", async () => {
    const directory = dataDirectory();
    const { app } = await open(directory, "Operator-Chosen-1");
    const rebound = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "rebind.attacker.com" }, payload: { username: "admin", password: "Operator-Chosen-1" } });
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json().error).toBe("Torrentinel does not serve this host name. Add it to ALLOWED_HOSTS or PUBLIC_URL.");
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "rebind.attacker.com" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "192.168.0.250:8999" } })).statusCode).toBe(200);
    await app.close();
  }, PASSWORD_HASHING_TIMEOUT_MS);
});
