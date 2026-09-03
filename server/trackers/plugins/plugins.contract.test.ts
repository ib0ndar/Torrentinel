import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackerError } from "../core/errors.js";
import type { BrowserPage } from "../core/transport/browser.js";
import { TrackerPluginRegistry } from "../core/registry.js";
import { KinozalSessionManager } from "./kinozal/auth.js";
import { createKinozalPlugin } from "./kinozal/index.js";
import { parseKinozalSearch } from "./kinozal/parser.js";
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
    const directPage = fixture("kinozal/fixtures/direct.html");
    const recentPage = fixture("kinozal/fixtures/recent.html");
    const loginPage = fixture("kinozal/fixtures/login.html");
    const signedInPage = "<html><a href='/logout.php'>fixture-user</a></html>";
    let authenticated = false;
    let expireDetailSession = true;
    let loginRequests = 0;
    let detailRequests = 0;
    let browseUrl = "";
    const close = vi.fn(async () => undefined);
    const get = vi.fn(async (url: string): Promise<BrowserPage> => {
      if (url === "https://kinozal.tv") {
        return browserPage(authenticated ? signedInPage : loginPage, url);
      }
      if (url.includes("details.php")) {
        detailRequests += 1;
        if (expireDetailSession) {
          expireDetailSession = false;
          authenticated = false;
          return browserPage(loginPage, url);
        }
        return browserPage(directPage, url);
      }
      if (url.includes("browse.php")) {
        browseUrl = url;
        return browserPage(recentPage, url);
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
    });
    const submitForm = vi.fn(async (submission: { values: Record<string, string> }): Promise<BrowserPage> => {
      loginRequests += 1;
      expect(submission.values).toEqual({
        username: "fixture-user",
        password: "fixture-password",
      });
      authenticated = true;
      return browserPage(signedInPage, "https://kinozal.tv/");
    });
    const session = new KinozalSessionManager(() => ({ get, submitForm, close }));
    const plugin = createKinozalPlugin(session);
    await expect(plugin.rules!.discover(
      { baseUrl: "https://kinozal.tv" },
      { requiredTerms: ["film", "2160p"] },
    ))
      .rejects.toMatchObject<Partial<TrackerError>>({ code: "authentication" });

    const context = {
      userId: "fixture-user-id",
      baseUrl: "https://kinozal.tv",
      username: "fixture-user",
      password: "fixture-password",
    };

    const direct = await plugin.direct!.fetchSnapshot("https://kinozal.tv/details.php?id=71", context);
    const batch = await plugin.rules!.discover(context, { requiredTerms: ["Film", "2160p"] });
    await plugin.close?.();

    expect(loginRequests).toBe(2);
    expect(detailRequests).toBe(2);
    expect(close).toHaveBeenCalledOnce();
    expect(direct).toMatchObject({
      externalId: "71",
      title: "Film 2026",
      coverUrl: "https://kinozal.tv/i/poster/71.jpg",
      metadata: { coverObserved: true, changeMarker: "2026-08-07 12:34" },
    });
    expect(new URL(browseUrl).searchParams.get("s")).toBe("Film 2160p");
    expect(new URL(browseUrl).searchParams.get("g")).toBe("0");
    expect(new URL(browseUrl).searchParams.get("t")).toBe("0");
    expect(new URL(browseUrl).searchParams.get("f")).toBe("0");
    expect(batch.coverage).toEqual({ source: "search", complete: false });
    expect(batch.sourceUrl).toBe(browseUrl);
    expect(batch.releases[0]).toMatchObject({ externalId: "71", title: "Film 2026 BDRip" });
  });

  it("backs off browser login after a challenge instead of retrying for every rule", async () => {
    const loginPage = fixture("kinozal/fixtures/login.html");
    let now = Date.parse("2026-09-04T00:00:00Z");
    const get = vi.fn(async (url: string) => browserPage(loginPage, url));
    const submitForm = vi.fn(async () => {
      throw new TrackerError("challenge", "Fixture challenge", { trackerKey: "kinozal" });
    });
    const session = new KinozalSessionManager(
      () => ({ get, submitForm }),
      { now: () => now, retryBackoffMs: 60_000 },
    );
    const plugin = createKinozalPlugin(session);
    const context = {
      userId: "fixture-user-id",
      baseUrl: "https://kinozal.tv",
      username: "fixture-user",
      password: "fixture-password",
    };

    await expect(plugin.direct!.fetchSnapshot("https://kinozal.tv/details.php?id=71", context))
      .rejects.toMatchObject<Partial<TrackerError>>({ code: "challenge" });
    await expect(plugin.rules!.discover(context, { requiredTerms: ["Film"] }))
      .rejects.toMatchObject<Partial<TrackerError>>({ code: "rate-limit" });
    expect(submitForm).toHaveBeenCalledTimes(1);

    now += 60_001;
    await expect(plugin.rules!.discover(context, { requiredTerms: ["Film"] }))
      .rejects.toMatchObject<Partial<TrackerError>>({ code: "challenge" });
    expect(submitForm).toHaveBeenCalledTimes(2);
  });

  it("rejects a catalogue search without required phrases", async () => {
    const plugin = createKinozalPlugin();
    await expect(plugin.rules!.discover(
      { baseUrl: "https://kinozal.tv", username: "fixture-user", password: "fixture-password" },
      { requiredTerms: [] },
    )).rejects.toMatchObject<Partial<TrackerError>>({ code: "unsupported" });
  });

  it("treats an empty search as a successful result and ignores unrelated topic links", () => {
    expect(parseKinozalSearch(`
      <div class="menu"><a href="details.php?id=900">Unrelated menu topic</a></div>
      <p>Найдено 0 раздач</p>
    `, "https://kinozal.me")).toEqual([]);
    expect(parseKinozalSearch(fixture("kinozal/fixtures/recent.html"), "https://kinozal.me"))
      .toHaveLength(1);
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
    expect(batch.releases[0].magnet).toBe("magnet:?xt=urn:btih:FEED88");
    expect(batch.coverage).toMatchObject({ source: "feed", complete: false, oldestObservedAt: "2026-08-08T08:20:00Z" });
    expect(batch.cursor).toBe("2026-08-08T08:30:00Z");
    expect(detailProvider.close).toHaveBeenCalledOnce();
  });
});

function fixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function browserPage(body: string, url: string): BrowserPage {
  return { body, url, status: 200 };
}

function fakeDetailProvider() {
  return {
    get: vi.fn(async (url: string) => ({ body: fixture("rutracker/fixtures/direct.html"), status: 200, url })),
    close: vi.fn(async () => undefined),
  };
}
