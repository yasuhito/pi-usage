import { Context, Effect, type Exit, Layer, type Scope } from "effect";

import type {
  AcquireClaudeSubscriptionUsage,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  classifyProviderAcquisitionExit,
  makeProviderMonitor,
  type ProviderAcquisitionCompletion,
  type ProviderAcquisitionDisposition,
  type ProviderAcquisitionInspection,
  type ProviderCredentialInspection,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderMonitorContext,
  providerAcquisitionDefect,
  type WeeklySubscriptionUsageChange,
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

type AcquisitionResult =
  | {
      readonly kind: "acquired";
      readonly usage: AcquiredClaudeSubscriptionUsage;
    }
  | {
      readonly kind: "temporary";
      readonly retryAtMs: number | undefined;
      readonly staleUsage?: AcquiredClaudeSubscriptionUsage & {
        readonly observedAtMs: number;
      };
      readonly preserveUsage: boolean;
    }
  | { readonly kind: "authentication-unavailable" }
  | { readonly kind: "suppressed"; readonly retryAtMs: number }
  | { readonly kind: "terminal" }
  | Extract<ProviderAcquisitionDisposition, { readonly kind: "defect" }>;

type InspectedIdentity = ProviderCredentialInspection<string>;

function acquisitionResultFromExit(
  exit: Exit.Exit<
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageAcquisitionError
  >,
): AcquisitionResult | undefined {
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
        case "TemporaryClaudeSubscriptionUsageFailure":
          return {
            kind: "temporary",
            retryAtMs: result.error.retryAtMs,
            preserveUsage: result.error.preserveUsage !== false,
            ...(result.error.staleUsage === undefined
              ? {}
              : { staleUsage: result.error.staleUsage }),
          };
        case "MalformedClaudeSubscriptionUsage":
          return {
            kind: "temporary",
            retryAtMs: result.error.retryAtMs,
            preserveUsage: true,
            ...(result.error.staleUsage === undefined
              ? {}
              : { staleUsage: result.error.staleUsage }),
          };
        case "ClaudeAuthenticationUnavailable":
          return { kind: "authentication-unavailable" };
        case "ClaudeAuthenticationRejected":
          return result.error.retryAtMs === undefined
            ? { kind: "authentication-unavailable" }
            : { kind: "suppressed", retryAtMs: result.error.retryAtMs };
        case "PermanentClaudeSubscriptionUsageFailure":
          return result.error.retryAtMs === undefined
            ? { kind: "terminal" }
            : { kind: "suppressed", retryAtMs: result.error.retryAtMs };
      }
  }
}

