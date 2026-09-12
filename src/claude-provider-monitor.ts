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

const REFRESH_DEBOUNCE_MS = 30_000;
const STALE_AFTER_MS = 10 * 60_000;

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
  | { readonly kind: "temporary"; readonly retryAtMs: number | undefined }
  | { readonly kind: "authentication-unavailable" }
  | { readonly kind: "terminal" }
  | Extract<ProviderAcquisitionDisposition, { readonly kind: "defect" }>;

interface CapturedUsage {
  readonly usage: AcquiredClaudeSubscriptionUsage;
  readonly capturedAtMs: number;
  readonly stale: boolean;
}

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
          return { kind: "temporary", retryAtMs: result.error.retryAtMs };
        case "MalformedClaudeSubscriptionUsage":
          return { kind: "temporary", retryAtMs: undefined };
        case "ClaudeAuthenticationUnavailable":
        case "ClaudeAuthenticationRejected":
          return { kind: "authentication-unavailable" };
        case "PermanentClaudeSubscriptionUsageFailure":
          return { kind: "terminal" };
      }
  }
}

/** Builds one Claude policy adapter; scheduling stays in provider-monitor. */
function makeClaudeProviderMonitorAdapter(
  dependencies: ClaudeProviderMonitorDependencies,
): ProviderMonitorAdapter {
  let identityFingerprint: string | undefined;
  let usage: CapturedUsage | undefined;

  const staleExpirationAtMs = () =>
    usage?.stale === true
      ? Math.min(usage.capturedAtMs + STALE_AFTER_MS, usage.usage.resetsAtMs)
      : undefined;

  const change = (
    publication: WeeklySubscriptionUsageStatus | undefined,
    acquire = false,
  ): WeeklySubscriptionUsageChange => {
    const deadline = staleExpirationAtMs();
    return {
      publication,
      staleExpiration:
        deadline === undefined
          ? { kind: "clear" }
          : { kind: "arm", atMs: deadline },
      acquire,
    };
  };

  const usageStatus = (): WeeklySubscriptionUsageStatus =>
    usage === undefined
      ? { kind: "unavailable" }
      : {
          kind: "available",
          usedPercent: usage.usage.usedPercent,
          stale: usage.stale,
          weeklyWindowResetsAtMs: usage.usage.resetsAtMs,
        };

  const clearUsage = (publish: boolean) => {
    usage = undefined;
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
        const replacingUsage = usage !== undefined;
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
        usage = { usage: result.usage, capturedAtMs: now, stale: false };
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
        case "temporary":
          if (usage !== undefined) usage = { ...usage, stale: true };
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, change(usageStatus())],
            disposition: {
              kind: "retry",
              retryAtMs: result.retryAtMs,
            },
          };
        case "authentication-unavailable":
          return {
            continuity: currentIdentity.continuity,
            changes: [currentIdentity.change, clearUsage(true)],
            disposition: { kind: "completed" },
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
          usage === undefined ||
            now - usage.capturedAtMs >= REFRESH_DEBOUNCE_MS,
        ),
      ),
    staleExpirationReached: (deadline) =>
      Effect.sync(() => {
        if (!usage?.stale || staleExpirationAtMs() !== deadline) {
          return change(undefined);
        }
        usage = undefined;
        return change({ kind: "unavailable" });
      }),
    finalize: Effect.sync(() => {
      identityFingerprint = undefined;
      usage = undefined;
    }),
  };
}

/** Builds one session-scoped monitor for direct Claude subscription usage. */
export function makeClaudeProviderMonitor(
  dependencies: ClaudeProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return makeProviderMonitor(
    makeClaudeProviderMonitorAdapter(dependencies),
    dependencies,
  );
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(
    ClaudeProviderMonitorService,
    makeClaudeProviderMonitor(dependencies),
  );
