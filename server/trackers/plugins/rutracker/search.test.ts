import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../../core/transport/flaresolverr.js";
import type { HttpResult } from "../../core/transport/http.js";
import {
  RutrackerSearchRecovery,
  type RutrackerClearanceProvider,
  type RutrackerHttpSession,
} from "./search.js";

describe("RuTracker authenticated search recovery", () => {
  it("logs in, follows pagination, and stops after crossing the recovery boundary", async () => {
    const login: BrowserPage = {
      body: '<form id="login-form-full"></form>',
      status: 200,
      url: "https://rutracker.org/forum/login.php",
      cookies: [{ name: "cf_clearance", value: "clearance" }],
      userAgent: "Validated browser agent",
    };
    const first = searchPage([
      ["301", "Needle newest", 1_788_174_600],
      ["300", "Needle current", 1_788_174_000],
    ], '<a href="tracker.php?search_id=token&amp;start=50&amp;nm=needle">2</a>');
    const second = searchPage([
      ["299", "Needle older", 1_788_170_000],
    ]);
    const clearance: RutrackerClearanceProvider = {
      get: vi.fn().mockResolvedValue(login),
      close: vi.fn(async () => undefined),
    };
    const http: RutrackerHttpSession = {
      clear: vi.fn(),
      seedCookies: vi.fn(),
      get: vi.fn().mockResolvedValueOnce(second),
      postForm: vi.fn().mockResolvedValueOnce(first),
    };
    const recovery = new RutrackerSearchRecovery(() => clearance, () => http);

    const result = await recovery.recover({
      userId: "user-1",
      baseUrl: "https://rutracker.org",
      username: "stored-user",
      password: "stored-password",
    }, { requiredTerms: ["needle"] }, "2026-08-31T10:30:00.000Z");

    expect(result.coverage.complete).toBe(true);
    expect(result.releases.map((release) => release.externalId)).toEqual(["301", "300"]);
    expect(clearance.get).toHaveBeenCalledWith("https://rutracker.org/forum/login.php", undefined);
    expect(http.seedCookies).toHaveBeenCalledWith(
      [{ name: "cf_clearance", value: "clearance" }],
      "Validated browser agent",
    );
    expect(http.postForm).toHaveBeenCalledWith(
      "https://rutracker.org/forum/login.php",
      expect.objectContaining({ login_username: "stored-user", login_password: "stored-password" }),
      undefined,
      { origin: "https://rutracker.org", referer: "https://rutracker.org/forum/login.php" },
    );
    expect(http.get).toHaveBeenCalledWith(
      "https://rutracker.org/forum/tracker.php?search_id=token&start=50&nm=needle",
      undefined,
    );
    await recovery.close();
    expect(clearance.close).toHaveBeenCalledOnce();
  });
});

function searchPage(rows: Array<[string, string, number]>, pagination = ""): HttpResult {
  return {
    status: 200,
    headers: new Headers(),
    url: "https://rutracker.org/forum/tracker.php?nm=needle&o=1&s=2",
    body: `<table id="tor-tbl"><tbody>${rows.map(([id, title, timestamp]) => `
      <tr class="tCenter hl-tr">
        <td id="${id}" class="row1 t-ico"></td>
        <td class="row1 t-ico"></td>
        <td class="row1 f-name-col">Test forum</td>
        <td class="row4 med tLeft t-title-col"><a href="viewtopic.php?t=${id}">${title}</a></td>
        <td></td><td></td><td></td><td></td><td></td>
        <td data-ts_text="${timestamp}">31-Aug-26</td>
      </tr>`).join("")}</tbody></table>${pagination}`,
  };
}
