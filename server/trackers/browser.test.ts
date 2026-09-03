import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Response } from "patchright";
import { IntegratedBrowserClient } from "./core/transport/browser.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("integrated browser client", () => {
  it("creates one isolated profile and reuses its browser session", async () => {
    const fixture = fakeBrowser([
      ["<html><h1 class='maintitle'>First</h1></html>"],
      ["<html><h1 class='maintitle'>Second</h1></html>"],
    ]);
    const root = await tempDirectory();
    const launch = vi.fn(async () => fixture.context);
    const client = new IntegratedBrowserClient("test-session", {
      launchContext: launch,
      profileRoot: root,
      timeoutMs: 50,
    });

    const first = await client.get("https://rutracker.org/forum/viewtopic.php?t=1");
    const second = await client.get("https://rutracker.org/forum/viewtopic.php?t=2");
    await client.close();

    expect(first).toMatchObject({
      status: 200,
      cookies: [{ name: "cf_clearance", value: "fixture" }],
      userAgent: "Fixture browser agent",
    });
    expect(second.body).toContain("Second");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fixture.goto).toHaveBeenCalledTimes(2);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("removes stale Chrome profile locks after a container restart", async () => {
    const fixture = fakeBrowser([["<html><h1 class='maintitle'>Ready</h1></html>"]]);
    const root = await tempDirectory();
    const sessionId = "stale-profile-session";
    const profile = profileDirectory(root, sessionId);
    await mkdir(profile, { recursive: true });
    await symlink("old-container-123", join(profile, "SingletonLock"));
    await symlink("old-cookie", join(profile, "SingletonCookie"));
    await symlink(join(root, "missing-singleton.sock"), join(profile, "SingletonSocket"));
    const launch = vi.fn(async (directory: string) => {
      expect(directory).toBe(profile);
      await expect(lstat(join(profile, "SingletonLock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(profile, "SingletonCookie"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(profile, "SingletonSocket"))).rejects.toMatchObject({ code: "ENOENT" });
      return fixture.context;
    });
    const client = new IntegratedBrowserClient(sessionId, {
      launchContext: launch,
      profileRoot: root,
      timeoutMs: 50,
    });

    await expect(client.get("https://rutracker.org/forum/viewtopic.php?t=6"))
      .resolves.toMatchObject({ status: 200 });
    await client.close();

    expect(launch).toHaveBeenCalledOnce();
  });

  it("does not remove profile locks whose Chrome socket is still present", async () => {
    const root = await tempDirectory();
    const sessionId = "active-profile-session";
    const profile = profileDirectory(root, sessionId);
    const activeSocket = join(root, "active-singleton.sock");
    await mkdir(profile, { recursive: true });
    await writeFile(activeSocket, "active");
    await symlink("current-container-456", join(profile, "SingletonLock"));
    await symlink(activeSocket, join(profile, "SingletonSocket"));
    const launch = vi.fn();
    const client = new IntegratedBrowserClient(sessionId, {
      launchContext: launch,
      profileRoot: root,
      timeoutMs: 50,
    });

    await expect(client.get("https://rutracker.org/forum/viewtopic.php?t=7"))
      .rejects.toThrow("profile is already in use by an active Chrome process");

    expect(launch).not.toHaveBeenCalled();
    await expect(lstat(join(profile, "SingletonLock"))).resolves.toBeDefined();
    await client.close();
  });

  it("waits for a challenged navigation to clear in the same session", async () => {
    const fixture = fakeBrowser([[
      "<html><title>Just a moment...</title><div class='cf-chl-widget'></div></html>",
      "<html><h1 class='maintitle'>Ready</h1></html>",
    ],
    ]);
    const client = new IntegratedBrowserClient("challenge-session", {
      launchContext: async () => fixture.context,
      profileRoot: await tempDirectory(),
      timeoutMs: 30,
    });

    const page = await client.get("https://rutracker.org/forum/viewtopic.php?t=3");
    await client.close();

    expect(page.body).toContain("Ready");
    expect(fixture.goto).toHaveBeenCalledOnce();
  });

  it("submits an existing browser form and retains its resulting session", async () => {
    const fixture = fakeBrowser([
      ["<html><form action='/takelogin.php'><input name='username'><input name='password'><input name='returnto'></form></html>"],
      ["<html><a href='/logout.php'>Signed in</a></html>"],
    ]);
    const client = new IntegratedBrowserClient("form-session", {
      launchContext: async () => fixture.context,
      profileRoot: await tempDirectory(),
      timeoutMs: 100,
      trackerKey: "kinozal",
      trackerName: "Kinozal",
    });

    const result = await client.submitForm({
      pageUrl: "https://kinozal.me/",
      formSelector: 'form[action*="takelogin.php"]',
      values: {
        username: "fixture-user",
        password: "fixture-password",
      },
    });
    await client.close();

    expect(result).toMatchObject({ status: 200, url: "https://kinozal.me/" });
    expect(result.body).toContain("Signed in");
    expect(fixture.filledFields).toEqual({
      username: "fixture-user",
      password: "fixture-password",
    });
    expect(fixture.clickSubmit).toHaveBeenCalledOnce();
  });

  it("retries page reads while a challenge redirect is still navigating", async () => {
    const fixture = fakeBrowser([[
      new Error("page.content: Unable to retrieve content because the page is navigating and changing the content."),
      "<html><h1 class='maintitle'>Ready after redirect</h1></html>",
    ]]);
    const client = new IntegratedBrowserClient("redirect-session", {
      launchContext: async () => fixture.context,
      profileRoot: await tempDirectory(),
      timeoutMs: 200,
    });

    const page = await client.get("https://rutracker.org/forum/viewtopic.php?t=5");
    await client.close();

    expect(page.body).toContain("Ready after redirect");
    expect(fixture.content).toHaveBeenCalledTimes(3);
  });

  it("rejects a challenge that remains until the browser deadline", async () => {
    const challenged = "<html><title>Just a moment...</title><div class='cf-chl-widget'></div></html>";
    const fixture = fakeBrowser([[challenged]]);
    const client = new IntegratedBrowserClient("blocked-session", {
      launchContext: async () => fixture.context,
      profileRoot: await tempDirectory(),
      timeoutMs: 10,
    });

    await expect(client.get("https://rutracker.org/forum/viewtopic.php?t=4"))
      .rejects.toThrow("verification was not completed");
    await client.close();
  });
});

function fakeBrowser(navigations: Array<Array<string | Error>>) {
  let navigationIndex = -1;
  const bodyIndexes = navigations.map(() => 0);
  let currentUrl = "about:blank";
  let responseObserver: ((response: Response) => void) | undefined;
  const mainFrame = {};
  const goto = vi.fn(async (url: string) => {
    navigationIndex += 1;
    currentUrl = url;
    responseObserver?.({
      frame: () => mainFrame,
      request: () => ({ resourceType: () => "document" }),
      status: () => 200,
    } as unknown as Response);
    return null;
  });
  const filledFields: Record<string, string> = {};
  const fieldLocator = (selector: string) => {
    const name = selector.match(/^\[name="(.+)"\]$/u)?.[1] || selector;
    const locator = {
      first: () => locator,
      count: vi.fn(async () => 1),
      fill: vi.fn(async (value: string) => { filledFields[name] = value; }),
    };
    return locator;
  };
  const clickSubmit = vi.fn(async () => {
    navigationIndex += 1;
    currentUrl = "https://kinozal.me/";
    responseObserver?.({
      frame: () => mainFrame,
      request: () => ({ resourceType: () => "document" }),
      status: () => 200,
    } as unknown as Response);
  });
  const submitLocator = {
    first: () => submitLocator,
    count: vi.fn(async () => 1),
    click: clickSubmit,
  };
  const formLocator = {
    first: () => formLocator,
    count: vi.fn(async () => 1),
    locator: vi.fn((selector: string) => (
      selector.includes('input[type="submit"]') ? submitLocator : fieldLocator(selector)
    )),
  };
  const page = {
    setDefaultTimeout: vi.fn(),
    mainFrame: () => mainFrame,
    on: vi.fn((_event: string, observer: (response: Response) => void) => { responseObserver = observer; }),
    off: vi.fn(() => { responseObserver = undefined; }),
    goto,
    content: vi.fn(async () => {
      const navigation = navigations[Math.min(Math.max(navigationIndex, 0), navigations.length - 1)];
      const index = bodyIndexes[Math.min(Math.max(navigationIndex, 0), bodyIndexes.length - 1)]++;
      const result = navigation[Math.min(index, navigation.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    }),
    url: () => currentUrl,
    evaluate: vi.fn(async () => "Fixture browser agent"),
    locator: vi.fn(() => formLocator),
    isClosed: () => false,
    frames: () => [],
    mouse: { move: vi.fn(), down: vi.fn(), up: vi.fn() },
    waitForNavigation: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  const close = vi.fn(async () => undefined);
  const context = {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    cookies: vi.fn(async () => [{ name: "cf_clearance", value: "fixture" }]),
    close,
  } as unknown as BrowserContext;
  return { context, goto, content: page.content, close, filledFields, clickSubmit };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "torrentinel-browser-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function profileDirectory(root: string, sessionId: string): string {
  return join(root, createHash("sha256").update(sessionId).digest("hex").slice(0, 24));
}
