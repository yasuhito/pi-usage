import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
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

/** Presentation and observation demand produced by one provider event. */
export interface WeeklySubscriptionUsageChange {
  readonly publication: WeeklySubscriptionUsageStatus | undefined;
  readonly staleExpiration: ProviderStaleExpiration;
  readonly acquire: boolean;
}

export type ProviderCredentialContinuity =
  | "unchanged"
  | "changed"
  | "unavailable";

export type ProviderCredentialInspection<Credential> =
  | {
      readonly continuity: "unavailable";
      readonly credential: undefined;
      readonly change: WeeklySubscriptionUsageChange;
    }
  | {
      readonly continuity: "unchanged" | "changed";
      readonly credential: Credential;
      readonly change: WeeklySubscriptionUsageChange;
    };

export type ClassifiedProviderAcquisitionExit<A, E> =
  | { readonly kind: "acquired"; readonly value: A }
  | { readonly kind: "failed"; readonly error: E }
  | { readonly kind: "interrupted" }
  | { readonly kind: "defect"; readonly cause: Cause.Cause<never> };

export function classifyProviderAcquisitionExit<A, E>(
  exit: Exit.Exit<A, E>,
): ClassifiedProviderAcquisitionExit<A, E> {
  if (Exit.isSuccess(exit)) return { kind: "acquired", value: exit.value };
  if (Cause.isInterruptedOnly(exit.cause)) return { kind: "interrupted" };
  const defects = Cause.keepDefects(exit.cause);
  if (defects._tag === "Some") {
    return { kind: "defect", cause: defects.value };
  }
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some"
    ? { kind: "failed", error: failure.value }
    : { kind: "interrupted" };
}

export type ProviderAcquisitionDisposition =
  | { readonly kind: "completed" }
  | { readonly kind: "retry"; readonly retryAtMs: number | undefined }
  | { readonly kind: "terminal" }
  | { readonly kind: "defect"; readonly cause: Cause.Cause<never> };

export interface ProviderAcquisitionCompletion {
  /** Changes are committed in provider-domain order before disposition. */
  readonly changes: ReadonlyArray<WeeklySubscriptionUsageChange>;
  readonly disposition: ProviderAcquisitionDisposition;
  readonly continuity?: ProviderCredentialContinuity;
}

export function providerAcquisitionDefect(
  cause: Cause.Cause<never>,
): ProviderAcquisitionCompletion {
  return {
    changes: [
      {
        publication: { kind: "unavailable" },
        staleExpiration: { kind: "clear" },
        acquire: false,
      },
    ],
    disposition: { kind: "defect", cause },
  };
}

