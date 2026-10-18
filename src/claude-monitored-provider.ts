import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import {
  ClaudeSignInExpired,
  claudeProviderMonitorLayer,
} from "./claude-provider-monitor.ts";
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

/**
 * Pi reports a failed OAuth refresh as ModelsError code "oauth" carrying the
 * token endpoint's reason. RFC 6749 `invalid_grant` means the stored refresh
 * token is expired or revoked, so only signing in again can recover.
 */
function isRejectedOAuthRefresh(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ModelsError" &&
    Reflect.get(error, "code") === "oauth" &&
    /\binvalid_grant\b/.test(error.message)
  );
}

function authenticationResolution(
  ctx: ExtensionContext,
): () => Effect.Effect<PiApiKeyAuthentication | undefined, unknown> {
  return () =>
    Effect.tryPromise({
      try: () => ctx.modelRegistry.getProviderAuth("anthropic"),
      catch: (error) =>
        isRejectedOAuthRefresh(error) ? new ClaudeSignInExpired() : error,
    });
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
