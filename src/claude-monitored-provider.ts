import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { claudeProviderMonitorLayer } from "./claude-provider-monitor.ts";
import type { AcquireClaudeSubscriptionUsage } from "./claude-subscription-usage-acquisition.ts";
import {
  defineMonitoredProvider,
  type MonitoredProvider,
} from "./monitored-provider.ts";
import {
  presentProviderSubscriptionUsage,
  type WeeklySubscriptionUsageStatus,
} from "./presentation.ts";

export interface ClaudeMonitoredProviderDependencies {
  readonly acquireClaudeSubscriptionUsage: AcquireClaudeSubscriptionUsage;
  readonly random?: Effect.Effect<number>;
}

interface PiApiKeyAuthentication {
  readonly source?: string;
  readonly auth: { readonly apiKey?: string };
}

function authenticationResolution(
  ctx: ExtensionContext,
): () => Effect.Effect<PiApiKeyAuthentication | undefined, unknown> {
  return () =>
    Effect.tryPromise(() => ctx.modelRegistry.getProviderAuth("anthropic"));
}

export function makeClaudeMonitoredProvider(
  ctx: ExtensionContext,
  dependencies: ClaudeMonitoredProviderDependencies,
): MonitoredProvider {
  return defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
    piProviderId: "anthropic",
    initialStatus: { kind: "loading" },
    makeMonitor: (publish) =>
      claudeProviderMonitorLayer({
        resolveAuthentication: authenticationResolution(ctx),
        acquireClaudeSubscriptionUsage:
          dependencies.acquireClaudeSubscriptionUsage,
        publish,
        ...(dependencies.random === undefined
          ? {}
          : { random: dependencies.random }),
      }),
    present: (status, currentTime) =>
      presentProviderSubscriptionUsage("Claude", status, currentTime),
  });
}
