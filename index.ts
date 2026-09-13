import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { createAcquireClaudeSubscriptionUsage } from "./src/claude-subscription-usage-acquisition.ts";
import { createAcquireDedicatedWeeklyQuotaUsage } from "./src/dedicated-weekly-quota-acquisition.ts";
import { createFileProviderAcquisitionCoordinator } from "./src/provider-acquisition-coordinator.ts";
import { registerMonitoredProviderCapacity } from "./src/register.ts";

const COORDINATION_WARNING_SHOWN = Symbol.for(
  "@yasuhito/pi-usage/coordination-warning-shown",
);

function showCoordinationWarningOnce(notify: () => void): void {
  const processState = globalThis as typeof globalThis & {
    [COORDINATION_WARNING_SHOWN]?: boolean;
  };
  if (processState[COORDINATION_WARNING_SHOWN] === true) return;
  processState[COORDINATION_WARNING_SHOWN] = true;
  notify();
}

export default function piUsage(pi: ExtensionAPI): void {
  const acquisitionCoordinator = createFileProviderAcquisitionCoordinator();
  registerMonitoredProviderCapacity(pi, {
    acquireDedicatedWeeklyQuotaUsage: createAcquireDedicatedWeeklyQuotaUsage({
      fetch,
    }),
    acquireClaudeSubscriptionUsage: (ctx) =>
      createAcquireClaudeSubscriptionUsage({
        fetch,
        acquisitionCoordinator,
        resolveAuthentication: Effect.tryPromise(() =>
          ctx.modelRegistry.getProviderAuth("anthropic"),
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
        onCoordinationUnavailable: () =>
          showCoordinationWarningOnce(() =>
            ctx.ui.notify(
              "Claude usage unavailable: secure Linux XDG_RUNTIME_DIR required",
              "warning",
            ),
          ),
      }),
  });
}
