import type { Effect } from "effect";

import {
  defineMonitoredProvider,
  type MonitoredProviderRegistration,
} from "./monitored-provider-capacity-session.ts";
import type { AcquireOpenRouterAccountCreditBalance } from "./openrouter-account-credit-balance-acquisition.ts";
import type { ResolveOpenRouterManagementKey } from "./openrouter-management-key-resolution.ts";
import { openRouterProviderMonitorLayer } from "./openrouter-provider-monitor.ts";
import {
  type OpenRouterAccountCreditBalanceStatus,
  presentOpenRouterAccountCreditBalance,
} from "./presentation.ts";

export interface OpenRouterMonitoredProviderDependencies {
  readonly resolveOpenRouterManagementKey: ResolveOpenRouterManagementKey;
  readonly acquireOpenRouterAccountCreditBalance: AcquireOpenRouterAccountCreditBalance;
  readonly random?: Effect.Effect<number>;
}

export function makeOpenRouterMonitoredProviderRegistration(
  dependencies: OpenRouterMonitoredProviderDependencies,
): MonitoredProviderRegistration {
  return defineMonitoredProvider<OpenRouterAccountCreditBalanceStatus>({
    piProviderId: "openrouter",
    makeLayer: (publish) =>
      openRouterProviderMonitorLayer({
        resolveManagementKey: dependencies.resolveOpenRouterManagementKey,
        acquireOpenRouterAccountCreditBalance:
          dependencies.acquireOpenRouterAccountCreditBalance,
        publish,
        ...(dependencies.random === undefined
          ? {}
          : { random: dependencies.random }),
      }),
    present: (status) => presentOpenRouterAccountCreditBalance(status),
  });
}
