import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeClaudeMonitoredProvider } from "./src/claude-monitored-provider.ts";
import { createAcquireClaudeSubscriptionUsage } from "./src/claude-subscription-usage-acquisition.ts";
import { makeCodexMonitoredProvider } from "./src/codex-monitored-provider.ts";
import { createAcquireDedicatedWeeklyQuotaUsage } from "./src/dedicated-weekly-quota-acquisition.ts";
import { createAcquireOpenRouterAccountCreditBalance } from "./src/openrouter-account-credit-balance-acquisition.ts";
import { createResolveOpenRouterManagementKey } from "./src/openrouter-management-key-resolution.ts";
import { makeOpenRouterMonitoredProvider } from "./src/openrouter-monitored-provider.ts";
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
  const acquireDedicatedWeeklyQuotaUsage =
    createAcquireDedicatedWeeklyQuotaUsage({ fetch });
  const resolveOpenRouterManagementKey = createResolveOpenRouterManagementKey();
  const acquireOpenRouterAccountCreditBalance =
    createAcquireOpenRouterAccountCreditBalance({ fetch });

  registerMonitoredProviderCapacity(pi, {
    providers: [
      (ctx) =>
        makeCodexMonitoredProvider(ctx, {
          acquireDedicatedWeeklyQuotaUsage,
        }),
      (ctx) =>
        makeClaudeMonitoredProvider(ctx, {
          acquireClaudeSubscriptionUsage: createAcquireClaudeSubscriptionUsage({
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
        }),
      () =>
        makeOpenRouterMonitoredProvider({
          resolveOpenRouterManagementKey,
          acquireOpenRouterAccountCreditBalance,
        }),
    ],
  });
}
