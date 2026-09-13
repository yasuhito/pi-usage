import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Scope, TestClock } from "effect";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderMonitorAdapter,
  type ProviderWeeklySubscriptionUsageFacts,
  providerCredentialIdentity,
  type ResolvedProviderCredential,
} from "../src/provider-monitor.ts";

interface AcquisitionOutcome {
  readonly status?: WeeklySubscriptionUsageStatus;
  readonly staleUsageExpiresAtMs?: number;
  readonly evidence?: ProviderWeeklySubscriptionUsageFacts["observationEvidence"];
  readonly health: ProviderAcquisitionHealth;
}

interface AcquisitionFailure {
  readonly health: ProviderAcquisitionHealth;
}

const lifecycleFacts = (
  overrides: Partial<ProviderWeeklySubscriptionUsageFacts> = {},
): ProviderWeeklySubscriptionUsageFacts => ({
  presentation: { kind: "preserve" },
  staleUsageExpiresAtMs: undefined,
  ...overrides,
});

const completed = (usedPercent: number): AcquisitionOutcome => ({
  status: { kind: "available", usedPercent, stale: false },
  health: { kind: "healthy" },
});

const retry = (
  providerNotBeforeMs: number | undefined,
): AcquisitionFailure => ({
  health: { kind: "temporarily-unavailable", providerNotBeforeMs },
});

function fixture(random = 0.5) {
  return Effect.gen(function* () {
    let reads = 0;
    let identityCounter = 1;
    let resolution: ResolvedProviderCredential<string> = {
      kind: "available",
      identity: providerCredentialIdentity(`account-${identityCounter}`),
      credential: "credential",
      acceptPassiveObservation: true,
    };
    let acquisition: Effect.Effect<AcquisitionOutcome, AcquisitionFailure> =
      Effect.sync(() => completed(reads));
    let staleExpirationFacts = lifecycleFacts();
    let currentStaleDeadline: number | undefined;
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const adapter: ProviderMonitorAdapter<
      string,
      AcquisitionOutcome,
      AcquisitionFailure
    > = {
      credentialVerification: "before",
      resolveCredential: Effect.sync(() => resolution),
      acquire: () =>
        Effect.suspend(() => {
          reads += 1;
          return acquisition;
        }),
      advance: (event) =>
        Effect.sync(() => {
          switch (event.kind) {
            case "credential-observed":
              return lifecycleFacts({
                staleUsageExpiresAtMs: currentStaleDeadline,
              });
            case "acquisition-completed": {
              if (event.exit.kind === "failed") {
                return lifecycleFacts({
                  staleUsageExpiresAtMs: currentStaleDeadline,
                  acquisitionHealth: event.exit.error.health,
                });
              }
              const outcome = event.exit.value;
              currentStaleDeadline = outcome.staleUsageExpiresAtMs;
              return lifecycleFacts({
                presentation:
                  outcome.status === undefined
                    ? { kind: "preserve" }
                    : { kind: "replace", status: outcome.status },
                staleUsageExpiresAtMs: currentStaleDeadline,
                observationEvidence: outcome.evidence ?? "adequate",
                acquisitionHealth: outcome.health,
              });
            }
            case "activity-observed":
              return lifecycleFacts({
                staleUsageExpiresAtMs: currentStaleDeadline,
                observationEvidence: "inadequate",
              });
            case "stale-expiration-reached":
              currentStaleDeadline = staleExpirationFacts.staleUsageExpiresAtMs;
              return staleExpirationFacts;
            case "session-ended":
              currentStaleDeadline = undefined;
              return lifecycleFacts();
            case "passive-observation":
            case "acquisition-deferred":
              return lifecycleFacts({
                staleUsageExpiresAtMs: currentStaleDeadline,
              });
          }
        }),
      finalize: Effect.void,
    };
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(random),
    });
    return {
      monitor,
      statuses,
      reads: () => reads,
      setAcquisition: (
        value: Effect.Effect<AcquisitionOutcome, AcquisitionFailure>,
      ) => {
        acquisition = value;
      },
      setStaleExpirationFacts: (
        value: ProviderWeeklySubscriptionUsageFacts,
      ) => {
        staleExpirationFacts = value;
      },
      setCredential: (kind: "unchanged" | "changed" | "unavailable") => {
        if (kind === "unavailable") {
          resolution = {
            kind: "unavailable",
            acceptPassiveObservation: false,
          };
          return;
        }
        if (kind === "changed") identityCounter += 1;
        resolution = {
          kind: "available",
          identity: providerCredentialIdentity(`account-${identityCounter}`),
          credential: "credential",
          acceptPassiveObservation: true,
        };
      },
    };
  });
}

