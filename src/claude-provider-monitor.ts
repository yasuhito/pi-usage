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
import {
  createStaleCapacityLifecycle,
  type StaleCapacityLifecycleReaction,
} from "./stale-capacity-lifecycle.ts";

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
  const capacityLifecycle =
    createStaleCapacityLifecycle<AcquiredClaudeSubscriptionUsage>({
      staleExpiresAtMs: ({ capacity }) => capacity.resetsAtMs,
    });

  const currentReaction =
    (): StaleCapacityLifecycleReaction<AcquiredClaudeSubscriptionUsage> => ({
      ...capacityLifecycle.current(),
      publication: "preserve",
    });

  const weeklySubscriptionUsageFacts = (
    reaction: StaleCapacityLifecycleReaction<AcquiredClaudeSubscriptionUsage>,
    observationEvidence?: ProviderCapacityFacts<WeeklySubscriptionUsageStatus>["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderCapacityFacts<WeeklySubscriptionUsageStatus> => {
    const observation = reaction.observation;
    const status: WeeklySubscriptionUsageStatus =
      observation.kind === "none"
        ? { kind: "unavailable" }
        : {
            kind: "available",
            usedPercent: observation.capacity.usedPercent,
            stale: observation.freshness === "stale",
            weeklyWindowResetsAtMs: observation.capacity.resetsAtMs,
          };
    return {
      presentation:
        reaction.publication === "replace"
          ? { kind: "replace", status }
          : { kind: "preserve" },
      staleCapacityExpiration: reaction.staleExpiration,
      ...(observationEvidence === undefined ? {} : { observationEvidence }),
      ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
    };
  };

  const clearUsage = (kind: "unavailable" | "invalidated") => {
    lastObservedAtMs = undefined;
    return weeklySubscriptionUsageFacts(capacityLifecycle.advance({ kind }));
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
      capacityLifecycle.advance({ kind: "invalidated" });
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
      capacityLifecycle.advance({
        kind: "observed",
        capacity: error.staleUsage,
        observedAtMs: error.staleUsage.observedAtMs,
      });
    }
    const reaction = capacityLifecycle.advance({
      kind: "temporarily-unavailable",
      nowMs,
    });
    if (reaction.observation.kind === "none") lastObservedAtMs = undefined;
    return weeklySubscriptionUsageFacts(reaction, undefined, {
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
              return weeklySubscriptionUsageFacts(currentReaction());
            return clearUsage(
              event.credentialAvailable ? "invalidated" : "unavailable",
            );
          }
          case "acquisition-completed": {
            if (
              event.exit.kind === "failed" &&
              event.exit.error._tag === "ClaudeAuthenticationRejected" &&
              !event.authenticationRefreshUsed
            ) {
              return weeklySubscriptionUsageFacts(
                currentReaction(),
                undefined,
                { kind: "credential-rejected" },
              );
            }
            if (
              event.currentIdentity === undefined ||
              event.currentIdentity !== event.startedIdentity
            ) {
              return weeklySubscriptionUsageFacts(
                currentReaction(),
                undefined,
                { kind: "healthy" },
              );
            }
            if (event.exit.kind === "acquired") {
              const observedAtMs = event.exit.value.observedAtMs ?? event.nowMs;
              lastObservedAtMs = observedAtMs;
              const reaction = capacityLifecycle.advance({
                kind: "observed",
                capacity: event.exit.value,
                observedAtMs,
              });
              return weeklySubscriptionUsageFacts(reaction, "adequate", {
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
                  ...clearUsage("unavailable"),
                  acquisitionHealth: { kind: "healthy" },
                };
              case "ClaudeAuthenticationRejected":
                return {
                  ...clearUsage("unavailable"),
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
                  ...clearUsage("unavailable"),
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
              currentReaction(),
              lastObservedAtMs === undefined ||
                event.nowMs - lastObservedAtMs >= ACTIVITY_REFRESH_INTERVAL_MS
                ? "inadequate"
                : "adequate",
            );
          case "passive-observation":
          case "acquisition-deferred":
            return weeklySubscriptionUsageFacts(currentReaction());
          case "stale-expiration-reached": {
            const reaction = capacityLifecycle.advance({
              kind: "stale-expiration-reached",
              deadline: event.deadline,
              nowMs: event.nowMs,
            });
            if (reaction.observation.kind === "none")
              lastObservedAtMs = undefined;
            return weeklySubscriptionUsageFacts(reaction);
          }
          case "session-ended":
            lastObservedAtMs = undefined;
            return weeklySubscriptionUsageFacts(
              capacityLifecycle.advance({ kind: "session-ended" }),
            );
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
    polling: { kind: "periodic", intervalMs: POLL_INTERVAL_MS },
  });
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(ProviderMonitorService, makeClaudeProviderMonitor(dependencies));