/** Builds one Claude policy adapter; scheduling stays in provider-monitor. */
function makeClaudeProviderMonitorAdapter(
  dependencies: ClaudeProviderMonitorDependencies,
): ProviderMonitorAdapter {
  let identityFingerprint: string | undefined;
  let lastObservedAtMs: number | undefined;
  const usageLifecycle =
    createWeeklySubscriptionUsageLifecycle<AcquiredClaudeSubscriptionUsage>({});
  const change = (
    publication: WeeklySubscriptionUsageStatus | undefined,
    acquire = false,
  ): WeeklySubscriptionUsageChange => {
    const { staleExpirationAtMs } = usageLifecycle.current();
    return {
      publication,
      staleExpiration:
        staleExpirationAtMs === undefined
          ? { kind: "clear" }
          : { kind: "arm", atMs: staleExpirationAtMs },
      acquire,
    };
  };

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

  const clearUsage = (publish: boolean) => {
    lastObservedAtMs = undefined;
    usageLifecycle.advance({ kind: "invalidated" });
    return change(publish ? usageStatus() : undefined);
  };

  const applyIdentity = (
    resolution: ClaudeCredentialIdentityResolution,
    context: ProviderMonitorContext,
  ): Effect.Effect<InspectedIdentity> =>
    Effect.gen(function* () {
      if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
      if (resolution.kind === "missing") {
        identityFingerprint = undefined;
        return {
          continuity: "unavailable",
          credential: undefined,
          change: clearUsage(true),
        };
      }
      if (identityFingerprint !== resolution.fingerprint) {
        const replacingUsage =
          usageLifecycle.current().observation.kind === "usage";
        identityFingerprint = resolution.fingerprint;
        return {
          continuity: "changed",
          credential: resolution.fingerprint,
          change: clearUsage(replacingUsage),
        };
      }
      return {
        continuity: "unchanged",
        credential: resolution.fingerprint,
        change: change(undefined),
      };
    });

  const inspectIdentity = (context: ProviderMonitorContext) =>
    context.withoutPassiveObservation(
      dependencies.resolveCredentialIdentity.pipe(
        Effect.flatMap((resolution) => applyIdentity(resolution, context)),
      ),
    );

  const acquire = (
    acquisitionIdentity: string,
    context: ProviderMonitorContext,
  ): Effect.Effect<ProviderAcquisitionCompletion> =>
    Effect.gen(function* () {
      const result = acquisitionResultFromExit(
        yield* Effect.exit(dependencies.acquireClaudeSubscriptionUsage()),
      );
      if (result === undefined) return yield* Effect.interrupt;

      const currentIdentity = yield* inspectIdentity(context);
      if (
        result.kind === "acquired" &&
        currentIdentity.credential === result.usage.credentialFingerprint
      ) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
        const observedAtMs = result.usage.observedAtMs ?? now;
        lastObservedAtMs = observedAtMs;
        usageLifecycle.advance({
          kind: "observed",
          usage: result.usage,
          observedAtMs,
        });
        return {
          continuity: currentIdentity.continuity,
          changes: [currentIdentity.change, change(usageStatus())],
          disposition: { kind: "completed" },
        };
      }

      if (
        currentIdentity.credential === undefined ||
        currentIdentity.credential !== acquisitionIdentity
      ) {
        return {
          continuity: currentIdentity.continuity,
          changes: [currentIdentity.change],
          disposition: { kind: "completed" },
        };
      }

      switch (result.kind) {
        case "acquired":
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change],
            disposition: { kind: "completed" },
          };
        case "temporary": {
          const now = yield* Effect.clockWith(
            (clock) => clock.currentTimeMillis,
          );
          if (!result.preserveUsage) {
            lastObservedAtMs = undefined;
            usageLifecycle.advance({ kind: "invalidated" });
          }
          if (
            result.preserveUsage &&
            result.staleUsage !== undefined &&
            result.staleUsage.credentialFingerprint === acquisitionIdentity &&
            result.staleUsage.resetsAtMs > now
          ) {
            lastObservedAtMs = result.staleUsage.observedAtMs;
            usageLifecycle.advance({
              kind: "observed",
              usage: result.staleUsage,
              observedAtMs: result.staleUsage.observedAtMs,
            });
          }
          const lifecycleReaction = usageLifecycle.advance({
            kind: "temporarily-unavailable",
            nowMs: now,
          });
          if (lifecycleReaction.observation.kind === "none") {
            lastObservedAtMs = undefined;
          }
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, change(usageStatus())],
            disposition: {
              kind: "retry",
              retryAtMs: result.retryAtMs,
            },
          };
        }
        case "authentication-unavailable":
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, clearUsage(true)],
            disposition: { kind: "completed" },
          };
        case "suppressed":
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, clearUsage(true)],
            disposition: { kind: "retry", retryAtMs: result.retryAtMs },
          };
        case "terminal":
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, clearUsage(true)],
            disposition: { kind: "terminal" },
          };
        case "defect": {
          const defect = providerAcquisitionDefect(result.cause);
          return {
            ...defect,
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, ...defect.changes],
          };
        }
      }
    });

  return {
    inspectAcquisition: (
      context,
    ): Effect.Effect<ProviderAcquisitionInspection> =>
      Effect.gen(function* () {
        const identity = yield* inspectIdentity(context);
        if (identity.credential === undefined) {
          return {
            kind: "blocked",
            continuity: "unavailable",
            change: identity.change,
          };
        }
        return {
          kind: "ready",
          continuity: identity.continuity,
          change: identity.change,
          acquire: acquire(identity.credential, context),
        };
      }),
    observeActivity: (now) =>
      Effect.sync(() =>
        change(
          undefined,
          lastObservedAtMs === undefined ||
            now - lastObservedAtMs >= ACTIVITY_REFRESH_INTERVAL_MS,
        ),
      ),
    staleExpirationReached: (deadline, now) =>
      Effect.sync(() => {
        const lifecycleReaction = usageLifecycle.advance({
          kind: "stale-expiration-reached",
          deadlineMs: deadline,
          nowMs: now,
        });
        if (lifecycleReaction.publication === "preserve") {
          return change(undefined);
        }
        lastObservedAtMs = undefined;
        return change(usageStatus());
      }),
    finalize: Effect.sync(() => {
      identityFingerprint = undefined;
      lastObservedAtMs = undefined;
      usageLifecycle.advance({ kind: "session-ended" });
    }),
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
