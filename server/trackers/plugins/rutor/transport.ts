import { challengeDetected, TrackerError } from "../../core/errors.js";
import type { HttpResult } from "../../core/transport/http.js";
import { CookieSession } from "../../core/transport/http.js";
import type { TrackerContext } from "../../core/contracts.js";

export class RutorTransport {
  private readonly sessions = new Map<string, CookieSession>();

  async get(url: string, context: TrackerContext): Promise<HttpResult> {
    const origin = new URL(context.baseUrl).origin;
    let session = this.sessions.get(origin);
    if (!session) {
      session = new CookieSession();
      this.sessions.set(origin, session);
    }
    const result = await session.get(url, context.signal);
    if (challengeDetected(result.body)) {
      throw new TrackerError("challenge", "Rutor returned an interactive verification challenge", { trackerKey: "rutor" });
    }
    if (rutorMissing(result)) {
      throw new TrackerError("missing", "Rutor reports that this torrent no longer exists", {
        trackerKey: "rutor",
        status: result.status,
        url: result.url,
      });
    }
    return result;
  }
}

export function rutorMissing(result: HttpResult): boolean {
  const path = new URL(result.url).pathname.toLocaleLowerCase("en-US");
  return path === "/d.php"
    || /<h1[^>]*>\s*Раздача не существует!\s*<\/h1>/iu.test(result.body)
    || /<title[^>]*>[^<]*Раздача не существует!/iu.test(result.body);
}
