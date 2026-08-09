import type { RuleDiscoveryProvider } from "../../core/contracts.js";
import { parseRutorRecent } from "./parser.js";
import type { RutorTransport } from "./transport.js";

export function createRutorRuleDiscovery(transport: RutorTransport): RuleDiscoveryProvider {
  return {
    async discover(context) {
      const result = await transport.get(new URL("/", context.baseUrl).toString(), context);
      return {
        releases: parseRutorRecent(result.body, context.baseUrl),
        coverage: { source: "recent-list", complete: false },
      };
    },
  };
}
