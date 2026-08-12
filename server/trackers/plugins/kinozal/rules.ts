import type { RuleDiscoveryProvider } from "../../core/contracts.js";
import { TrackerError } from "../../core/errors.js";
import type { KinozalSessionManager } from "./auth.js";
import { parseKinozalRecent } from "./parser.js";

export function createKinozalRuleDiscovery(session: KinozalSessionManager): RuleDiscoveryProvider {
  return {
    async discover(context, query) {
      const requiredTerms = query?.requiredTerms.map((term) => term.trim()).filter(Boolean) || [];
      if (requiredTerms.length === 0) {
        throw new TrackerError("unsupported", "Kinozal rule discovery requires at least one search phrase", {
          trackerKey: "kinozal",
        });
      }
      const searchUrl = new URL("/browse.php", context.baseUrl);
      searchUrl.searchParams.set("s", requiredTerms.join(" "));
      searchUrl.searchParams.set("t", "1");
      const result = await session.get(searchUrl.toString(), context);
      return {
        releases: parseKinozalRecent(result.body, context.baseUrl),
        coverage: { source: "search", complete: false },
        sourceUrl: result.url,
      };
    },
  };
}
