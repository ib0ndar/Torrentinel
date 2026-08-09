import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareSolverrClient } from "./core/transport/flaresolverr.js";

afterEach(() => vi.unstubAllGlobals());

describe("FlareSolverr client", () => {
  it("creates one persistent session and reuses it for direct pages", async () => {
    const commands: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      commands.push(command);
      if (command.cmd === "sessions.list") return json({ status: "ok", sessions: [] });
      if (command.cmd === "sessions.create") return json({ status: "ok", session: command.session });
      if (command.cmd === "sessions.destroy") return json({ status: "ok" });
      return json({
        status: "ok",
        message: "Challenge solved!",
        solution: {
          status: 200,
          url: command.url,
          response: `<html><h1 class="maintitle">${command.url}</h1></html>`,
        },
      });
    }));
    const client = new FlareSolverrClient("http://resolver.test/v1", "test-session");

    const first = await client.get("https://rutracker.org/forum/viewtopic.php?t=1");
    const second = await client.get("https://rutracker.org/forum/viewtopic.php?t=2");
    await client.close();

    expect(first.status).toBe(200);
    expect(second.body).toContain("t=2");
    expect(commands.map((command) => command.cmd)).toEqual([
      "sessions.list", "sessions.create", "request.get", "request.get", "sessions.destroy",
    ]);
    expect(commands[2]).toMatchObject({
      session: "test-session",
      session_ttl_minutes: 120,
      disableMedia: true,
    });
  });

  it("rejects an unsolved Cloudflare page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (command.cmd === "sessions.list") return json({ status: "ok", sessions: ["test-session"] });
      return json({
        status: "ok",
        solution: {
          status: 200,
          url: command.url,
          response: "<html><title>Just a moment...</title><div class='cf-chl-widget'></div></html>",
        },
      });
    }));
    const client = new FlareSolverrClient("http://resolver.test/v1", "test-session");

    await expect(client.get("https://rutracker.org/forum/viewtopic.php?t=3"))
      .rejects.toThrow("verification was not completed");
  });

  it("retries one challenged navigation in the same persistent session", async () => {
    let pageRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (command.cmd === "sessions.list") return json({ status: "ok", sessions: ["test-session"] });
      pageRequests += 1;
      return json({
        status: "ok",
        solution: {
          status: 200,
          url: command.url,
          response: pageRequests === 1
            ? "<html><title>Just a moment...</title><div class='cf-chl-widget'></div></html>"
            : "<html><h1 class='maintitle'>Ready</h1></html>",
        },
      });
    }));
    const client = new FlareSolverrClient("http://resolver.test/v1", "test-session");

    const page = await client.get("https://rutracker.org/forum/viewtopic.php?t=4");

    expect(page.body).toContain("Ready");
    expect(pageRequests).toBe(2);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
