import { Effect, type Exit, Layer, type Scope } from "effect";

import type {
  AcquireDedicatedWeeklyQuotaUsage,
  AcquiredWeeklyQuotaUsage,
  CodexCredential,
  DedicatedWeeklyQuotaAcquisitionError,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  classifyProviderAcquisitionExit,
  makeProviderMonitor,
  noWeeklySubscriptionUsageChange,
  type ProviderAcquisitionCompletion,
  type ProviderAcquisitionDisposition,
  type ProviderAcquisitionInspection,
  type ProviderCredentialInspection,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderMonitorContext,
  ProviderMonitorService,
  providerAcquisitionDefect,
  type WeeklySubscriptionUsageChange,
} from "./provider-monitor.ts";
import {
  createWeeklyQuotaObservationReconciliation,
  type WeeklyQuotaObservationReaction,
} from "./weekly-quota-observation-reconciliation.ts";

export type CodexCredentialResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly credential: CodexCredential };

type AcquisitionExitResult =
  | DedicatedWeeklyQuotaAcquisitionResult
  | Extract<ProviderAcquisitionDisposition, { readonly kind: "defect" }>;

export interface CodexProviderMonitorDependencies {
  readonly resolveCredential: Effect.Effect<CodexCredentialResolution>;
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

function acquisitionResultFromExit(
  exit: Exit.Exit<
    AcquiredWeeklyQuotaUsage,
    DedicatedWeeklyQuotaAcquisitionError
  >,
): AcquisitionExitResult | undefined {
  const result = classifyProviderAcquisitionExit(exit);
  switch (result.kind) {
    case "acquired":
      return { kind: "acquired", usage: result.value };
    case "interrupted":
      return undefined;
    case "defect":
      return result;
    case "failed":
      switch (result.error._tag) {
        case "AuthenticationRejected":
          return { kind: "authentication-rejected" };
        case "TemporaryAcquisitionFailure":
          return {
            kind: "temporary-failure",
            retryAtMs: result.error.retryAtMs,
          };
        case "PermanentAcquisitionFailure":
          return { kind: "permanently-unavailable" };
        case "MalformedAcquisition":
          return { kind: "malformed-observation" };
      }
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

function monitorChange(
  reaction: WeeklyQuotaObservationReaction,
): WeeklySubscriptionUsageChange {
  return {
    publication: publicationFromReaction(reaction),
    staleExpiration:
      reaction.staleExpirationAtMs === undefined
        ? { kind: "clear" }
        : { kind: "arm", atMs: reaction.staleExpirationAtMs },
    acquire: reaction.acquireDedicated,
  };
}

function dispositionFromResult(
  result: DedicatedWeeklyQuotaAcquisitionResult,
): ProviderAcquisitionDisposition {
  switch (result.kind) {
    case "temporary-failure":
      return { kind: "retry", retryAtMs: result.retryAtMs };
    case "permanently-unavailable":
      return { kind: "terminal" };
    default:
      return { kind: "completed" };
  }
}

/** Builds one Codex policy adapter; shared scheduling stays in provider-monitor. */
function makeCodexProviderMonitorAdapter(
  dependencies: CodexProviderMonitorDependencies,
): ProviderMonitorAdapter {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  let credentialAvailable = false;
  let currentAccountId: string | undefined;
  let expectedStaleExpirationAtMs: number | undefined;

  const adaptChange = (reaction: WeeklyQuotaObservationReaction) => {
    expectedStaleExpirationAtMs = reaction.staleExpirationAtMs;
    return monitorChange(reaction);
  };

  const invalidateAccount = () =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      return adaptChange(
        reconciliation.advance({ kind: "account-selection-invalidated" }, now),
      );
    });

  const applyCredential = (
    resolution: CodexCredentialResolution,
    context: ProviderMonitorContext,
  ): Effect.Effect<ProviderCredentialInspection<CodexCredential>> =>
    Effect.gen(function* () {
      if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
      if (resolution.kind === "missing" || resolution.kind === "invalid") {
        credentialAvailable = resolution.kind === "invalid";
        currentAccountId = undefined;
        const change = yield* invalidateAccount();
        return {
          continuity: "unavailable" as const,
          credential: undefined,
          change: {
            ...change,
            publication: change.publication ?? { kind: "unavailable" },
          },
        };
      }
      credentialAvailable = true;
      if (currentAccountId !== resolution.credential.accountId) {
        currentAccountId = resolution.credential.accountId;
        return {
          continuity: "changed" as const,
          credential: resolution.credential,
          change: yield* invalidateAccount(),
        };
      }
      return {
        continuity: "unchanged" as const,
        credential: resolution.credential,
        change: noWeeklySubscriptionUsageChange(),
      };
    });

  const inspectCredential = (context: ProviderMonitorContext) =>
    context.withoutPassiveObservation(
      dependencies.resolveCredential.pipe(
        Effect.flatMap((resolution) => applyCredential(resolution, context)),
      ),
    );

  const completionFromResult = (
    result: DedicatedWeeklyQuotaAcquisitionResult,
    context: ProviderMonitorContext,
  ): Effect.Effect<ProviderAcquisitionCompletion> =>
    Effect.gen(function* () {
      if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
      return {
        changes: [
          adaptChange(
            reconciliation.advance(
              { kind: "dedicated-weekly-quota-acquisition", result },
              now,
            ),
          ),
        ],
        disposition: dispositionFromResult(result),
      };
    });

  const acquisitionResult = (credential: CodexCredential) =>
    Effect.gen(function* () {
      const result = acquisitionResultFromExit(
        yield* Effect.exit(
          dependencies.acquireDedicatedWeeklyQuotaUsage(credential),
        ),
      );
      if (result === undefined) return yield* Effect.interrupt;
      return result;
    });

  const completeAcquisition = (
    credential: CodexCredential,
    context: ProviderMonitorContext,
  ) =>
    acquisitionResult(credential).pipe(
      Effect.flatMap((result) =>
        result.kind === "defect"
          ? Effect.succeed(providerAcquisitionDefect(result.cause))
          : completionFromResult(result, context),
      ),
    );

  const acquire = (
    credential: CodexCredential,
    context: ProviderMonitorContext,
  ) =>
    Effect.gen(function* () {
      const result = yield* acquisitionResult(credential);
      if (result.kind === "defect") {
        return providerAcquisitionDefect(result.cause);
      }
      if (result.kind !== "authentication-rejected") {
        return yield* completionFromResult(result, context);
      }

      const refreshed = yield* inspectCredential(context);
      if (refreshed.credential === undefined) {
        return {
          continuity: "unavailable" as const,
          changes: [refreshed.change],
          disposition: { kind: "completed" as const },
        };
      }
      const completion = yield* completeAcquisition(
        refreshed.credential,
        context,
      );
      return {
        ...completion,
        continuity: refreshed.continuity,
        changes: [refreshed.change, ...completion.changes],
      };
    });

  return {
    inspectAcquisition: (
      context,
    ): Effect.Effect<ProviderAcquisitionInspection> =>
      Effect.gen(function* () {
        const inspected = yield* inspectCredential(context);
        if (inspected.credential === undefined) {
          return {
            kind: "blocked",
            continuity: "unavailable",
            change: inspected.change,
          };
        }
        return {
          kind: "ready",
          continuity: inspected.continuity,
          change: inspected.change,
          acquire: acquire(inspected.credential, context),
          acquisitionDeferred: Effect.gen(function* () {
            const now = yield* Effect.clockWith(
              (clock) => clock.currentTimeMillis,
            );
            return adaptChange(
              reconciliation.advance(
                { kind: "dedicated-weekly-quota-acquisition-deferred" },
                now,
              ),
            );
          }),
        };
      }),
    observeResponse: (fields, now) =>
      Effect.sync(() => {
        if (!credentialAvailable) return noWeeklySubscriptionUsageChange();
        return adaptChange(
          reconciliation.advance(
            { kind: "passive-weekly-quota-observation", fields },
            now,
          ),
        );
      }),
    observeActivity: (now) =>
      Effect.sync(() =>
        adaptChange(reconciliation.advance({ kind: "activity" }, now)),
      ),
    staleExpirationReached: (deadline, now) =>
      Effect.sync(() => {
        if (expectedStaleExpirationAtMs !== deadline) {
          return noWeeklySubscriptionUsageChange();
        }
        return adaptChange(
          reconciliation.advance(
            { kind: "stale-usage-expiration-reached" },
            now,
          ),
        );
      }),
    finalize: Effect.sync(() => {
      credentialAvailable = false;
      currentAccountId = undefined;
      expectedStaleExpirationAtMs = undefined;
    }),
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
