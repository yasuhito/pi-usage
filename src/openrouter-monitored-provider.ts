import type { Effect } from "effect";

import {
  defineMonitoredProvider,
  type MonitoredProvider,
} from "./monitored-provider.ts";
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

export function makeOpenRouterMonitoredProvider(
  dependencies: OpenRouterMonitoredProviderDependencies,
): MonitoredProvider {
  return defineMonitoredProvider<OpenRouterAccountCreditBalanceStatus>({
    piProviderId: "openrouter",
    initialStatus: { kind: "loading" },
    makeMonitor: (publish) =>
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
