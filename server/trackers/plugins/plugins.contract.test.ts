import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackerError } from "../core/errors.js";
import { TrackerPluginRegistry } from "../core/registry.js";
import { createKinozalPlugin } from "./kinozal/index.js";
import { createRutorPlugin } from "./rutor/index.js";
import { rutorMissing } from "./rutor/transport.js";
import { createRutrackerPlugin } from "./rutracker/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("tracker plugin contract", () => {
  it("publishes providers that match every declared capability", () => {
    const plugins = [createKinozalPlugin(), createRutorPlugin(), createRutrackerPlugin(fakeDetailProvider())];
    const registry = new TrackerPluginRegistry(plugins);
    for (const plugin of plugins) {
      expect(Boolean(plugin.direct)).toBe(plugin.manifest.capabilities.direct);
      expect(Boolean(plugin.rules)).toBe(plugin.manifest.capabilities.rules);
      expect(registry.get(plugin.manifest.key)).toBe(plugin);
    }
    expect(registry.forUrl("https://kinozal.me/details.php?id=1")?.manifest.key).toBe("kinozal");
    expect(registry.forUrl("https://rutor.info/torrent/1")?.manifest.key).toBe("rutor");
    expect(registry.forUrl("https://rutracker.net/forum/viewtopic.php?t=1")?.manifest.key).toBe("rutracker");
  });

  it("rejects inconsistent plugin declarations", () => {
    const plugin = createRutorPlugin();
    expect(() => new TrackerPluginRegistry([{ ...plugin, direct: undefined }]))
      .toThrow("direct capability");
  });
});

describe("Kinozal plugin", () => {
  it("requires credentials and refreshes an expired authenticated session", async () => {
    const plugin = createKinozalPlugin();
    await expect(plugin.rules!.discover({ baseUrl: "https://kinozal.tv" }))
      .rejects.toMatchObject<Partial<TrackerError>>({ code: "authentication" });

    const directPage = fixture("kinozal/fixtures/direct.html");
    const recentPage = fixture("kinozal/fixtures/recent.html");
    const loginPage = fixture("kinozal/fixtures/login.html");
    let loginRequests = 0;
    let detailRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("takelogin.php")) {
        loginRequests += 1;
        return new Response("<a href='/userdetails.php?id=1'>fixture-user</a>", {
          status: 200,
          headers: { "set-cookie": `session=${loginRequests}; Path=/` },
        });
      }
      if (url.includes("details.php")) {
        detailRequests += 1;
        return new Response(detailRequests === 1 ? loginPage : directPage, { status: 200 });
      }
      if (url.includes("browse.php")) return new Response(recentPage, { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const context = { baseUrl: "https://kinozal.tv", username: "fixture-user", password: "fixture-password" };

    const direct = await plugin.direct!.fetchSnapshot("https://kinozal.tv/details.php?id=71", context);
    const batch = await plugin.rules!.discover(context);

    expect(loginRequests).toBe(2);
    expect(direct).toMatchObject({
      externalId: "71",
      title: "Film 2026",
      coverUrl: "https://kinozal.tv/i/poster/71.jpg",
      metadata: { coverObserved: true, changeMarker: "2026-08-07 12:34" },
    });
    expect(batch.coverage).toEqual({ source: "recent-list", complete: false });
    expect(batch.releases[0]).toMatchObject({ externalId: "71", title: "Film 2026 BDRip" });
  });
});

describe("Rutor plugin", () => {
  it("recognizes a deleted torrent response even when Rutor returns HTTP 200", () => {
    expect(rutorMissing({
      body: "<html><title>Rutor.info - Раздача не существует!</title><h1>Раздача не существует!</h1></html>",
      status: 200,
      url: "https://rutor.is/d.php",
      headers: new Headers(),
    })).toBe(true);
    expect(rutorMissing({
      body: fixture("rutor/fixtures/direct.html"),
      status: 200,
      url: "https://rutor.is/torrent/472",
      headers: new Headers(),
    })).toBe(false);
  });

  it("parses direct snapshots and recent-list discovery with a stable change marker", async () => {
    const plugin = createRutorPlugin();
    const directPage = fixture("rutor/fixtures/direct.html");
    const recentPage = fixture("rutor/fixtures/recent.html");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => new Response(
      String(input).includes("/torrent/472") ? directPage : recentPage,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    )));

    const direct = await plugin.direct!.fetchSnapshot("https://rutor.is/torrent/472", { baseUrl: "https://rutor.is" });
    const batch = await plugin.rules!.discover({ baseUrl: "https://rutor.is" });

    expect(direct).toMatchObject({
      externalId: "472",
      title: "Technical status",
      coverUrl: "https://img.rutor.test/cover.jpg",
      torrentUrl: "https://d.rutor.info/download/472",
      metadata: { coverObserved: true, changeMarker: "2026-08-07 10:30" },
    });
    expect(batch.coverage).toEqual({ source: "recent-list", complete: false });
    expect(batch.releases[0]).toMatchObject({ externalId: "901", title: "Release One" });
  });
});

describe("RuTracker plugin", () => {
  it("uses a browser detail provider and an independently cached feed provider", async () => {
    const detailProvider = fakeDetailProvider();
    const plugin = createRutrackerPlugin(detailProvider);
    const feed = fixture("rutracker/fixtures/feed.xml");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(feed, {
      status: 200,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    })));
    const context = { baseUrl: "https://rutracker.net" };

    const direct = await plugin.direct!.fetchSnapshot("https://rutracker.org/forum/viewtopic.php?t=999", context);
    const batch = await plugin.rules!.discover(context);
    await plugin.close?.();

    expect(direct).toMatchObject({
      externalId: "999",
      title: "Archived Book Collection",
      coverUrl: "https://img.rutracker.test/cover.jpg",
      metadata: { detailSource: "browser-session", infoHash: "ABC123" },
    });
    expect(batch.releases).toHaveLength(2);
    expect(batch.coverage).toMatchObject({ source: "feed", complete: false, oldestObservedAt: "2026-08-08T08:20:00Z" });
    expect(batch.cursor).toBe("2026-08-08T08:30:00Z");
    expect(detailProvider.close).toHaveBeenCalledOnce();
  });
});

function fixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function fakeDetailProvider() {
  return {
    get: vi.fn(async (url: string) => ({ body: fixture("rutracker/fixtures/direct.html"), status: 200, url })),
    close: vi.fn(async () => undefined),
  };
}
