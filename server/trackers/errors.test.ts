import { describe, expect, it } from "vitest";
import { challengeDetected } from "./core/errors.js";

describe("challenge detection", () => {
  it("detects an active Cloudflare challenge", () => {
    expect(challengeDetected(`
      <html>
        <title>Just a moment...</title>
        <div id="challenge-stage" class="cf-chl-widget"></div>
      </html>
    `)).toBe(true);
  });

  it("does not reject a loaded RuTracker page that retains the Cloudflare script URL", () => {
    expect(challengeDetected(`
      <html>
        <head><title>rutracker.org</title></head>
        <body>
          <form id="login-form-full"><input name="login_username"></form>
          <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
        </body>
      </html>
    `)).toBe(false);
  });
});
