import { Cause, Effect, Exit, Layer, type Scope } from "effect";

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
  noProviderMonitorReaction,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderMonitorReaction,
  ProviderMonitorService,
  type ProviderMonitorTransition,
  type ProviderRefreshContext,
  type ProviderRefreshPlan,
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

function acquisitionResultFromExit(
  exit: Exit.Exit<
    AcquiredWeeklyQuotaUsage,
    DedicatedWeeklyQuotaAcquisitionError
  >,
): DedicatedWeeklyQuotaAcquisitionResult | undefined {
  if (Exit.isSuccess(exit)) return { kind: "acquired", usage: exit.value };
  if (Cause.isInterruptedOnly(exit.cause)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") {
    return { kind: "temporary-failure", retryAtMs: undefined };
  }
  switch (failure.value._tag) {
    case "AuthenticationRejected":
      return { kind: "authentication-rejected" };
    case "TemporaryAcquisitionFailure":
      return { kind: "temporary-failure", retryAtMs: failure.value.retryAtMs };
    case "PermanentAcquisitionFailure":
      return { kind: "permanently-unavailable" };
    case "MalformedAcquisition":
      return { kind: "malformed-observation" };
  }
  return { kind: "temporary-failure", retryAtMs: undefined };
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

function monitorReaction(
  reaction: WeeklyQuotaObservationReaction,
): ProviderMonitorReaction {
  return {
    publication: publicationFromReaction(reaction),
    staleExpiration:
      reaction.staleExpirationAtMs === undefined
        ? { kind: "clear" }
        : { kind: "arm", atMs: reaction.staleExpirationAtMs },
    acquire: reaction.acquireDedicated,
  };
}

function directiveFromResult(
  result: DedicatedWeeklyQuotaAcquisitionResult,
): ProviderRefreshPlan["directive"] {
  switch (result.kind) {
    case "temporary-failure":
      return { kind: "temporary-failure", retryAtMs: result.retryAtMs };
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

  const adaptReaction = (reaction: WeeklyQuotaObservationReaction) => {
    expectedStaleExpirationAtMs = reaction.staleExpirationAtMs;
    return monitorReaction(reaction);
  };

  const invalidateAccount = () =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      return adaptReaction(
        reconciliation.advance({ kind: "account-selection-invalidated" }, now),
      );
    });

  const applyCredential = (
    resolution: CodexCredentialResolution,
    context: ProviderRefreshContext,
  ): Effect.Effect<
    ProviderMonitorTransition & {
      readonly credential: CodexCredential | undefined;
    }
  > =>
    Effect.gen(function* () {
      if (!(yield* context.isCurrent)) {
        return {
          credential: undefined,
          schedule: "preserve",
          reaction: noProviderMonitorReaction(),
        };
      }
      if (resolution.kind === "missing") {
        credentialAvailable = false;
        currentAccountId = undefined;
        const reaction = yield* invalidateAccount();
        return {
          credential: undefined,
          schedule: "pause-retry",
          reaction: {
            ...reaction,
            publication: reaction.publication ?? { kind: "unavailable" },
          },
        };
      }
      if (resolution.kind === "invalid") {
        credentialAvailable = true;
        currentAccountId = undefined;
        const reaction = yield* invalidateAccount();
        return {
          credential: undefined,
          schedule: "reset",
          reaction: {
            ...reaction,
            publication: reaction.publication ?? { kind: "unavailable" },
          },
        };
      }
      credentialAvailable = true;
      if (currentAccountId !== resolution.credential.accountId) {
        currentAccountId = resolution.credential.accountId;
        return {
          credential: resolution.credential,
          schedule: "reset",
          reaction: yield* invalidateAccount(),
        };
      }
      credentialAvailable = true;
      return {
        credential: resolution.credential,
        schedule: "preserve",
        reaction: noProviderMonitorReaction(),
      };
    });

  const resolveCredential = (context: ProviderRefreshContext) =>
    context.resolveIdentity(
      dependencies.resolveCredential.pipe(
        Effect.flatMap((resolution) => applyCredential(resolution, context)),
      ),
    );

  const planFromResult = (
    result: DedicatedWeeklyQuotaAcquisitionResult,
  ): Effect.Effect<ProviderRefreshPlan> =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      return {
        beforeDirective: noProviderMonitorReaction(),
        directive: directiveFromResult(result),
        afterDirective: adaptReaction(
          reconciliation.advance(
            { kind: "dedicated-weekly-quota-acquisition", result },
            now,
          ),
        ),
      };
    });

  const acquisitionResult = (
    credential: CodexCredential,
    context: ProviderRefreshContext,
  ) =>
    Effect.gen(function* () {
      const result = acquisitionResultFromExit(
        yield* Effect.exit(
          dependencies.acquireDedicatedWeeklyQuotaUsage(credential),
        ),
      );
      if (result === undefined || !(yield* context.isCurrent)) {
        return yield* Effect.interrupt;
      }
      return result;
    });

  const completeAcquisition = (
    credential: CodexCredential,
    context: ProviderRefreshContext,
  ) =>
    acquisitionResult(credential, context).pipe(Effect.flatMap(planFromResult));

  const acquire = (
    credential: CodexCredential,
    context: ProviderRefreshContext,
  ) =>
    Effect.gen(function* () {
      const result = yield* acquisitionResult(credential, context);
      if (result.kind === "authentication-rejected") {
        const refreshed = yield* resolveCredential(context);
        if (refreshed.credential === undefined || !(yield* context.isCurrent)) {
          return {
            kind: "stop" as const,
            transition: refreshed,
          };
        }
        return {
          kind: "continue" as const,
          transition: refreshed,
          execute: completeAcquisition(refreshed.credential, context),
        };
      }
      return yield* planFromResult(result);
    });

  return {
    prepareRefresh: (context) =>
      Effect.gen(function* () {
        const resolved = yield* resolveCredential(context);
        if (resolved.credential === undefined) {
          return {
            kind: "skip",
            schedule: resolved.schedule,
            reaction: resolved.reaction,
          };
        }
        return {
          kind: "ready",
          schedule: resolved.schedule,
          reaction: resolved.reaction,
          execute: acquire(resolved.credential, context),
        };
      }),
    observeResponse: (fields, now) =>
      Effect.sync(() => {
        if (!credentialAvailable) return noProviderMonitorReaction();
        return adaptReaction(
          reconciliation.advance(
            { kind: "passive-weekly-quota-observation", fields },
            now,
          ),
        );
      }),
    observeActivity: (now) =>
      Effect.sync(() =>
        adaptReaction(reconciliation.advance({ kind: "activity" }, now)),
      ),
    acquisitionDeferred: (now) =>
      Effect.sync(() =>
        adaptReaction(
          reconciliation.advance(
            { kind: "dedicated-weekly-quota-acquisition-deferred" },
            now,
          ),
        ),
      ),
    staleExpirationReached: (deadline, now) =>
      Effect.sync(() => {
        if (expectedStaleExpirationAtMs !== deadline) {
          return noProviderMonitorReaction();
        }
        return adaptReaction(
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
