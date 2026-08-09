import { createHash } from "node:crypto";
import type { HttpResult } from "../../core/transport/http.js";
import { CookieSession } from "../../core/transport/http.js";
import type { TrackerContext } from "../../core/contracts.js";
import { challengeDetected, TrackerError } from "../../core/errors.js";

interface SessionEntry {
  client: CookieSession;
  credentialKey: string;
}

export class KinozalSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  async get(url: string, context: TrackerContext): Promise<HttpResult> {
    const entry = this.entry(context);
    await this.ensureAuthenticated(entry, context);
    let result = await entry.client.get(url, context.signal);
    this.rejectChallenge(result.body);
    if (!looksLikeLoginPage(result.body)) return result;

    entry.client.clear();
    await this.ensureAuthenticated(entry, context);
    result = await entry.client.get(url, context.signal);
    this.rejectChallenge(result.body);
    if (looksLikeLoginPage(result.body)) {
      throw new TrackerError("authentication", "Kinozal session expired and could not be refreshed", { trackerKey: "kinozal" });
    }
    return result;
  }

  private entry(context: TrackerContext): SessionEntry {
    if (!context.username || !context.password) {
      throw new TrackerError("authentication", "Kinozal credentials are not configured", { trackerKey: "kinozal" });
    }
    const origin = new URL(context.baseUrl).origin;
    const credentialKey = createHash("sha256").update(context.username).update("\0").update(context.password).digest("hex");
    let entry = this.sessions.get(origin);
    if (!entry || entry.credentialKey !== credentialKey) {
      entry = { client: new CookieSession(), credentialKey };
      this.sessions.set(origin, entry);
    }
    return entry;
  }

  private async ensureAuthenticated(entry: SessionEntry, context: TrackerContext): Promise<void> {
    if (entry.client.authenticated) return;
    const result = await entry.client.postForm(new URL("/takelogin.php", context.baseUrl).toString(), {
      username: context.username!,
      password: context.password!,
      returnto: "/",
    }, context.signal);
    this.rejectChallenge(result.body);
    if (/Превышен лимит попыток|Попробуйте через \d+ (?:час|минут)/iu.test(result.body)) {
      throw new TrackerError("rate-limit", "Kinozal temporarily blocked additional login attempts", { trackerKey: "kinozal" });
    }
    if (/Не\s*верно указан пароль|неверн(?:ый|о указан) пароль/iu.test(result.body) || looksLikeLoginPage(result.body)) {
      throw new TrackerError("authentication", "Kinozal authentication failed; verify the configured credentials", { trackerKey: "kinozal" });
    }
    entry.client.authenticated = true;
  }

  private rejectChallenge(body: string): void {
    if (challengeDetected(body) || /g-recaptcha|hcaptcha|captcha-container/iu.test(body)) {
      throw new TrackerError("challenge", "Kinozal returned an interactive verification challenge", { trackerKey: "kinozal" });
    }
  }
}

export function looksLikeLoginPage(body: string): boolean {
  return /<form[^>]+(?:takelogin\.php|name=["']?login)/iu.test(body)
    && /name=["']username["']/iu.test(body)
    && /name=["']password["']/iu.test(body);
}
