import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAcquireClaudeSubscriptionUsage } from "./src/claude-subscription-usage-acquisition.ts";
import { createAcquireDedicatedWeeklyQuotaUsage } from "./src/dedicated-weekly-quota-acquisition.ts";
import { createAcquireOpenRouterAccountCreditBalance } from "./src/openrouter-account-credit-balance-acquisition.ts";
import { createResolveOpenRouterManagementKey } from "./src/openrouter-management-key-resolution.ts";
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
    resolveOpenRouterManagementKey: createResolveOpenRouterManagementKey(),
    acquireOpenRouterAccountCreditBalance:
      createAcquireOpenRouterAccountCreditBalance({ fetch }),
    acquireClaudeSubscriptionUsage: (ctx) =>
      createAcquireClaudeSubscriptionUsage({
        fetch,
        acquisitionCoordinator,
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
