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
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** The complete session-scoped interface exposed to the Pi event adapter. */
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

export type ProviderCredentialContinuity =
  | "unchanged"
  | "changed"
  | "unavailable";

declare const providerCredentialIdentityBrand: unique symbol;

/** A stable, non-secret identity used only for credential continuity. */
export type ProviderCredentialIdentity = string & {
  readonly [providerCredentialIdentityBrand]: true;
};

export function providerCredentialIdentity(
  value: string,
): ProviderCredentialIdentity {
  return value as ProviderCredentialIdentity;
}

export type ResolvedProviderCredential<Credential> =
  | {
      readonly kind: "available";
      readonly identity: ProviderCredentialIdentity;
      readonly credential: Credential;
      readonly acceptPassiveObservation: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly acceptPassiveObservation: boolean;
    };

export type ProviderAcquisitionExit<Acquired, Failure> =
  | { readonly kind: "acquired"; readonly value: Acquired }
  | { readonly kind: "failed"; readonly error: Failure };

export type ProviderWeeklySubscriptionUsageEvent<Acquired, Failure> =
  | {
      readonly kind: "credential-observed";
      readonly continuity: ProviderCredentialContinuity;
      readonly credentialAvailable: boolean;
      readonly nowMs: number;
    }
  | {
      readonly kind: "acquisition-completed";
      readonly exit: ProviderAcquisitionExit<Acquired, Failure>;
      readonly startedIdentity: ProviderCredentialIdentity;
      readonly currentIdentity: ProviderCredentialIdentity | undefined;
      readonly authenticationRefreshUsed: boolean;
      readonly nowMs: number;
    }
  | {
      readonly kind: "passive-observation";
      readonly fields: Readonly<Record<string, unknown>>;
      readonly nowMs: number;
    }
  | { readonly kind: "activity-observed"; readonly nowMs: number }
  | { readonly kind: "acquisition-deferred"; readonly nowMs: number }
  | {
      readonly kind: "stale-expiration-reached";
      readonly deadlineMs: number;
      readonly nowMs: number;
    }
  | { readonly kind: "session-ended" };

export type ProviderPresentation =
  | { readonly kind: "preserve" }
  | {
      readonly kind: "replace";
      readonly status: WeeklySubscriptionUsageStatus;
    };

/** A provider-domain fact; only inadequate evidence creates acquisition demand. */
export type WeeklySubscriptionUsageEvidence = "adequate" | "inadequate";

/** Provider acquisition meaning, without retry or terminal scheduling work. */
export type ProviderAcquisitionHealth =
  | { readonly kind: "healthy" }
  | {
      readonly kind: "temporarily-unavailable";
      readonly providerNotBeforeMs: number | undefined;
    }
  | { readonly kind: "credential-rejected" }
  | { readonly kind: "terminal" };

export interface ProviderWeeklySubscriptionUsageFacts {
  readonly presentation: ProviderPresentation;
  readonly staleUsageExpiresAtMs: number | undefined;
  readonly observationEvidence?: WeeklySubscriptionUsageEvidence;
  readonly acquisitionHealth?: ProviderAcquisitionHealth;
}

/** Provider-specific policy at the acquisition seam. */
export interface ProviderMonitorAdapter<Credential, Acquired, Failure> {
  readonly credentialVerification: "before" | "before-and-after";
  readonly resolveCredential: Effect.Effect<
    ResolvedProviderCredential<Credential>
  >;
  readonly acquire: (
    credential: Credential,
  ) => Effect.Effect<Acquired, Failure>;
  readonly advance: (
    event: ProviderWeeklySubscriptionUsageEvent<Acquired, Failure>,
  ) => Effect.Effect<ProviderWeeklySubscriptionUsageFacts>;
  readonly finalize: Effect.Effect<void>;
}

interface ProviderMonitorDependencies {
  readonly publish: (
    status: WeeklySubscriptionUsageStatus,
  ) => Effect.Effect<void>;
  readonly pollIntervalMs?: number;
  readonly random?: Effect.Effect<number>;
}

