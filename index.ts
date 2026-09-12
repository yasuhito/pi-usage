import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { createAcquireClaudeSubscriptionUsage } from "./src/claude-subscription-usage-acquisition.ts";
import { createAcquireDedicatedWeeklyQuotaUsage } from "./src/dedicated-weekly-quota-acquisition.ts";
import { registerWeeklySubscriptionUsage } from "./src/register.ts";

export default function piUsage(pi: ExtensionAPI): void {
  registerWeeklySubscriptionUsage(pi, {
    acquireDedicatedWeeklyQuotaUsage: createAcquireDedicatedWeeklyQuotaUsage({
      fetch,
    }),
    acquireClaudeSubscriptionUsage: (ctx) =>
      createAcquireClaudeSubscriptionUsage({
        fetch,
        resolveAuthentication: Effect.tryPromise(() =>
          ctx.modelRegistry.getProviderAuth("anthropic"),
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
      }),
  });
}