export interface ProviderMonitorContext {
  /** True only while the owning refresh generation may commit provider state. */
  readonly isCurrent: Effect.Effect<boolean>;
  /** Suppresses passive observations caused by credential resolution. */
  readonly withoutPassiveObservation: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export type ProviderAcquisitionInspection =
  | {
      readonly kind: "blocked";
      readonly continuity: "unavailable";
      readonly change: WeeklySubscriptionUsageChange;
    }
  | {
      readonly kind: "ready";
      readonly continuity: "unchanged" | "changed";
      readonly change: WeeklySubscriptionUsageChange;
      readonly acquire: Effect.Effect<ProviderAcquisitionCompletion>;
      readonly acquisitionDeferred?: Effect.Effect<WeeklySubscriptionUsageChange>;
    };

/** Provider-specific policy at the acquisition seam. */
export interface ProviderMonitorAdapter {
  readonly inspectAcquisition: (
    context: ProviderMonitorContext,
  ) => Effect.Effect<ProviderAcquisitionInspection>;
  readonly observeResponse?: (
    fields: Readonly<Record<string, unknown>>,
    nowMs: number,
  ) => Effect.Effect<WeeklySubscriptionUsageChange>;
  readonly observeActivity: (
    nowMs: number,
  ) => Effect.Effect<WeeklySubscriptionUsageChange>;
  readonly staleExpirationReached: (
    deadlineMs: number,
    nowMs: number,
  ) => Effect.Effect<WeeklySubscriptionUsageChange>;
  readonly finalize: Effect.Effect<void>;
}

interface ProviderMonitorDependencies {
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly pollIntervalMs?: number;
  readonly random?: Effect.Effect<number>;
}

const emptyChange = (): WeeklySubscriptionUsageChange => ({
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
    let acquisitionDemanded = false;
    let observationSuppressionsInFlight = 0;
    let accountChangeRefreshesInFlight = 0;
    type RefreshMode = "ordinary" | "account-change";

    let triggerRefresh: (
      mode: RefreshMode,
    ) => Effect.Effect<Fiber.RuntimeFiber<void> | undefined> = () =>
      Effect.succeed(undefined);
    let refresh: (mode: RefreshMode) => Effect.Effect<void> = () => Effect.void;
    let drainAcquisitionDemand: Effect.Effect<void> = Effect.void;

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

    const applyContinuity = (continuity: ProviderCredentialContinuity) => {
      if (continuity === "changed") return resetSchedule;
      if (continuity === "unavailable") return interruptRetry;
      return Effect.void;
    };

    const applyChange = (
      change: WeeklySubscriptionUsageChange,
      generationSnapshot: number,
      followUpDemand = false,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;

        const requestedDeadline =
          change.staleExpiration.kind === "preserve"
            ? staleDeadline
            : change.staleExpiration.kind === "arm"
              ? change.staleExpiration.atMs
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
              const expirationChange = yield* adapter.staleExpirationReached(
                deadline,
                atExpiration,
              );
              yield* applyChange(expirationChange, refreshGeneration);
              yield* drainAcquisitionDemand;
            }),
            scope,
          );
          staleFiber = staleExpirationFiber;
        }

        if (change.publication !== undefined) {
          yield* dependencies.publish(change.publication);
        }
        if (
          change.acquire &&
          isCurrent(generationSnapshot) &&
          (followUpDemand || activeRefreshFiber === undefined)
        ) {
          acquisitionDemanded = true;
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

    const applyDisposition = (
      disposition: ProviderAcquisitionDisposition,
      generationSnapshot: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        if (disposition.kind === "defect") {
          return yield* Effect.failCause(disposition.cause);
        }
        const now = yield* Clock.currentTimeMillis;
        if (disposition.kind === "retry") {
          terminal = false;
          consecutiveFailures += 1;
          if (
            disposition.retryAtMs !== undefined &&
            Number.isFinite(disposition.retryAtMs) &&
            disposition.retryAtMs > now
          ) {
            nextAttemptAt = disposition.retryAtMs;
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
        terminal = disposition.kind === "terminal";
      });

    const applyCompletion = (
      completion: ProviderAcquisitionCompletion,
      generationSnapshot: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        for (const change of completion.changes) {
          yield* applyChange(change, generationSnapshot, true);
        }
        if (completion.continuity !== undefined) {
          yield* applyContinuity(completion.continuity);
        }
        if (completion.continuity !== "unavailable") {
          yield* applyDisposition(completion.disposition, generationSnapshot);
        }
      });

    const performRefresh = (generationSnapshot: number, mode: RefreshMode) =>
      Effect.gen(function* () {
        const context: ProviderMonitorContext = {
          isCurrent: Effect.sync(() => isCurrent(generationSnapshot)),
          withoutPassiveObservation: (effect) =>
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
        const inspection = yield* adapter.inspectAcquisition(context);
        if (!isCurrent(generationSnapshot)) return;
        yield* applyContinuity(inspection.continuity);
        yield* applyChange(inspection.change, generationSnapshot);
        if (inspection.kind === "blocked") return;
        if (terminal && mode === "ordinary") return;
        const now = yield* Clock.currentTimeMillis;
        if (mode === "ordinary" && now < nextAttemptAt) {
          if (inspection.acquisitionDeferred !== undefined) {
            const change = yield* inspection.acquisitionDeferred;
            yield* applyChange(change, generationSnapshot);
          }
          return;
        }

        const completion = yield* inspection.acquire;
        yield* applyCompletion(completion, generationSnapshot);
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
                Effect.gen(function* () {
                  if (mode === "account-change")
                    accountChangeRefreshesInFlight -= 1;
                  if (activeRefreshFiber === refreshFiber)
                    activeRefreshFiber = undefined;
                  yield* drainAcquisitionDemand;
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
        if (fiber !== undefined) yield* Fiber.join(fiber);
      });

    drainAcquisitionDemand = Effect.suspend(() => {
      if (!acquisitionDemanded || activeRefreshFiber !== undefined) {
        return Effect.void;
      }
      acquisitionDemanded = false;
      return refresh("ordinary");
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        refreshGeneration += 1;
        activeRefreshFiber = undefined;
        retryFiber = undefined;
        staleFiber = undefined;
        staleDeadline = undefined;
        acquisitionDemanded = false;
        observationSuppressionsInFlight = 0;
        accountChangeRefreshesInFlight = 0;
        yield* adapter.finalize;
      }),
    );

    yield* Effect.forkIn(
      Stream.tick(dependencies.pollIntervalMs ?? POLL_INTERVAL_MS).pipe(
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
            const change = yield* adapter.observeResponse(fields, now);
            yield* applyChange(change, generationSnapshot);
            yield* drainAcquisitionDemand;
          });
        }),
      refreshAfterActivity: Effect.gen(function* () {
        const generationSnapshot = refreshGeneration;
        const now = yield* Clock.currentTimeMillis;
        const change = yield* adapter.observeActivity(now);
        yield* applyChange(change, generationSnapshot);
        yield* drainAcquisitionDemand;
      }),
      refreshForAccountChange: refresh("account-change"),
    } satisfies ProviderMonitor;
  });
}

export const noWeeklySubscriptionUsageChange = emptyChange;
