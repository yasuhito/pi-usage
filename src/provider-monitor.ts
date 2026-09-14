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

import type {
  CapacityAcquisitionStatus,
  ProviderCapacityStatus,
} from "./presentation.ts";
import type { StaleCapacityDeadline } from "./stale-capacity-lifecycle.ts";

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

/**
 * Non-secret, session-local provenance. Sequence is reserved when evidence work
 * starts; credentialEpoch changes whenever account continuity is not proven.
 */
export interface ProviderEvidenceProvenance {
  readonly sequence: number;
  readonly credentialEpoch: number;
}

export type ProviderCapacityEvent<Acquired, Failure> =
  | {
      readonly kind: "credential-observed";
      readonly continuity: ProviderCredentialContinuity;
      readonly credentialAvailable: boolean;
      readonly credentialEpoch: number;
      readonly nowMs: number;
    }
  | {
      readonly kind: "acquisition-completed";
      readonly exit: ProviderAcquisitionExit<Acquired, Failure>;
      readonly startedIdentity: ProviderCredentialIdentity;
      readonly currentIdentity: ProviderCredentialIdentity | undefined;
      readonly authenticationRefreshUsed: boolean;
      readonly provenance: ProviderEvidenceProvenance;
      readonly nowMs: number;
    }
  | {
      readonly kind: "passive-observation";
      readonly fields: Readonly<Record<string, unknown>>;
      readonly provenance: ProviderEvidenceProvenance;
      readonly nowMs: number;
    }
  | { readonly kind: "activity-observed"; readonly nowMs: number }
  | { readonly kind: "acquisition-deferred"; readonly nowMs: number }
  | {
      readonly kind: "stale-expiration-reached";
      readonly deadline: StaleCapacityDeadline;
      readonly nowMs: number;
    }
  | { readonly kind: "session-ended" };

type ProviderMonitorStatus<Status extends ProviderCapacityStatus> =
  | CapacityAcquisitionStatus
  | Status;

export type ProviderPresentation<
  Status extends ProviderCapacityStatus = ProviderCapacityStatus,
> =
  | { readonly kind: "preserve" }
  | {
      readonly kind: "replace";
      readonly status: ProviderMonitorStatus<Status>;
    };

/** A provider-domain fact; only inadequate evidence creates acquisition demand. */
export type ProviderCapacityEvidence = "adequate" | "inadequate";

/** Provider acquisition meaning, without retry or terminal scheduling work. */
export type ProviderAcquisitionHealth =
  | { readonly kind: "healthy" }
  | {
      readonly kind: "temporarily-unavailable";
      readonly providerNotBeforeMs: number | undefined;
    }
  | {
      readonly kind: "trigger-deferred";
      readonly providerNotBeforeMs: number | undefined;
    }
  | { readonly kind: "credential-rejected" }
  | { readonly kind: "terminal" };

export interface ProviderCapacityFacts<
  Status extends ProviderCapacityStatus = ProviderCapacityStatus,
> {
  readonly presentation: ProviderPresentation<Status>;
  readonly staleCapacityExpiration: StaleCapacityDeadline | undefined;
  readonly observationEvidence?: ProviderCapacityEvidence;
  readonly acquisitionHealth?: ProviderAcquisitionHealth;
}

/** Provider-specific policy at the acquisition seam. */
export interface ProviderMonitorAdapter<
  Credential,
  Acquired,
  Failure,
  Status extends ProviderCapacityStatus = ProviderCapacityStatus,
> {
  readonly credentialVerification: "before" | "before-and-after";
  readonly resolveCredential: Effect.Effect<
    ResolvedProviderCredential<Credential>
  >;
  readonly acquire: (
    credential: Credential,
  ) => Effect.Effect<Acquired, Failure>;
  readonly advance: (
    event: ProviderCapacityEvent<Acquired, Failure>,
  ) => Effect.Effect<ProviderCapacityFacts<Status>>;
  readonly finalize: Effect.Effect<void>;
}

export type ProviderPollingPolicy =
  | { readonly kind: "periodic"; readonly intervalMs: number }
  | { readonly kind: "disabled" };