it.scoped("starts immediately and polls every minute", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    assert.deepEqual(harness.statuses, [
      { kind: "loading" },
      { kind: "available", usedPercent: 1, stale: false },
    ]);
    yield* TestClock.adjust("59999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("keeps poll cadence while acquisition is in flight", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const gate = yield* Deferred.make<void>();
    harness.setAcquisition(Deferred.await(gate).pipe(Effect.as(completed(2))));
    yield* TestClock.adjust("1 minute");
    assert.equal(harness.reads(), 2);
    yield* TestClock.adjust("65 seconds");
    assert.equal(harness.reads(), 2);
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust("55 seconds");
    assert.equal(harness.reads(), 3);
  }),
);

it.scoped("coalesces ordinary refreshes", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const gate = yield* Deferred.make<void>();
    harness.setAcquisition(Deferred.await(gate).pipe(Effect.as(completed(2))));
    const first = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    const second = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    while (harness.reads() < 2) yield* Effect.yieldNow();
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("forced refresh supersedes ordinary work", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const never = yield* Deferred.make<void>();
    harness.setAcquisition(
      Deferred.await(never).pipe(Effect.as(completed(90))),
    );
    const old = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    while (harness.reads() < 2) yield* Effect.yieldNow();
    harness.setAcquisition(Effect.succeed(completed(20)));
    yield* harness.monitor.refreshForAccountChange;
    yield* Fiber.await(old);
    assert.equal(harness.reads(), 3);
    const latest = harness.statuses.at(-1);
    assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
  }),
);

it.scoped("propagates acquisition defects without scheduling retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.die("unexpected defect"));
    const exit = yield* Effect.exit(harness.monitor.start);
    assert.equal(Exit.isFailure(exit), true);
    assert.equal(Exit.isFailure(exit) && Cause.defects(exit.cause).length, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(harness.reads(), 1);
  }),
);

it.scoped("honors a valid provider retry deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.fail(retry(5_000)));
    yield* harness.monitor.start;
    yield* TestClock.adjust("4999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("rejects a non-finite provider retry deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.fail(retry(Number.NaN)));

    const exit = yield* Effect.exit(harness.monitor.start);

    assert.equal(Exit.isFailure(exit), true);
    assert.equal(Exit.isFailure(exit) && Cause.defects(exit.cause).length, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(harness.reads(), 1);
  }),
);

it.scoped("stops retry while credentials are unavailable", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.fail(retry(5_000)));
    yield* harness.monitor.start;
    harness.setCredential("unavailable");
    yield* harness.monitor.refreshAfterActivity;
    yield* TestClock.adjust("5 seconds");
    assert.equal(harness.reads(), 1);
    harness.setCredential("changed");
    yield* harness.monitor.refreshAfterActivity;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("grows deterministic retry backoff and caps it at one minute", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.fail(retry(undefined)));
    yield* harness.monitor.start;
    for (const [delay, expectedReads] of [
      [1, 2],
      [2, 3],
      [4, 4],
      [8, 5],
      [16, 6],
      [32, 7],
      [60, 8],
      [60, 9],
    ] as const) {
      yield* TestClock.adjust(`${delay} seconds`);
      assert.equal(harness.reads(), expectedReads);
    }
  }),
);

