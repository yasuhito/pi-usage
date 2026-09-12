import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Random,
  type Scope,
  Stream,
} from "effect";
import type {
  AcquireClaudeSubscriptionUsage,
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError,
} from "./claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import type { ProviderMonitor } from "./provider-monitor.ts";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const POLL_INTERVAL_MS = 60_000;
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
      return {
        kind: "temporary",
        retryAtMs: failure.value.retryAtMs,
      };
    case "MalformedClaudeSubscriptionUsage":
      return { kind: "temporary", retryAtMs: undefined };
    case "ClaudeAuthenticationUnavailable":
    case "ClaudeAuthenticationRejected":
      return { kind: "authentication-unavailable" };
    case "PermanentClaudeSubscriptionUsageFailure":
      return { kind: "terminal" };
  }
}

/** Builds one session-scoped monitor for direct Claude subscription usage. */
export function makeClaudeProviderMonitor(
  dependencies: ClaudeProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const gate = yield* Effect.makeSemaphore(1);
    let generation = 0;
    let active: Fiber.RuntimeFiber<void> | undefined;
    let staleFiber: Fiber.RuntimeFiber<void> | undefined;
    let retryFiber: Fiber.RuntimeFiber<void> | undefined;
    let identityFingerprint: string | undefined;
    let terminal = false;
    let usage: CapturedUsage | undefined;
    let nextAttemptAt = 0;
    let consecutiveFailures = 0;
    let refresh: (forced: boolean) => Effect.Effect<void> = () => Effect.void;

    const isCurrent = (candidate: number) => generation === candidate;

    const interruptStaleTimer = Effect.suspend(() => {
      const fiber = staleFiber;
      staleFiber = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

    const interruptRetry = Effect.suspend(() => {
      const fiber = retryFiber;
      retryFiber = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

    const publishUsage = (candidate: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (!isCurrent(candidate)) return Effect.void;
        if (usage === undefined) {
          return dependencies.publish({ kind: "unavailable" });
        }
        return dependencies.publish({
          kind: "available",
          usedPercent: usage.usage.usedPercent,
          stale: usage.stale,
          weeklyWindowResetsAtMs: usage.usage.resetsAtMs,
        });
      });

    const clearUsage = (candidate: number, publish: boolean) =>
      Effect.gen(function* () {
        const hadUsage = usage !== undefined;
        usage = undefined;
        yield* interruptStaleTimer;
        if (publish && (hadUsage || isCurrent(candidate))) {
          yield* publishUsage(candidate);
        }
      });

    const armStaleExpiration = (candidate: number) =>
      Effect.gen(function* () {
        yield* interruptStaleTimer;
        if (usage === undefined || !usage.stale) return;
        const deadline = Math.min(
          usage.capturedAtMs + STALE_AFTER_MS,
          usage.usage.resetsAtMs,
        );
        const now = yield* Clock.currentTimeMillis;
        if (deadline <= now) {
          yield* clearUsage(candidate, true);
          return;
        }
        staleFiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* Effect.sleep(deadline - now);
            staleFiber = undefined;
            usage = undefined;
            yield* publishUsage(generation);
          }),
          scope,
        );
      });

    const applyIdentity = (
      resolution: ClaudeCredentialIdentityResolution,
      candidate: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(candidate)) return false;
        if (resolution.kind === "missing") {
          identityFingerprint = undefined;
          terminal = false;
          nextAttemptAt = 0;
          consecutiveFailures = 0;
          yield* interruptRetry;
          yield* clearUsage(candidate, true);
          return false;
        }
        if (identityFingerprint !== resolution.fingerprint) {
          const replacingUsage = usage !== undefined;
          identityFingerprint = resolution.fingerprint;
          terminal = false;
          nextAttemptAt = 0;
          consecutiveFailures = 0;
          yield* interruptRetry;
          yield* clearUsage(candidate, replacingUsage);
        }
        return true;
      });

    const scheduleRetry = (candidate: number, now: number) =>
      Effect.gen(function* () {
        yield* interruptRetry;
        retryFiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, nextAttemptAt - now));
            retryFiber = undefined;
            if (isCurrent(candidate)) yield* refresh(false);
          }),
          scope,
        );
      });

    const applyResult = (result: AcquisitionResult, candidate: number) =>
      Effect.gen(function* () {
        if (!isCurrent(candidate)) return;
        const now = yield* Clock.currentTimeMillis;
        switch (result.kind) {
          case "acquired":
            terminal = false;
            nextAttemptAt = 0;
            consecutiveFailures = 0;
            yield* interruptRetry;
            yield* interruptStaleTimer;
            usage = { usage: result.usage, capturedAtMs: now, stale: false };
            yield* publishUsage(candidate);
            return;
          case "temporary": {
            terminal = false;
            consecutiveFailures += 1;
            const instructed = result.retryAtMs;
            if (
              instructed !== undefined &&
              Number.isFinite(instructed) &&
              instructed > now
            ) {
              nextAttemptAt = instructed;
            } else {
              const base = Math.min(
                MAX_BACKOFF_MS,
                INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
              );
              const random = yield* dependencies.random ?? Random.next;
              const delay = Math.min(
                MAX_BACKOFF_MS,
                Math.max(INITIAL_BACKOFF_MS, base * (0.5 + random)),
              );
              nextAttemptAt = now + delay;
            }
            if (usage !== undefined) usage = { ...usage, stale: true };
            yield* publishUsage(candidate);
            yield* armStaleExpiration(candidate);
            yield* scheduleRetry(candidate, now);
            return;
          }
          case "authentication-unavailable":
            terminal = false;
            nextAttemptAt = 0;
            consecutiveFailures = 0;
            yield* interruptRetry;
            yield* clearUsage(candidate, true);
            return;
          case "terminal":
            terminal = true;
            nextAttemptAt = 0;
            consecutiveFailures = 0;
            yield* interruptRetry;
            yield* clearUsage(candidate, true);
            return;
        }
      });

    const performRefresh = (candidate: number, forced: boolean) =>
      Effect.gen(function* () {
        const resolution = yield* dependencies.resolveCredentialIdentity;
        if (!(yield* applyIdentity(resolution, candidate))) return;
        if (!isCurrent(candidate) || (terminal && !forced)) return;
        const now = yield* Clock.currentTimeMillis;
        if (!forced && now < nextAttemptAt) return;
        if (resolution.kind !== "available") return;
        const acquisitionIdentity = resolution.fingerprint;
        const result = acquisitionResultFromExit(
          yield* Effect.exit(dependencies.acquireClaudeSubscriptionUsage()),
        );
        if (result === undefined || !isCurrent(candidate)) return;
        const currentIdentity = yield* dependencies.resolveCredentialIdentity;
        if (
          currentIdentity.kind !== "available" ||
          currentIdentity.fingerprint !== acquisitionIdentity
        ) {
          yield* applyIdentity(currentIdentity, candidate);
          return;
        }
        yield* applyResult(result, candidate);
      });

    refresh = (forced: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* gate.withPermits(1)(
          Effect.gen(function* () {
            if (!forced && active !== undefined) return active;
            if (forced) {
              generation += 1;
              yield* interruptRetry;
              if (active !== undefined) yield* Fiber.interrupt(active);
            }
            const candidate = generation;
            const created = yield* Effect.forkIn(
              performRefresh(candidate, forced).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (active === created) active = undefined;
                  }),
                ),
              ),
              scope,
            );
            active = created;
            return created;
          }),
        );
        yield* Fiber.await(fiber);
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        generation += 1;
        active = undefined;
        staleFiber = undefined;
        retryFiber = undefined;
        identityFingerprint = undefined;
        usage = undefined;
      }),
    );

    yield* Effect.forkIn(
      Stream.repeatEffect(
        Effect.sleep(POLL_INTERVAL_MS).pipe(
          Effect.andThen(Effect.suspend(() => refresh(false))),
        ),
      ).pipe(Stream.runDrain),
      scope,
    );

    return {
      start: dependencies
        .publish({ kind: "loading" })
        .pipe(Effect.andThen(refresh(false))),
      observeResponse: () => Effect.void,
      refreshAfterActivity: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (
          usage === undefined ||
          now - usage.capturedAtMs >= REFRESH_DEBOUNCE_MS
        ) {
          yield* refresh(false);
        }
      }),
      refreshForAccountChange: refresh(true),
    } satisfies ProviderMonitor;
  });
}

export const claudeProviderMonitorLayer = (
  dependencies: ClaudeProviderMonitorDependencies,
) =>
  Layer.scoped(
    ClaudeProviderMonitorService,
    makeClaudeProviderMonitor(dependencies),
  );