interface ProviderMonitorDependencies<Status extends ProviderCapacityStatus> {
  readonly publish: (
    status: ProviderMonitorStatus<Status>,
  ) => Effect.Effect<void>;
  /** Omitted for the default one-minute polling interval. */
  readonly polling?: ProviderPollingPolicy;
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
export function makeProviderMonitor<
  Credential,
  Acquired,
  Failure,
  Status extends ProviderCapacityStatus,
>(
  adapter: ProviderMonitorAdapter<Credential, Acquired, Failure, Status>,
  dependencies: ProviderMonitorDependencies<Status>,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const gate = yield* Effect.makeSemaphore(1);
    const credentialResolutionGate = yield* Effect.makeSemaphore(1);
    let refreshGeneration = 0;
    let activeRefreshFiber: Fiber.RuntimeFiber<void> | undefined;
    let retryFiber: Fiber.RuntimeFiber<void> | undefined;
    let staleFiber: Fiber.RuntimeFiber<void> | undefined;
    let staleExpiration: StaleCapacityDeadline | undefined;
    let nextAttemptAt = 0;
    let consecutiveFailures = 0;
    let terminal = false;
    let forcedRefreshDeferred = false;
    let acquisitionDemanded = false;
    let observationSuppressionsInFlight = 0;
    let accountChangeRefreshesInFlight = 0;
    let currentIdentity: ProviderCredentialIdentity | undefined;
    let acceptPassiveObservation = false;
    let credentialEpoch = 0;
    let evidenceSequence = 0;
    type RefreshMode = "ordinary" | "account-change";

    const nextEvidenceSequence = (): number => ++evidenceSequence;
    const evidenceProvenance = (
      sequence: number,
      startedCredentialEpoch: number,
    ): ProviderEvidenceProvenance => ({
      sequence,
      credentialEpoch: startedCredentialEpoch,
    });

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
      forcedRefreshDeferred = false;
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
      facts: ProviderCapacityFacts<Status>,
      generationSnapshot: number,
      followUpEvidence = false,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCurrent(generationSnapshot)) return;
        const requestedExpiration = facts.staleCapacityExpiration;
        if (
          requestedExpiration !== undefined &&
          !Number.isFinite(requestedExpiration.expiresAtMs)
        ) {
          return yield* Effect.die(
            new TypeError("provider stale expiration must be finite"),
          );
        }
        if (requestedExpiration !== staleExpiration) {
          if (staleFiber !== undefined) yield* Fiber.interrupt(staleFiber);
          staleFiber = undefined;
          staleExpiration = requestedExpiration;
        }
        if (
          requestedExpiration !== undefined &&
          staleExpiration === requestedExpiration &&
          staleFiber === undefined &&
          isCurrent(generationSnapshot)
        ) {
          const expiration = requestedExpiration;
          const expirationFiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.sleep(Math.max(0, expiration.expiresAtMs - now));
              if (
                staleExpiration !== expiration ||
                staleFiber !== expirationFiber
              )
                return;
              staleFiber = undefined;
              staleExpiration = undefined;
              const atExpiration = yield* Clock.currentTimeMillis;
              const expirationFacts = yield* adapter.advance({
                kind: "stale-expiration-reached",
                deadline: expiration,
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
      credentialResolutionGate.withPermits(1)(
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
          if (continuity !== "unchanged") credentialEpoch += 1;
          currentIdentity =
            resolution.kind === "available" ? resolution.identity : undefined;
          acceptPassiveObservation = resolution.acceptPassiveObservation;
          const now = yield* Clock.currentTimeMillis;
          const facts = yield* adapter.advance({
            kind: "credential-observed",
            continuity,
            credentialAvailable: resolution.kind === "available",
            credentialEpoch,
            nowMs: now,
          });
          yield* applyContinuity(continuity);
          yield* applyFacts(facts, generationSnapshot);
          return { resolution, continuity, credentialEpoch };
        }),
      );

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
        if (
          health.kind === "temporarily-unavailable" ||
          health.kind === "trigger-deferred"
        ) {
          terminal = false;
          forcedRefreshDeferred = health.kind === "trigger-deferred";
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
          if (health.kind === "temporarily-unavailable") {
            yield* scheduleRetry(generationSnapshot, now);
          }
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
      startedCredentialEpoch: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const provenance = evidenceProvenance(
          nextEvidenceSequence(),
          startedCredentialEpoch,
        );
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
                staleCapacityExpiration: undefined,
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
          provenance,
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
            yield* acquire(
              refreshed.resolution,
              generationSnapshot,
              true,
              refreshed.credentialEpoch,
            );
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
        const honorSchedule = mode === "ordinary" || forcedRefreshDeferred;
        if (terminal && honorSchedule) return;
        const now = yield* Clock.currentTimeMillis;
        if (honorSchedule && now < nextAttemptAt) {
          const facts = yield* adapter.advance({
            kind: "acquisition-deferred",
            nowMs: now,
          });
          yield* applyFacts(facts, generationSnapshot);
          return;
        }
        yield* acquire(
          inspected.resolution,
          generationSnapshot,
          false,
          inspected.credentialEpoch,
        );
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
        staleExpiration = undefined;
        acquisitionDemanded = false;
        observationSuppressionsInFlight = 0;
        accountChangeRefreshesInFlight = 0;
        currentIdentity = undefined;
        acceptPassiveObservation = false;
        forcedRefreshDeferred = false;
        yield* adapter.advance({ kind: "session-ended" });
        yield* adapter.finalize;
      }),
    );

    if (dependencies.polling?.kind !== "disabled") {
      const pollIntervalMs =
        dependencies.polling?.kind === "periodic"
          ? dependencies.polling.intervalMs
          : DEFAULT_POLL_INTERVAL_MS;
      yield* Effect.forkIn(
        Stream.tick(pollIntervalMs).pipe(
          Stream.drop(1),
          Stream.runForEach(() =>
            Effect.suspend(() => triggerRefresh("ordinary")).pipe(
              Effect.asVoid,
            ),
          ),
          Effect.asVoid,
        ),
        scope,
      );
    }

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
          const sequence = nextEvidenceSequence();
          return Effect.gen(function* () {
            const inspected = yield* resolveCredential(generationSnapshot);
            if (!inspected.resolution.acceptPassiveObservation) return;
            const now = yield* Clock.currentTimeMillis;
            const facts = yield* adapter.advance({
              kind: "passive-observation",
              fields,
              provenance: {
                sequence,
                credentialEpoch: inspected.credentialEpoch,
              },
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
