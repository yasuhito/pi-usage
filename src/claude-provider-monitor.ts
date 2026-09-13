import { Context, Effect, Layer, type Scope } from "effect";

import type {
  AcquireClaudeSubscriptionUsage,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderWeeklySubscriptionUsageFacts,
  providerCredentialIdentity,
} from "./provider-monitor.ts";
import { createWeeklySubscriptionUsageLifecycle } from "./weekly-subscription-usage-lifecycle.ts";

const ACTIVITY_REFRESH_INTERVAL_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 15 * 60_000;

export class ClaudeProviderMonitorService extends Context.Tag(
  "ClaudeProviderMonitor",
)<ClaudeProviderMonitorService, ProviderMonitor>() {}

export type ClaudeCredentialIdentityResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "available"; readonly fingerprint: string };

export interface ClaudeProviderMonitorDependencies {
  readonly resolveCredentialIdentity: Effect.Effect<ClaudeCredentialIdentityResolution>;
  readonly acquireClaudeSubscriptionUsage: AcquireClaudeSubscriptionUsage;
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

/** Builds one Claude policy adapter; scheduling stays in provider-monitor. */
function makeClaudeProviderMonitorAdapter(
  dependencies: ClaudeProviderMonitorDependencies,
): ProviderMonitorAdapter<
  string,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError
> {
  let lastObservedAtMs: number | undefined;
  const usageLifecycle =
    createWeeklySubscriptionUsageLifecycle<AcquiredClaudeSubscriptionUsage>({});

  const usageStatus = (): WeeklySubscriptionUsageStatus => {
    const observation = usageLifecycle.current().observation;
    return observation.kind === "none"
      ? { kind: "unavailable" }
      : {
          kind: "available",
          usedPercent: observation.usage.usedPercent,
          stale: observation.freshness === "stale",
          weeklyWindowResetsAtMs: observation.usage.resetsAtMs,
        };
  };

  const weeklySubscriptionUsageFacts = (
    publish: boolean,
    observationEvidence?: ProviderWeeklySubscriptionUsageFacts["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderWeeklySubscriptionUsageFacts => ({
    presentation: publish
      ? { kind: "replace", status: usageStatus() }
      : { kind: "preserve" },
    staleUsageExpiresAtMs: usageLifecycle.current().staleExpirationAtMs,
    ...(observationEvidence === undefined ? {} : { observationEvidence }),
    ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
  });

  const clearUsage = (publish: boolean) => {
    lastObservedAtMs = undefined;
    usageLifecycle.advance({ kind: "invalidated" });
    return weeklySubscriptionUsageFacts(publish);
  };

  const temporaryFailure = (
    error: Extract<
      ClaudeSubscriptionUsageAcquisitionError,
      | { readonly _tag: "TemporaryClaudeSubscriptionUsageFailure" }
      | { readonly _tag: "MalformedClaudeSubscriptionUsage" }
    >,
    startedIdentity: string,
    nowMs: number,
  ): ProviderWeeklySubscriptionUsageFacts => {
    if (
      error._tag === "TemporaryClaudeSubscriptionUsageFailure" &&
      error.preserveUsage === false
    ) {
      lastObservedAtMs = undefined;
      usageLifecycle.advance({ kind: "invalidated" });
    }
    if (
      error.staleUsage !== undefined &&
      error.staleUsage.credentialFingerprint === startedIdentity &&
      error.staleUsage.resetsAtMs > nowMs &&
      !(
        error._tag === "TemporaryClaudeSubscriptionUsageFailure" &&
        error.preserveUsage === false
      )
    ) {
      lastObservedAtMs = error.staleUsage.observedAtMs;
      usageLifecycle.advance({
        kind: "observed",
        usage: error.staleUsage,
        observedAtMs: error.staleUsage.observedAtMs,
      });
    }
    const reaction = usageLifecycle.advance({
      kind: "temporarily-unavailable",
      nowMs,
    });
    if (reaction.observation.kind === "none") lastObservedAtMs = undefined;
    return weeklySubscriptionUsageFacts(true, undefined, {
      kind: "temporarily-unavailable",
      providerNotBeforeMs: error.retryAtMs,
    });
  };

  return {
    credentialVerification: "before-and-after",
    resolveCredential: dependencies.resolveCredentialIdentity.pipe(
      Effect.map((resolution) =>
        resolution.kind === "missing"
          ? {
              kind: "unavailable" as const,
              acceptPassiveObservation: false,
            }
          : {
              kind: "available" as const,
              identity: providerCredentialIdentity(resolution.fingerprint),
              credential: resolution.fingerprint,
              acceptPassiveObservation: false,
            },
      ),
    ),
    acquire: () => dependencies.acquireClaudeSubscriptionUsage(),
    advance: (event) =>
      Effect.sync(() => {
        switch (event.kind) {
          case "credential-observed": {
            if (event.continuity === "unchanged")
              return weeklySubscriptionUsageFacts(false);
            const replacingUsage =
              usageLifecycle.current().observation.kind === "usage";
            return clearUsage(!event.credentialAvailable || replacingUsage);
          }
          case "acquisition-completed": {
            if (event.exit.kind === "acquired") {
              if (
                event.currentIdentity !== event.exit.value.credentialFingerprint
              ) {
                return weeklySubscriptionUsageFacts(false, undefined, {
                  kind: "healthy",
                });
              }
              const observedAtMs = event.exit.value.observedAtMs ?? event.nowMs;
              lastObservedAtMs = observedAtMs;
              usageLifecycle.advance({
                kind: "observed",
                usage: event.exit.value,
                observedAtMs,
              });
              return weeklySubscriptionUsageFacts(true, "adequate", {
                kind: "healthy",
              });
            }
            if (
              event.currentIdentity === undefined ||
              event.currentIdentity !== event.startedIdentity
            ) {
              return weeklySubscriptionUsageFacts(false, undefined, {
                kind: "healthy",
              });
            }
            const error = event.exit.error;
            switch (error._tag) {
              case "TemporaryClaudeSubscriptionUsageFailure":
              case "MalformedClaudeSubscriptionUsage":
                return temporaryFailure(
                  error,
                  event.startedIdentity,
                  event.nowMs,
                );
              case "ClaudeAuthenticationUnavailable":
                return {
                  ...clearUsage(true),
                  acquisitionHealth: { kind: "healthy" },
                };
              case "ClaudeAuthenticationRejected":
                return {
                  ...clearUsage(true),
                  acquisitionHealth:
                    error.retryAtMs === undefined
                      ? { kind: "healthy" }
                      : {
                          kind: "temporarily-unavailable",
                          providerNotBeforeMs: error.retryAtMs,
                        },
                };
              case "PermanentClaudeSubscriptionUsageFailure":
                return {
                  ...clearUsage(true),
                  acquisitionHealth:
                    error.retryAtMs === undefined
                      ? { kind: "terminal" }
                      : {
                          kind: "temporarily-unavailable",
                          providerNotBeforeMs: error.retryAtMs,
                        },
                };
            }
            throw new TypeError("unknown Claude acquisition failure");
          }
          case "activity-observed":
            return weeklySubscriptionUsageFacts(
              false,
              lastObservedAtMs === undefined ||
                event.nowMs - lastObservedAtMs >= ACTIVITY_REFRESH_INTERVAL_MS
                ? "inadequate"
                : "adequate",
            );
          case "passive-observation":
          case "acquisition-deferred":
            return weeklySubscriptionUsageFacts(false);
          case "stale-expiration-reached": {
            const reaction = usageLifecycle.advance({
              kind: "stale-expiration-reached",
              deadlineMs: event.deadlineMs,
              nowMs: event.nowMs,
            });
            if (reaction.publication === "preserve")
              return weeklySubscriptionUsageFacts(false);
            lastObservedAtMs = undefined;
            return weeklySubscriptionUsageFacts(true);
          }
          case "session-ended":
            lastObservedAtMs = undefined;
            usageLifecycle.advance({ kind: "session-ended" });
            return weeklySubscriptionUsageFacts(false);
        }
      }),
    finalize: Effect.void,
  };
}

/** Builds one session-scoped monitor for direct Claude subscription usage. */
export function makeClaudeProviderMonitor(
  dependencies: ClaudeProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return makeProviderMonitor(makeClaudeProviderMonitorAdapter(dependencies), {
    ...dependencies,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(
    ClaudeProviderMonitorService,
    makeClaudeProviderMonitor(dependencies),
  );