const continuityOf = <Credential>(
  previousIdentity: ProviderCredentialIdentity | undefined,
  resolution: ResolvedProviderCredential<Credential>,
): ProviderCredentialContinuity => {
  if (resolution.kind === "unavailable") return "unavailable";
  return previousIdentity === resolution.identity ? "unchanged" : "changed";
};

/**
 * Builds one deep provider monitor in the caller's session Scope. Provider
 * adapters report domain facts; scheduling remains behind this seam.
 */
export function makeProviderMonitor<Credential, Acquired, Failure>(
  adapter: ProviderMonitorAdapter<Credential, Acquired, Failure>,
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
    let currentIdentity: ProviderCredentialIdentity | undefined;
    let acceptPassiveObservation = false;
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

    const applyFacts = (
      facts: ProviderWeeklySubscriptionUsageFacts,
      generationSnapshot: number,
      followUpEvidence = false,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        const requestedDeadline = facts.staleUsageExpiresAtMs;
        if (
          requestedDeadline !== undefined &&
          !Number.isFinite(requestedDeadline)
        ) {
          return yield* Effect.die(
            new TypeError("provider stale expiration must be finite"),
          );
        }
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
          const expirationFiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.sleep(Math.max(0, deadline - now));
              if (staleDeadline !== deadline || staleFiber !== expirationFiber)
                return;
              staleFiber = undefined;
              staleDeadline = undefined;
              const atExpiration = yield* Clock.currentTimeMillis;
              const expirationFacts = yield* adapter.advance({
                kind: "stale-expiration-reached",
                deadlineMs: deadline,
                nowMs: atExpiration,
              });
              yield* applyFacts(expirationFacts, refreshGeneration);
              yield* drainAcquisitionDemand;
            }),
            scope,
          );
          staleFiber = expirationFiber;
        }
        if (facts.presentation.kind === "replace") {
          yield* dependencies.publish(facts.presentation.status);
        }
        if (
          facts.observationEvidence === "inadequate" &&
          (followUpEvidence || activeRefreshFiber === undefined)
        ) {
          acquisitionDemanded = true;
        }
      });

    const resolveCredential = (generationSnapshot: number) =>
      Effect.gen(function* () {
        observationSuppressionsInFlight += 1;
        const resolution = yield* adapter.resolveCredential.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              observationSuppressionsInFlight -= 1;
            }),
          ),
        );
        if (!isCurrent(generationSnapshot)) return yield* Effect.interrupt;
        if (
          resolution.kind === "available" &&
          resolution.identity.trim() === ""
        ) {
          return yield* Effect.die(
            new TypeError("provider credential identity must not be empty"),
          );
        }
        const continuity = continuityOf(currentIdentity, resolution);
        currentIdentity =
          resolution.kind === "available" ? resolution.identity : undefined;
        acceptPassiveObservation = resolution.acceptPassiveObservation;
        const now = yield* Clock.currentTimeMillis;
        const facts = yield* adapter.advance({
          kind: "credential-observed",
          continuity,
          credentialAvailable: resolution.kind === "available",
          nowMs: now,
        });
        yield* applyContinuity(continuity);
        yield* applyFacts(facts, generationSnapshot);
        return { resolution, continuity };
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

    const applyHealth = (
      health: ProviderAcquisitionHealth | undefined,
      generationSnapshot: number,
    ) =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot) || health === undefined) return;
        if (health.kind === "credential-rejected") return;
        const now = yield* Clock.currentTimeMillis;
        if (health.kind === "temporarily-unavailable") {
          terminal = false;
          consecutiveFailures += 1;
          const providerDeadline = health.providerNotBeforeMs;
          if (
            providerDeadline !== undefined &&
            !Number.isFinite(providerDeadline)
          ) {
            return yield* Effect.die(
              new TypeError("provider acquisition deadline must be finite"),
            );
          }
          if (providerDeadline !== undefined && providerDeadline > now) {
            nextAttemptAt = providerDeadline;
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
        terminal = health.kind === "terminal";
      });

    const acquire = (
      started: Extract<
        ResolvedProviderCredential<Credential>,
        { readonly kind: "available" }
      >,
      generationSnapshot: number,
      authenticationRefreshUsed: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const acquisitionExit = yield* Effect.exit(
          adapter.acquire(started.credential),
        );
        if (!isCurrent(generationSnapshot)) return;
        if (
          Exit.isFailure(acquisitionExit) &&
          Cause.isInterruptedOnly(acquisitionExit.cause)
        ) {
          return;
        }

        if (adapter.credentialVerification === "before-and-after") {
          yield* resolveCredential(generationSnapshot);
          if (!isCurrent(generationSnapshot)) return;
        }

        if (Exit.isFailure(acquisitionExit)) {
          const defects = Cause.keepDefects(acquisitionExit.cause);
          if (defects._tag === "Some") {
            if (
              adapter.credentialVerification === "before-and-after" &&
              currentIdentity !== started.identity
            ) {
              return;
            }
            yield* applyFacts(
              {
                presentation: {
                  kind: "replace",
                  status: { kind: "unavailable" },
                },
                staleUsageExpiresAtMs: undefined,
              },
              generationSnapshot,
            );
            return yield* Effect.failCause(defects.value);
          }
        }

        const exit: ProviderAcquisitionExit<Acquired, Failure> = Exit.isSuccess(
          acquisitionExit,
        )
          ? { kind: "acquired", value: acquisitionExit.value }
          : (() => {
              const failure = Cause.failureOption(acquisitionExit.cause);
              if (failure._tag === "None") {
                throw new TypeError("provider acquisition had no failure");
              }
              return { kind: "failed" as const, error: failure.value };
            })();
        const now = yield* Clock.currentTimeMillis;
        const facts = yield* adapter.advance({
          kind: "acquisition-completed",
          exit,
          startedIdentity: started.identity,
          currentIdentity,
          authenticationRefreshUsed,
          nowMs: now,
        });
        yield* applyFacts(facts, generationSnapshot, true);
        if (facts.acquisitionHealth?.kind === "credential-rejected") {
          if (authenticationRefreshUsed) {
            return yield* Effect.die(
              new TypeError("provider requested repeated credential refresh"),
            );
          }
          const refreshed = yield* resolveCredential(generationSnapshot);
          if (refreshed.resolution.kind === "available") {
            yield* acquire(refreshed.resolution, generationSnapshot, true);
          }
          return;
        }
        yield* applyHealth(facts.acquisitionHealth, generationSnapshot);
      });

    const performRefresh = (generationSnapshot: number, mode: RefreshMode) =>
      Effect.gen(function* () {
        const inspected = yield* resolveCredential(generationSnapshot);
        if (!isCurrent(generationSnapshot)) return;
        if (inspected.resolution.kind === "unavailable") return;
        if (terminal && mode === "ordinary") return;
        const now = yield* Clock.currentTimeMillis;
        if (mode === "ordinary" && now < nextAttemptAt) {
          const facts = yield* adapter.advance({
            kind: "acquisition-deferred",
            nowMs: now,
          });
          yield* applyFacts(facts, generationSnapshot);
          return;
        }
        yield* acquire(inspected.resolution, generationSnapshot, false);
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
        currentIdentity = undefined;
        acceptPassiveObservation = false;
        yield* adapter.advance({ kind: "session-ended" });
        yield* adapter.finalize;
      }),
    );

    yield* Effect.forkIn(
      Stream.tick(dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS).pipe(
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
            !acceptPassiveObservation ||
            observationSuppressionsInFlight > 0 ||
            accountChangeRefreshesInFlight > 0
          ) {
            return Effect.void;
          }
          const generationSnapshot = refreshGeneration;
          return Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const facts = yield* adapter.advance({
              kind: "passive-observation",
              fields,
              nowMs: now,
            });
            yield* applyFacts(facts, generationSnapshot);
            yield* drainAcquisitionDemand;
          });
        }),
      refreshAfterActivity: Effect.gen(function* () {
        const generationSnapshot = refreshGeneration;
        const now = yield* Clock.currentTimeMillis;
        const facts = yield* adapter.advance({
          kind: "activity-observed",
          nowMs: now,
        });
        yield* applyFacts(facts, generationSnapshot);
        yield* drainAcquisitionDemand;
      }),
      refreshForAccountChange: refresh("account-change"),
    } satisfies ProviderMonitor;
  });
}
