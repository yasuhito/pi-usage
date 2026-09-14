import { createHash } from "node:crypto";
import { Effect, Layer, type Scope } from "effect";

import type {
  AcquireClaudeSubscriptionUsage,
  AcquiredClaudeSubscriptionUsage,
  ClaudeOAuthCredential,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderCapacityFacts,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  ProviderMonitorService,
  providerCredentialIdentity,
} from "./provider-monitor.ts";
import { createWeeklySubscriptionUsageLifecycle } from "./weekly-subscription-usage-lifecycle.ts";

const ACTIVITY_REFRESH_INTERVAL_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 15 * 60_000;

export interface ClaudeAuthentication {
  readonly source?: string;
  readonly auth: {
    readonly apiKey?: string;
  };
}

export interface ClaudeProviderMonitorDependencies {
  readonly resolveAuthentication: () => Effect.Effect<
    ClaudeAuthentication | undefined,
    unknown
  >;
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
  ClaudeOAuthCredential,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
  WeeklySubscriptionUsageStatus
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
    observationEvidence?: ProviderCapacityFacts<WeeklySubscriptionUsageStatus>["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderCapacityFacts<WeeklySubscriptionUsageStatus> => ({
    presentation: publish
      ? { kind: "replace", status: usageStatus() }
      : { kind: "preserve" },
    staleCapacityExpiresAtMs: usageLifecycle.current().staleExpirationAtMs,
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
    nowMs: number,
  ): ProviderCapacityFacts<WeeklySubscriptionUsageStatus> => {
    if (
      error._tag === "TemporaryClaudeSubscriptionUsageFailure" &&
      error.preserveUsage === false
    ) {
      lastObservedAtMs = undefined;
      usageLifecycle.advance({ kind: "invalidated" });
    }
    if (
      error.staleUsage !== undefined &&
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
    resolveCredential: Effect.suspend(dependencies.resolveAuthentication).pipe(
      Effect.catchAllCause(() => Effect.succeed(undefined)),
      Effect.map((authentication) => {
        const key =
          authentication?.source === "OAuth"
            ? authentication.auth.apiKey?.trim()
            : undefined;
        if (key === undefined || key === "") {
          return {
            kind: "unavailable" as const,
            acceptPassiveObservation: false,
          };
        }
        return {
          kind: "available" as const,
          identity: providerCredentialIdentity(
            createHash("sha256").update(key).digest("hex"),
          ),
          credential: key as ClaudeOAuthCredential,
          acceptPassiveObservation: false,
        };
      }),
    ),
    acquire: dependencies.acquireClaudeSubscriptionUsage,
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
            if (
              event.exit.kind === "failed" &&
              event.exit.error._tag === "ClaudeAuthenticationRejected" &&
              !event.authenticationRefreshUsed
            ) {
              return weeklySubscriptionUsageFacts(false, undefined, {
                kind: "credential-rejected",
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
            if (event.exit.kind === "acquired") {
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
            const error = event.exit.error;
            switch (error._tag) {
              case "TemporaryClaudeSubscriptionUsageFailure":
              case "MalformedClaudeSubscriptionUsage":
                return temporaryFailure(error, event.nowMs);
              case "ClaudeAcquisitionCoordinationUnavailable":
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
  return makeProviderMonitor<
    ClaudeOAuthCredential,
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageAcquisitionError,
    WeeklySubscriptionUsageStatus
  >(makeClaudeProviderMonitorAdapter(dependencies), {
    ...dependencies,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(ProviderMonitorService, makeClaudeProviderMonitor(dependencies));
