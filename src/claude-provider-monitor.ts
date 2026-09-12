import { Context, Effect, Layer, type Scope } from "effect";
import type {
  AcquireClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import {
  type CodexProviderMonitorDependencies,
  makeCodexProviderMonitor,
} from "./codex-provider-monitor.ts";
import {
  MalformedAcquisition,
  PermanentAcquisitionFailure,
  TemporaryAcquisitionFailure,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import type { ProviderMonitor } from "./provider-monitor.ts";

export class ClaudeProviderMonitorService extends Context.Tag(
  "ClaudeProviderMonitor",
)<ClaudeProviderMonitorService, ProviderMonitor>() {}

export interface ClaudeProviderMonitorDependencies {
  readonly acquireClaudeSubscriptionUsage: AcquireClaudeSubscriptionUsage;
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

function acquisitionFailure(
  error: ClaudeSubscriptionUsageAcquisitionError,
):
  | TemporaryAcquisitionFailure
  | PermanentAcquisitionFailure
  | MalformedAcquisition {
  switch (error._tag) {
    case "TemporaryClaudeSubscriptionUsageFailure":
      return new TemporaryAcquisitionFailure({ retryAtMs: undefined });
    case "MalformedClaudeSubscriptionUsage":
      return new MalformedAcquisition();
    case "ClaudeAuthenticationUnavailable":
    case "ClaudeAuthenticationRejected":
    case "PermanentClaudeSubscriptionUsageFailure":
      return new PermanentAcquisitionFailure();
  }
}

/**
 * Runs Claude's weekly subscription usage through the shared session lifecycle.
 * The placeholder account contains no credential; authentication remains inside
 * the experimental acquisition adapter and is resolved for every acquisition.
 */
export function makeClaudeProviderMonitor(
  dependencies: ClaudeProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  const common: CodexProviderMonitorDependencies = {
    resolveCredential: Effect.succeed({
      kind: "available",
      credential: {
        accessToken: "not-a-credential",
        accountId: "anthropic-subscription",
      },
    }),
    acquireDedicatedWeeklyQuotaUsage: () =>
      dependencies.acquireClaudeSubscriptionUsage().pipe(
        Effect.map((usage) => ({
          ...usage,
          windowPosition: "secondary" as const,
        })),
        Effect.mapError(acquisitionFailure),
      ),
    publish: dependencies.publish,
    ...(dependencies.random === undefined
      ? {}
      : { random: dependencies.random }),
  };
  return makeCodexProviderMonitor(common);
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(
    ClaudeProviderMonitorService,
    makeClaudeProviderMonitor(dependencies),
  );
