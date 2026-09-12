import {
  Clock,
  Context,
  Effect,
  Fiber,
  Random,
  type Scope,
  Stream,
} from "effect";

import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const POLL_INTERVAL_MS = 60_000;

/** The complete session-scoped interface exposed to the Pi adapter. */
export interface ProviderMonitor {
  readonly start: Effect.Effect<void>;
  readonly observeResponse: (
    fields: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly refreshAfterActivity: Effect.Effect<void>;
  readonly refreshForAccountChange: Effect.Effect<void>;
}

export class ProviderMonitorService extends Context.Tag("ProviderMonitor")<
  ProviderMonitorService,
  ProviderMonitor
>() {}

type ProviderStaleExpiration =
  | { readonly kind: "preserve" }
  | { readonly kind: "clear" }
  | { readonly kind: "arm"; readonly atMs: number };

export interface ProviderMonitorReaction {
  readonly publication: WeeklySubscriptionUsageStatus | undefined;
  readonly staleExpiration: ProviderStaleExpiration;
  readonly acquire: boolean;
}

type ProviderScheduleDirective =
  | { readonly kind: "completed" }
  | {
      readonly kind: "temporary-failure";
      readonly retryAtMs: number | undefined;
    }
  | { readonly kind: "terminal" };

export interface ProviderRefreshPlan {
  readonly transition?: ProviderMonitorTransition;
  readonly beforeDirective: ProviderMonitorReaction;
  readonly directive: ProviderScheduleDirective;
  readonly afterDirective: ProviderMonitorReaction;
}

type ProviderRefreshExecution =
  | ProviderRefreshPlan
  | {
      readonly kind: "stop";
      readonly transition: ProviderMonitorTransition;
    }
  | {
      readonly kind: "continue";
      readonly transition: ProviderMonitorTransition;
      readonly execute: Effect.Effect<ProviderRefreshExecution>;
    };

export interface ProviderMonitorTransition {
  readonly schedule: "preserve" | "reset" | "pause-retry";
  readonly reaction: ProviderMonitorReaction;
}

export interface ProviderRefreshContext {
  readonly isCurrent: Effect.Effect<boolean>;
  readonly resolveIdentity: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

type PreparedProviderRefresh = ProviderMonitorTransition &
  (
    | { readonly kind: "skip" }
    | {
        readonly kind: "ready";
        readonly execute: Effect.Effect<ProviderRefreshExecution>;
      }
  );

/** Provider-specific policy at the scheduling seam. */
export interface ProviderMonitorAdapter {
  readonly prepareRefresh: (
    context: ProviderRefreshContext,
  ) => Effect.Effect<PreparedProviderRefresh>;
  readonly observeResponse?: (
    fields: Readonly<Record<string, unknown>>,
    nowMs: number,
  ) => Effect.Effect<ProviderMonitorReaction>;
  readonly observeActivity: (
    nowMs: number,
  ) => Effect.Effect<ProviderMonitorReaction>;
  readonly acquisitionDeferred?: (
    nowMs: number,
  ) => Effect.Effect<ProviderMonitorReaction>;
  readonly staleExpirationReached: (
    deadlineMs: number,
    nowMs: number,
  ) => Effect.Effect<ProviderMonitorReaction>;
  readonly finalize: Effect.Effect<void>;
}

interface ProviderMonitorDependencies {
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

const emptyReaction = (): ProviderMonitorReaction => ({
  publication: undefined,
  staleExpiration: { kind: "preserve" },
  acquire: false,
});

/**
 * Builds one deep provider monitor in the caller's session Scope. Polling,
 * retry, supersession, stale expiration, and cleanup stay behind this seam.
 */
export function makeProviderMonitor(
  adapter: ProviderMonitorAdapter,
  dependencies: ProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const gate = yield* Effect.makeSemaphore(1);
    let refreshGeneration = 0;
    let activeRefreshFiber: Fiber.RuntimeFiber<void> | undefined;
    let retryFiber: Fiber.RuntimeFiber<void> | undefined;
    let staleFiber: Fiber.RuntimeFiber<void> | undefined;
    let staleDeadline: number | undefined;
    let nextAttemptAt = 0;
    let consecutiveFailures = 0;
    let terminal = false;
    let observationSuppressionsInFlight = 0;
    type RefreshMode = "ordinary" | "account-change";

    let accountChangeRefreshesInFlight = 0;
    let triggerRefresh: (
      mode: RefreshMode,
    ) => Effect.Effect<Fiber.RuntimeFiber<void> | undefined> = () =>
      Effect.succeed(undefined);
    let refresh: (mode: RefreshMode) => Effect.Effect<void> = () => Effect.void;

    const isCurrent = (generationSnapshot: number) =>
      generationSnapshot === refreshGeneration;

    const interruptRetry = Effect.suspend(() => {
      const fiber = retryFiber;
      retryFiber = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

    const resetSchedule = Effect.gen(function* () {
      terminal = false;
      nextAttemptAt = 0;
      consecutiveFailures = 0;
      yield* interruptRetry;
    });

    const applyReaction = (
      reaction: ProviderMonitorReaction,
      generationSnapshot: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;

        const requestedDeadline =
          reaction.staleExpiration.kind === "preserve"
            ? staleDeadline
            : reaction.staleExpiration.kind === "arm"
              ? reaction.staleExpiration.atMs
              : undefined;
        if (requestedDeadline !== staleDeadline) {
          if (staleFiber !== undefined) yield* Fiber.interrupt(staleFiber);
          staleFiber = undefined;
          staleDeadline = requestedDeadline;
        }
        if (
          requestedDeadline !== undefined &&
          staleDeadline === requestedDeadline &&
          staleFiber === undefined &&
          isCurrent(generationSnapshot)
        ) {
          const deadline = requestedDeadline;
          const staleExpirationFiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.sleep(Math.max(0, deadline - now));
              if (
                staleDeadline !== deadline ||
                staleFiber !== staleExpirationFiber
              )
                return;
              staleFiber = undefined;
              staleDeadline = undefined;
              const atExpiration = yield* Clock.currentTimeMillis;
              const expirationReaction = yield* adapter.staleExpirationReached(
                deadline,
                atExpiration,
              );
              yield* applyReaction(expirationReaction, refreshGeneration);
            }),
            scope,
          );
          staleFiber = staleExpirationFiber;
        }

        if (reaction.publication !== undefined) {
          yield* dependencies.publish(reaction.publication);
        }
        if (reaction.acquire && isCurrent(generationSnapshot)) {
          yield* refresh("ordinary");
        }
      });

