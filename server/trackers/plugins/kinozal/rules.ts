import type { RuleDiscoveryProvider } from "../../core/contracts.js";
import type { KinozalSessionManager } from "./auth.js";
import { parseKinozalRecent } from "./parser.js";

export function createKinozalRuleDiscovery(session: KinozalSessionManager): RuleDiscoveryProvider {
  return {
    async discover(context) {
      const recentUrl = new URL("/browse.php", context.baseUrl);
      recentUrl.searchParams.set("s", "");
      recentUrl.searchParams.set("t", "1");
      const result = await session.get(recentUrl.toString(), context);
      return {
        releases: parseKinozalRecent(result.body, context.baseUrl),
        coverage: { source: "recent-list", complete: false },
      };
    },
  };
}
