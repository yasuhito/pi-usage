import { Effect, Layer, type Scope } from "effect";

import type {
  AcquireDedicatedWeeklyQuotaUsage,
  AcquiredWeeklyQuotaUsage,
  CodexCredential,
  DedicatedWeeklyQuotaAcquisitionError,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  ProviderMonitorService,
  type ProviderWeeklySubscriptionUsageFacts,
  providerCredentialIdentity,
} from "./provider-monitor.ts";
import {
  createWeeklyQuotaObservationReconciliation,
  type WeeklyQuotaObservationReaction,
} from "./weekly-quota-observation-reconciliation.ts";

export type CodexCredentialResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly credential: CodexCredential };

export interface CodexProviderMonitorDependencies {
  readonly resolveCredential: Effect.Effect<CodexCredentialResolution>;
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

function acquisitionResultFromError(
  error: DedicatedWeeklyQuotaAcquisitionError,
): DedicatedWeeklyQuotaAcquisitionResult {
  switch (error._tag) {
    case "AuthenticationRejected":
      return { kind: "authentication-rejected" };
    case "TemporaryAcquisitionFailure":
      return { kind: "temporary-failure", retryAtMs: error.retryAtMs };
    case "PermanentAcquisitionFailure":
      return { kind: "permanently-unavailable" };
    case "MalformedAcquisition":
      return { kind: "malformed-observation" };
  }
}

function publicationFromReaction(
  reaction: WeeklyQuotaObservationReaction,
): WeeklySubscriptionUsageStatus | undefined {
  if (reaction.publication !== "replace") return undefined;
  if (reaction.observation.kind === "none") return { kind: "unavailable" };
  const usage = reaction.observation.usage;
  return {
    kind: "available",
    usedPercent: usage.usedPercent,
    stale: reaction.observation.freshness === "stale",
    weeklyWindowResetsAtMs: usage.resetsAtMs,
    ...(usage.availableLimitResetCredits === undefined
      ? {}
      : { availableLimitResetCredits: usage.availableLimitResetCredits }),
  };
}

function healthFromResult(
  result: DedicatedWeeklyQuotaAcquisitionResult,
): ProviderAcquisitionHealth {
  switch (result.kind) {
    case "temporary-failure":
      return {
        kind: "temporarily-unavailable",
        providerNotBeforeMs: result.retryAtMs,
      };
    case "permanently-unavailable":
      return { kind: "terminal" };
    default:
      return { kind: "healthy" };
  }
}

/** Builds one Codex policy adapter; shared scheduling stays in provider-monitor. */
function makeCodexProviderMonitorAdapter(
  dependencies: CodexProviderMonitorDependencies,
): ProviderMonitorAdapter<
  CodexCredential,
  AcquiredWeeklyQuotaUsage,
  DedicatedWeeklyQuotaAcquisitionError
> {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  let expectedStaleExpirationAtMs: number | undefined;

  const factsFromReconciliation = (
    reaction: WeeklyQuotaObservationReaction,
    observationEvidence?: ProviderWeeklySubscriptionUsageFacts["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
    forceUnavailable = false,
  ): ProviderWeeklySubscriptionUsageFacts => {
    expectedStaleExpirationAtMs = reaction.staleExpirationAtMs;
    const publication = publicationFromReaction(reaction);
    return {
      presentation:
        publication === undefined && !forceUnavailable
          ? { kind: "preserve" }
          : {
              kind: "replace",
              status: publication ?? { kind: "unavailable" },
            },
      staleUsageExpiresAtMs: reaction.staleExpirationAtMs,
      ...(observationEvidence === undefined ? {} : { observationEvidence }),
      ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
    };
  };

  const preservedFacts = (
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderWeeklySubscriptionUsageFacts => ({
    presentation: { kind: "preserve" },
    staleUsageExpiresAtMs: expectedStaleExpirationAtMs,
    ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
  });

  return {
    credentialVerification: "before",
    resolveCredential: dependencies.resolveCredential.pipe(
      Effect.map((resolution) => {
        if (resolution.kind === "available") {
          return {
            kind: "available" as const,
            identity: providerCredentialIdentity(
              resolution.credential.accountId,
            ),
            credential: resolution.credential,
            acceptPassiveObservation: true,
          };
        }
        return {
          kind: "unavailable" as const,
          acceptPassiveObservation: resolution.kind === "invalid",
        };
      }),
    ),
    acquire: dependencies.acquireDedicatedWeeklyQuotaUsage,
    advance: (event) =>
      Effect.sync(() => {
        switch (event.kind) {
          case "credential-observed": {
            if (event.continuity === "unchanged") return preservedFacts();
            const reaction = reconciliation.advance(
              { kind: "account-selection-invalidated" },
              event.nowMs,
            );
            return factsFromReconciliation(
              reaction,
              undefined,
              undefined,
              !event.credentialAvailable && reaction.publication !== "replace",
            );
          }
          case "acquisition-completed": {
            const result =
              event.exit.kind === "acquired"
                ? { kind: "acquired" as const, usage: event.exit.value }
                : acquisitionResultFromError(event.exit.error);
            if (
              result.kind === "authentication-rejected" &&
              !event.authenticationRefreshUsed
            ) {
              return preservedFacts({ kind: "credential-rejected" });
            }
            const reaction = reconciliation.advance(
              { kind: "dedicated-weekly-quota-acquisition", result },
              event.nowMs,
            );
            return factsFromReconciliation(
              reaction,
              result.kind === "acquired" ? "adequate" : undefined,
              healthFromResult(result),
            );
          }
          case "passive-observation": {
            const reaction = reconciliation.advance(
              {
                kind: "passive-weekly-quota-observation",
                fields: event.fields,
              },
              event.nowMs,
            );
            return factsFromReconciliation(
              reaction,
              reaction.acquireDedicated ? "inadequate" : undefined,
            );
          }
          case "activity-observed": {
            const reaction = reconciliation.advance(
              { kind: "activity" },
              event.nowMs,
            );
            return factsFromReconciliation(
              reaction,
              reaction.acquireDedicated ? "inadequate" : "adequate",
            );
          }
          case "acquisition-deferred":
            return factsFromReconciliation(
              reconciliation.advance(
                { kind: "dedicated-weekly-quota-acquisition-deferred" },
                event.nowMs,
              ),
            );
          case "stale-expiration-reached":
            if (expectedStaleExpirationAtMs !== event.deadlineMs) {
              return preservedFacts();
            }
            return factsFromReconciliation(
              reconciliation.advance(
                {
                  kind: "stale-usage-expiration-reached",
                  deadlineMs: event.deadlineMs,
                },
                event.nowMs,
              ),
            );
          case "session-ended":
            expectedStaleExpirationAtMs = undefined;
            return factsFromReconciliation(
              reconciliation.advance({ kind: "session-ended" }, 0),
            );
        }
      }),
    finalize: Effect.void,
  };
}

/**
 * Builds one deep Codex monitor in the caller's session Scope. Provider policy
 * remains local; shared scheduling lives behind the ProviderMonitor seam.
 */
export function makeCodexProviderMonitor(
  dependencies: CodexProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return makeProviderMonitor(
    makeCodexProviderMonitorAdapter(dependencies),
    dependencies,
  );
}

/** A session-scoped Layer that hides Codex acquisition and reconciliation. */
export const codexProviderMonitorLayer = (
  dependencies: CodexProviderMonitorDependencies,
) =>
  Layer.scoped(ProviderMonitorService, makeCodexProviderMonitor(dependencies));
