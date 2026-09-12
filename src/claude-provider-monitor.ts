import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";

import type {
  AcquireClaudeSubscriptionUsage,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderMonitorReaction,
  type ProviderMonitorTransition,
  type ProviderRefreshContext,
  type ProviderRefreshPlan,
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
  | { readonly kind: "terminal" };

interface CapturedUsage {
  readonly usage: AcquiredClaudeSubscriptionUsage;
  readonly capturedAtMs: number;
  readonly stale: boolean;
}

type AppliedIdentity = ProviderMonitorTransition &
  (
    | { readonly available: false }
    | {
        readonly available: true;
        readonly fingerprint: string;
      }
  );

function acquisitionResultFromExit(
  exit: Exit.Exit<
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageAcquisitionError
  >,
): AcquisitionResult | undefined {
  if (Exit.isSuccess(exit)) return { kind: "acquired", usage: exit.value };
  if (Cause.isInterruptedOnly(exit.cause)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") {
    return { kind: "temporary", retryAtMs: undefined };
  }
  switch (failure.value._tag) {
    case "TemporaryClaudeSubscriptionUsageFailure":
      return { kind: "temporary", retryAtMs: failure.value.retryAtMs };
    case "MalformedClaudeSubscriptionUsage":
      return { kind: "temporary", retryAtMs: undefined };
    case "ClaudeAuthenticationUnavailable":
    case "ClaudeAuthenticationRejected":
      return { kind: "authentication-unavailable" };
    case "PermanentClaudeSubscriptionUsageFailure":
      return { kind: "terminal" };
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

  const reaction = (
    publication: WeeklySubscriptionUsageStatus | undefined,
    acquire = false,
  ): ProviderMonitorReaction => {
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
    return reaction(publish ? usageStatus() : undefined);
  };

  const applyIdentity = (
    resolution: ClaudeCredentialIdentityResolution,
    context: ProviderRefreshContext,
  ): Effect.Effect<AppliedIdentity> =>
    Effect.gen(function* () {
      if (!(yield* context.isCurrent)) {
        return {
          available: false as const,
          schedule: "preserve",
          reaction: reaction(undefined),
        };
      }
      if (resolution.kind === "missing") {
        identityFingerprint = undefined;
        return {
          available: false as const,
          schedule: "reset",
          reaction: clearUsage(true),
        };
      }
      if (identityFingerprint !== resolution.fingerprint) {
        const replacingUsage = usage !== undefined;
        identityFingerprint = resolution.fingerprint;
        return {
          available: true as const,
          fingerprint: resolution.fingerprint,
          schedule: "reset",
          reaction: clearUsage(replacingUsage),
        };
      }
      return {
        available: true as const,
        fingerprint: resolution.fingerprint,
        schedule: "preserve",
        reaction: reaction(undefined),
      };
    });

  const planWithAfter = (
    directive: ProviderRefreshPlan["directive"],
    afterDirective: ProviderMonitorReaction,
    transition?: AppliedIdentity,
  ): ProviderRefreshPlan => ({
    ...(transition === undefined ? {} : { transition }),
    beforeDirective: reaction(undefined),
    directive,
    afterDirective,
  });

  const acquire = (
    acquisitionIdentity: string,
    context: ProviderRefreshContext,
  ) =>
    Effect.gen(function* () {
      const result = acquisitionResultFromExit(
        yield* Effect.exit(dependencies.acquireClaudeSubscriptionUsage()),
      );
      if (result === undefined || !(yield* context.isCurrent)) {
        return yield* Effect.interrupt;
      }

      const currentIdentity = yield* context.resolveIdentity(
        dependencies.resolveCredentialIdentity,
      );
      if (!(yield* context.isCurrent)) return yield* Effect.interrupt;
      if (result.kind === "acquired") {
        if (
          currentIdentity.kind !== "available" ||
          currentIdentity.fingerprint !== result.usage.credentialFingerprint
        ) {
          const identity = yield* applyIdentity(currentIdentity, context);
          return planWithAfter(
            { kind: "completed" },
            reaction(undefined),
            identity,
          );
        }
        const identity = yield* applyIdentity(currentIdentity, context);
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        usage = { usage: result.usage, capturedAtMs: now, stale: false };
        return planWithAfter(
          { kind: "completed" },
          reaction(usageStatus()),
          identity,
        );
      } else if (
        currentIdentity.kind !== "available" ||
        currentIdentity.fingerprint !== acquisitionIdentity
      ) {
        const identity = yield* applyIdentity(currentIdentity, context);
        return planWithAfter(
          { kind: "completed" },
          reaction(undefined),
          identity,
        );
      }

      switch (result.kind) {
        case "temporary":
          if (usage !== undefined) usage = { ...usage, stale: true };
          return {
            beforeDirective: reaction(usageStatus()),
            directive: {
              kind: "temporary-failure" as const,
              retryAtMs: result.retryAtMs,
            },
            afterDirective: reaction(undefined),
          };
        case "authentication-unavailable":
          return planWithAfter({ kind: "completed" }, clearUsage(true));
        case "terminal":
          return planWithAfter({ kind: "terminal" }, clearUsage(true));
      }
    });

  return {
    prepareRefresh: (context) =>
      Effect.gen(function* () {
        const identity = yield* context.resolveIdentity(
          dependencies.resolveCredentialIdentity.pipe(
            Effect.flatMap((resolution) => applyIdentity(resolution, context)),
          ),
        );
        if (!identity.available) {
          return {
            kind: "skip",
            schedule: identity.schedule,
            reaction: identity.reaction,
          };
        }
        return {
          kind: "ready",
          schedule: identity.schedule,
          reaction: identity.reaction,
          execute: acquire(identity.fingerprint, context),
        };
      }),
    observeActivity: (now) =>
      Effect.sync(() =>
        reaction(
          undefined,
          usage === undefined ||
            now - usage.capturedAtMs >= REFRESH_DEBOUNCE_MS,
        ),
      ),
    staleExpirationReached: (deadline) =>
      Effect.sync(() => {
        if (!usage?.stale || staleExpirationAtMs() !== deadline) {
          return reaction(undefined);
        }
        usage = undefined;
        return reaction({ kind: "unavailable" });
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