it.scoped("applies deterministic retry jitter", () =>
  Effect.gen(function* () {
    const harness = yield* fixture(1);
    harness.setAcquisition(Effect.fail(retry(undefined)));
    yield* harness.monitor.start;
    yield* TestClock.adjust("1499 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("forced refresh replaces an obsolete retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.fail(retry(100_000)));
    yield* harness.monitor.start;
    harness.setAcquisition(Effect.fail(retry(undefined)));
    yield* harness.monitor.refreshForAccountChange;
    yield* TestClock.adjust("1999 millis");
    assert.equal(harness.reads(), 2);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 3);
  }),
);

it.scoped("terminal results suppress polling until a forced refresh", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed({ health: { kind: "terminal" } }));
    yield* harness.monitor.start;
    yield* TestClock.adjust("1 minute");
    assert.equal(harness.reads(), 1);
    yield* harness.monitor.refreshForAccountChange;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("coalesces inadequate evidence emitted by completion", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.sync(() =>
        harness.reads() === 1
          ? { ...completed(1), evidence: "inadequate" }
          : completed(2),
      ),
    );
    yield* harness.monitor.start;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      yield* Effect.yieldNow();
    }
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("publishes acquisition facts before applying retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.fail({
        health: {
          kind: "temporarily-unavailable",
          providerNotBeforeMs: 5_000,
        },
      }),
    );
    yield* harness.monitor.start;
    assert.deepEqual(harness.statuses, [{ kind: "loading" }]);
    yield* TestClock.adjust("4999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("runs provider stale expiration at its deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setStaleExpirationFacts(
      lifecycleFacts({
        presentation: { kind: "replace", status: { kind: "unavailable" } },
      }),
    );
    harness.setAcquisition(
      Effect.succeed({
        status: { kind: "available", usedPercent: 50, stale: true },
        staleUsageExpiresAtMs: 10_000,
        health: { kind: "healthy" },
      }),
    );
    yield* harness.monitor.start;
    yield* TestClock.adjust("9999 millis");
    assert.equal(harness.statuses.at(-1)?.kind, "available");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(harness.statuses.at(-1), { kind: "unavailable" });
  }),
);

it("scope closure interrupts active acquisition", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let interrupted = false;
    const adapter: ProviderMonitorAdapter<string, void, never> = {
      credentialVerification: "before",
      resolveCredential: Effect.succeed({
        kind: "available",
        identity: providerCredentialIdentity("account-1"),
        credential: "credential",
        acceptPassiveObservation: false,
      }),
      acquire: () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      advance: () => Effect.succeed(lifecycleFacts()),
      finalize: Effect.void,
    };
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: () => Effect.void,
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const start = yield* Effect.fork(monitor.start);
    yield* Effect.yieldNow();
    yield* Scope.close(scope, Exit.void);
    yield* Fiber.await(start);
    assert.equal(interrupted, true);
  }));

it("scope closure cancels polling and retry work", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let reads = 0;
    let finalized = false;
    const adapter: ProviderMonitorAdapter<string, void, AcquisitionFailure> = {
      credentialVerification: "before",
      resolveCredential: Effect.succeed({
        kind: "available",
        identity: providerCredentialIdentity("account-1"),
        credential: "credential",
        acceptPassiveObservation: false,
      }),
      acquire: () =>
        Effect.sync(() => {
          reads += 1;
        }).pipe(Effect.andThen(Effect.fail(retry(undefined)))),
      advance: (event) =>
        Effect.sync(() =>
          lifecycleFacts(
            event.kind === "acquisition-completed" &&
              event.exit.kind === "failed"
              ? { acquisitionHealth: event.exit.error.health }
              : {},
          ),
        ),
      finalize: Effect.sync(() => {
        finalized = true;
      }),
    };
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: () => Effect.void,
      random: Effect.succeed(0.5),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* monitor.start;
    assert.equal(reads, 1);
    yield* Scope.close(scope, Exit.void);
    assert.equal(finalized, true);
    yield* TestClock.adjust("2 minutes");
    assert.equal(reads, 1);
  }));
