import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  Random,
  type Scope,
  Stream,
} from "effect";

import type {
  AcquireDedicatedWeeklyQuotaUsage,
  AcquiredWeeklyQuotaUsage,
  CodexCredential,
  DedicatedWeeklyQuotaAcquisitionError,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "./presentation.ts";
import {
  type ProviderMonitor,
  ProviderMonitorService,
} from "./provider-monitor.ts";
import {
  createWeeklyQuotaObservationReconciliation,
  type WeeklyQuotaObservationReaction,
} from "./weekly-quota-observation-reconciliation.ts";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const POLL_INTERVAL_MS = 60_000;

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

/**
 * Builds one deep Codex monitor in the caller's session Scope. All requests,
 * sleeps, polling, and stale-expiration fibers are children of that Scope.
 */
export function makeCodexProviderMonitor(
  dependencies: CodexProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const gate = yield* Effect.makeSemaphore(1);
    const reconciliation = createWeeklyQuotaObservationReconciliation();
    let generation = 0;
    let active: Fiber.RuntimeFiber<void> | undefined;
    let staleFiber: Fiber.RuntimeFiber<void> | undefined;
    let retryFiber: Fiber.RuntimeFiber<void> | undefined;
    let staleDeadline: number | undefined;
    let credentialAvailable = false;
    let terminal = false;
    let currentAccountId: string | undefined;
    let resolvingAccounts = 0;
    let accountChangesInFlight = 0;
    let nextAttemptAt = 0;
    let consecutiveFailures = 0;
    let triggerRefresh: (
      forced: boolean,
    ) => Effect.Effect<Fiber.RuntimeFiber<void> | undefined> = () =>
      Effect.succeed(undefined);
    let refresh: (forced: boolean) => Effect.Effect<void> = () => Effect.void;

    const isCurrent = (candidate: number) => candidate === generation;

    const interruptRetry = Effect.suspend(() => {
      const fiber = retryFiber;
      retryFiber = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

    const publishReaction = (
      reaction: WeeklyQuotaObservationReaction,
      candidate: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCurrent(candidate)) return;

        if (reaction.staleExpirationAtMs !== staleDeadline) {
          if (staleFiber !== undefined) yield* Fiber.interrupt(staleFiber);
          staleFiber = undefined;
          staleDeadline = reaction.staleExpirationAtMs;
        }
        if (
          reaction.staleExpirationAtMs !== undefined &&
          staleFiber === undefined
        ) {
          const deadline = reaction.staleExpirationAtMs;
          staleFiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.sleep(Math.max(0, deadline - now));
              staleFiber = undefined;
              staleDeadline = undefined;
              const atExpiration = yield* Clock.currentTimeMillis;
              yield* publishReaction(
                reconciliation.advance(
                  { kind: "stale-usage-expiration-reached" },
                  atExpiration,
                ),
                generation,
              );
            }),
            scope,
          );
        }

        if (reaction.publication !== "replace") return;
        if (reaction.observation.kind === "none") {
          yield* dependencies.publish({ kind: "unavailable" });
        } else {
          const usage = reaction.observation.usage;
          yield* dependencies.publish({
            kind: "available",
            usedPercent: usage.usedPercent,
            stale: reaction.observation.freshness === "stale",
            weeklyWindowResetsAtMs: usage.resetsAtMs,
            ...(usage.availableLimitResetCredits === undefined
              ? {}
              : {
                  availableLimitResetCredits: usage.availableLimitResetCredits,
                }),
          });
        }
      });

    const invalidateAccount = (candidate: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const reaction = reconciliation.advance(
          { kind: "account-selection-invalidated" },
          now,
        );
        yield* publishReaction(reaction, candidate);
        return reaction.publication === "replace";
      });

    const applyCredential = (
      resolution: CodexCredentialResolution,
      candidate: number,
    ): Effect.Effect<CodexCredential | undefined> =>
      Effect.gen(function* () {
        if (!isCurrent(candidate)) return undefined;
        if (resolution.kind === "missing") {
          credentialAvailable = false;
          terminal = false;
          currentAccountId = undefined;
          yield* interruptRetry;
          const removedUsage = yield* invalidateAccount(candidate);
          if (!removedUsage) {
            yield* dependencies.publish({ kind: "unavailable" });
          }
          return undefined;
        }
        if (resolution.kind === "invalid") {
          credentialAvailable = true;
          terminal = false;
          currentAccountId = undefined;
          nextAttemptAt = 0;
          consecutiveFailures = 0;
          yield* interruptRetry;
          const removedUsage = yield* invalidateAccount(candidate);
          if (!removedUsage) {
            yield* dependencies.publish({ kind: "unavailable" });
          }
          return undefined;
        }
        credentialAvailable = true;
        if (currentAccountId !== resolution.credential.accountId) {
          currentAccountId = resolution.credential.accountId;
          terminal = false;
          nextAttemptAt = 0;
          consecutiveFailures = 0;
          yield* interruptRetry;
          yield* invalidateAccount(candidate);
        }
        return resolution.credential;
      });

    const resolve = (candidate: number) =>
      Effect.gen(function* () {
        resolvingAccounts += 1;
        const resolution = yield* dependencies.resolveCredential.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              resolvingAccounts -= 1;
            }),
          ),
        );
        return yield* applyCredential(resolution, candidate);
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

    const applyResult = (
      result: DedicatedWeeklyQuotaAcquisitionResult,
      candidate: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(candidate)) return;
        const now = yield* Clock.currentTimeMillis;
        terminal = result.kind === "permanently-unavailable";
        if (result.kind === "temporary-failure") {
          consecutiveFailures += 1;
          if (
            result.retryAtMs !== undefined &&
            Number.isFinite(result.retryAtMs) &&
            result.retryAtMs > now
          ) {
            nextAttemptAt = result.retryAtMs;
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
          yield* scheduleRetry(candidate, now);
        } else {
          nextAttemptAt = 0;
          consecutiveFailures = 0;
          yield* interruptRetry;
        }
        yield* publishReaction(
          reconciliation.advance(
            { kind: "dedicated-weekly-quota-acquisition", result },
            now,
          ),
          candidate,
        );
      });

    const performRefresh = (candidate: number, ignoreBackoff: boolean) =>
      Effect.gen(function* () {
        let credential = yield* resolve(candidate);
        if (
          credential === undefined ||
          !isCurrent(candidate) ||
          (terminal && !ignoreBackoff)
        )
          return;
        const now = yield* Clock.currentTimeMillis;
        if (!ignoreBackoff && now < nextAttemptAt) {
          yield* publishReaction(
            reconciliation.advance(
              { kind: "dedicated-weekly-quota-acquisition-deferred" },
              now,
            ),
            candidate,
          );
          return;
        }

        let result = acquisitionResultFromExit(
          yield* Effect.exit(
            dependencies.acquireDedicatedWeeklyQuotaUsage(credential),
          ),
        );
        if (result === undefined || !isCurrent(candidate)) return;
        if (result.kind === "authentication-rejected") {
          credential = yield* resolve(candidate);
          if (credential === undefined || !isCurrent(candidate)) return;
          result = acquisitionResultFromExit(
            yield* Effect.exit(
              dependencies.acquireDedicatedWeeklyQuotaUsage(credential),
            ),
          );
          if (result === undefined || !isCurrent(candidate)) return;
        }
        yield* applyResult(result, candidate);
      });

    triggerRefresh = (forced: boolean) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (!forced && active !== undefined) return undefined;
          if (forced) {
            generation += 1;
            yield* interruptRetry;
            if (active !== undefined) yield* Fiber.interrupt(active);
          }
          const candidate = generation;
          if (forced) accountChangesInFlight += 1;
          const refreshEffect = performRefresh(candidate, forced).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (forced) accountChangesInFlight -= 1;
              }),
            ),
          );
          const created = yield* Effect.forkIn(
            refreshEffect.pipe(
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

    refresh = (forced: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* triggerRefresh(forced);
        if (fiber !== undefined) yield* Fiber.await(fiber);
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        generation += 1;
        credentialAvailable = false;
        terminal = false;
        active = undefined;
        staleFiber = undefined;
        retryFiber = undefined;
        staleDeadline = undefined;
      }),
    );

    yield* Effect.forkIn(
      Stream.tick(POLL_INTERVAL_MS).pipe(
        Stream.drop(1),
        Stream.runForEach(() =>
          Effect.suspend(() => triggerRefresh(false)).pipe(Effect.asVoid),
        ),
        Effect.asVoid,
      ),
      scope,
    );

    return {
      start: dependencies
        .publish({ kind: "loading" })
        .pipe(Effect.andThen(refresh(false))),
      observeResponse: (fields) =>
        Effect.gen(function* () {
          if (
            !credentialAvailable ||
            resolvingAccounts > 0 ||
            accountChangesInFlight > 0
          )
            return;
          const now = yield* Clock.currentTimeMillis;
          const candidate = generation;
          const reaction = reconciliation.advance(
            { kind: "passive-weekly-quota-observation", fields },
            now,
          );
          yield* publishReaction(reaction, candidate);
          if (reaction.acquireDedicated) yield* refresh(false);
        }),
      refreshAfterActivity: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const reaction = reconciliation.advance({ kind: "activity" }, now);
        yield* publishReaction(reaction, generation);
        if (reaction.acquireDedicated) yield* refresh(false);
      }),
      refreshForAccountChange: refresh(true),
    } satisfies ProviderMonitor;
  });
}

/** A session-scoped Layer that hides Codex acquisition and reconciliation. */
export const codexProviderMonitorLayer = (
  dependencies: CodexProviderMonitorDependencies,
) =>
  Layer.scoped(ProviderMonitorService, makeCodexProviderMonitor(dependencies));