    const scheduleRetry = (generationSnapshot: number, now: number) =>
      Effect.gen(function* () {
        yield* interruptRetry;
        retryFiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, nextAttemptAt - now));
            retryFiber = undefined;
            if (isCurrent(generationSnapshot)) yield* refresh("ordinary");
          }),
          scope,
        );
      });

    const applyDirective = (
      directive: ProviderScheduleDirective,
      generationSnapshot: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        const now = yield* Clock.currentTimeMillis;
        if (directive.kind === "temporary-failure") {
          terminal = false;
          consecutiveFailures += 1;
          if (
            directive.retryAtMs !== undefined &&
            Number.isFinite(directive.retryAtMs) &&
            directive.retryAtMs > now
          ) {
            nextAttemptAt = directive.retryAtMs;
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
          yield* scheduleRetry(generationSnapshot, now);
          return;
        }
        yield* resetSchedule;
        terminal = directive.kind === "terminal";
      });

    const applyTransition = (
      transition: ProviderMonitorTransition,
      generationSnapshot: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        switch (transition.schedule) {
          case "preserve":
            break;
          case "reset":
            yield* resetSchedule;
            break;
          case "pause-retry":
            terminal = false;
            yield* interruptRetry;
            break;
        }
        yield* applyReaction(transition.reaction, generationSnapshot);
      });

    const applyExecution = (
      executionEffect: Effect.Effect<ProviderRefreshExecution>,
      generationSnapshot: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const execution = yield* executionEffect;
        if (!isCurrent(generationSnapshot)) return;
        if ("kind" in execution) {
          yield* applyTransition(execution.transition, generationSnapshot);
          if (execution.kind === "continue" && isCurrent(generationSnapshot)) {
            yield* applyExecution(execution.execute, generationSnapshot);
          }
          return;
        }
        if (execution.transition !== undefined) {
          yield* applyTransition(execution.transition, generationSnapshot);
        }
        yield* applyReaction(execution.beforeDirective, generationSnapshot);
        yield* applyDirective(execution.directive, generationSnapshot);
        yield* applyReaction(execution.afterDirective, generationSnapshot);
      });

    const performRefresh = (generationSnapshot: number, mode: RefreshMode) =>
      Effect.gen(function* () {
        const context: ProviderRefreshContext = {
          isCurrent: Effect.sync(() => isCurrent(generationSnapshot)),
          resolveIdentity: (effect) =>
            Effect.suspend(() => {
              observationSuppressionsInFlight += 1;
              return effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    observationSuppressionsInFlight -= 1;
                  }),
                ),
              );
            }),
        };
        const prepared = yield* adapter.prepareRefresh(context);
        if (!isCurrent(generationSnapshot)) return;
        yield* applyTransition(prepared, generationSnapshot);
        if (prepared.kind === "skip" || !isCurrent(generationSnapshot)) return;
        if (terminal && mode === "ordinary") return;
        const now = yield* Clock.currentTimeMillis;
        if (mode === "ordinary" && now < nextAttemptAt) {
          if (adapter.acquisitionDeferred !== undefined) {
            const reaction = yield* adapter.acquisitionDeferred(now);
            yield* applyReaction(reaction, generationSnapshot);
          }
          return;
        }

        yield* applyExecution(prepared.execute, generationSnapshot);
      });

    triggerRefresh = (mode: RefreshMode) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (mode === "ordinary" && activeRefreshFiber !== undefined)
            return undefined;
          if (mode === "account-change") {
            refreshGeneration += 1;
            yield* interruptRetry;
            if (activeRefreshFiber !== undefined)
              yield* Fiber.interrupt(activeRefreshFiber);
          }
          const generationSnapshot = refreshGeneration;
          if (mode === "account-change") accountChangeRefreshesInFlight += 1;
          const refreshFiber = yield* Effect.forkIn(
            performRefresh(generationSnapshot, mode).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (mode === "account-change")
                    accountChangeRefreshesInFlight -= 1;
                  if (activeRefreshFiber === refreshFiber)
                    activeRefreshFiber = undefined;
                }),
              ),
            ),
            scope,
          );
          activeRefreshFiber = refreshFiber;
          return refreshFiber;
        }),
      );

    refresh = (mode: RefreshMode) =>
      Effect.gen(function* () {
        const fiber = yield* triggerRefresh(mode);
        if (fiber !== undefined) yield* Fiber.await(fiber);
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        refreshGeneration += 1;
        activeRefreshFiber = undefined;
        retryFiber = undefined;
        staleFiber = undefined;
        staleDeadline = undefined;
        observationSuppressionsInFlight = 0;
        accountChangeRefreshesInFlight = 0;
        yield* adapter.finalize;
      }),
    );

    yield* Effect.forkIn(
      Stream.tick(POLL_INTERVAL_MS).pipe(
        Stream.drop(1),
        Stream.runForEach(() =>
          Effect.suspend(() => triggerRefresh("ordinary")).pipe(Effect.asVoid),
        ),
        Effect.asVoid,
      ),
      scope,
    );

    return {
      start: dependencies
        .publish({ kind: "loading" })
        .pipe(Effect.andThen(refresh("ordinary"))),
      observeResponse: (fields) =>
        Effect.suspend(() => {
          if (
            observationSuppressionsInFlight > 0 ||
            accountChangeRefreshesInFlight > 0
          ) {
            return Effect.void;
          }
          const generationSnapshot = refreshGeneration;
          return Effect.gen(function* () {
            if (adapter.observeResponse === undefined) return;
            const now = yield* Clock.currentTimeMillis;
            const reaction = yield* adapter.observeResponse(fields, now);
            yield* applyReaction(reaction, generationSnapshot);
          });
        }),
      refreshAfterActivity: Effect.gen(function* () {
        const generationSnapshot = refreshGeneration;
        const now = yield* Clock.currentTimeMillis;
        const reaction = yield* adapter.observeActivity(now);
        yield* applyReaction(reaction, generationSnapshot);
      }),
      refreshForAccountChange: refresh("account-change"),
    } satisfies ProviderMonitor;
  });
}

export const noProviderMonitorReaction = emptyReaction;
