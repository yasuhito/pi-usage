import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, TestClock } from "effect";

import { makeClaudeProviderMonitor } from "../src/claude-provider-monitor.ts";
import {
  type AcquiredClaudeSubscriptionUsage,
  claudeCredentialFingerprint,
  createAcquireClaudeSubscriptionUsage,
  MalformedClaudeSubscriptionUsage,
  PermanentClaudeSubscriptionUsageFailure,
  TemporaryClaudeSubscriptionUsageFailure,
} from "../src/claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";

function fixture() {
  return Effect.gen(function* () {
    let acquisition: Effect.Effect<
      AcquiredClaudeSubscriptionUsage,
      | TemporaryClaudeSubscriptionUsageFailure
      | PermanentClaudeSubscriptionUsageFailure
      | MalformedClaudeSubscriptionUsage
    > = Effect.succeed({
      usedPercent: 63.4,
      resetsAtMs: 2_000_000,
      credentialFingerprint: "fingerprint-1",
    });
    let identity: string | undefined = "fingerprint-1";
    let reads = 0;
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const monitor = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.sync(() =>
        identity === undefined
          ? { kind: "missing" as const }
          : { kind: "available" as const, fingerprint: identity },
      ),
      acquireClaudeSubscriptionUsage: () => {
        reads += 1;
        return acquisition;
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(0.5),
    });
    return {
      monitor,
      statuses,
      reads: () => reads,
      setIdentity: (value: string | undefined) => {
        identity = value;
      },
      setAcquisition: (value: typeof acquisition) => {
        acquisition = value;
      },
    };
  });
}

it.scoped("publishes Claude weekly subscription usage", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    assert.deepEqual(f.statuses, [
      { kind: "loading" },
      {
        kind: "available",
        usedPercent: 63.4,
        stale: false,
        weeklyWindowResetsAtMs: 2_000_000,
      },
    ]);
  }),
);

it.scoped("polls every minute using virtual time", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    yield* TestClock.adjust("59999 millis");
    assert.equal(f.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), 3);
  }),
);

it.scoped("keeps the minute poll cadence while a refresh is in flight", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    const gate = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(gate).pipe(
        Effect.as({
          usedPercent: 63.4,
          resetsAtMs: 2_000_000,
          credentialFingerprint: "fingerprint-1",
        }),
      ),
    );
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("65 seconds");
    assert.equal(f.reads(), 2);
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust("55 seconds");
    assert.equal(f.reads(), 3);
  }),
);

it.scoped("debounces activity for exactly 30 seconds", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    yield* TestClock.adjust("29999 millis");
    yield* f.monitor.refreshAfterActivity;
    assert.equal(f.reads(), 1);
    yield* TestClock.adjust("1 millis");
    yield* f.monitor.refreshAfterActivity;
    assert.equal(f.reads(), 2);
  }),
);

it.scoped("keeps temporary failures stale for at most ten minutes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs: undefined }),
      ),
    );
    yield* f.monitor.refreshForAccountChange;
    const stale = f.statuses.at(-1);
    assert.equal(stale?.kind === "available" && stale.stale, true);
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("keeps malformed observations stale until the reset instant", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 50,
        resetsAtMs: 120_000,
        credentialFingerprint: "fingerprint-1",
      }),
    );
    yield* f.monitor.start;
    f.setAcquisition(Effect.fail(new MalformedClaudeSubscriptionUsage()));
    yield* f.monitor.refreshForAccountChange;
    const stale = f.statuses.at(-1);
    assert.equal(stale?.kind === "available" && stale.stale, true);
    yield* TestClock.adjust("2 minutes");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("honors a valid provider retry deadline", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs: 5_000 }),
      ),
    );
    yield* f.monitor.start;
    yield* TestClock.adjust("4999 millis");
    assert.equal(f.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(f.reads(), 2);
  }),
);

it.scoped("grows deterministic retry backoff and caps it at one minute", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs: undefined }),
      ),
    );
    yield* f.monitor.start;
    assert.equal(f.reads(), 1);
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
      assert.equal(f.reads(), expectedReads);
    }
  }),
);

it.scoped("applies injected deterministic retry jitter", () =>
  Effect.gen(function* () {
    let reads = 0;
    const monitor = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available" as const,
        fingerprint: "fingerprint-1",
      }),
      acquireClaudeSubscriptionUsage: () => {
        reads += 1;
        return Effect.fail(
          new TemporaryClaudeSubscriptionUsageFailure({
            retryAtMs: undefined,
          }),
        );
      },
      publish: () => Effect.void,
      random: Effect.succeed(1),
    });
    yield* monitor.start;
    yield* TestClock.adjust("1499 millis");
    assert.equal(reads, 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(reads, 2);
  }),
);

it.scoped("turns terminal acquisition failures into unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(new PermanentClaudeSubscriptionUsageFailure()),
    );
    yield* f.monitor.start;
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), 1);
    f.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs: undefined }),
      ),
    );
    yield* f.monitor.refreshForAccountChange;
    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("1 second");
    assert.equal(f.reads(), 3);
  }),
);

it.scoped("keeps checking for credentials while unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setIdentity(undefined);
    yield* f.monitor.start;
    assert.equal(f.reads(), 0);
    f.setIdentity("fingerprint-2");
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 63.4,
        resetsAtMs: 2_000_000,
        credentialFingerprint: "fingerprint-2",
      }),
    );
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), 1);
    assert.equal(f.statuses.at(-1)?.kind, "available");
  }),
);

it.scoped("clears old usage before acquiring for a new identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    const pending = yield* Deferred.make<void>();
    f.setIdentity("fingerprint-2");
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.as({
          usedPercent: 20,
          resetsAtMs: 2_000_000,
          credentialFingerprint: "fingerprint-2",
        }),
      ),
    );
    const refresh = yield* Effect.fork(f.monitor.refreshForAccountChange);
    while (f.reads() < 2) yield* Effect.yieldNow();
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    yield* Deferred.succeed(pending, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(f.statuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped("publishes a successful acquisition made with refreshed OAuth", () =>
  Effect.gen(function* () {
    let key = "secret-1";
    let requests = 0;
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const authentication = () => ({
      source: "OAuth",
      auth: { apiKey: key },
    });
    const acquireClaudeSubscriptionUsage = createAcquireClaudeSubscriptionUsage(
      {
        resolveAuthentication: Effect.sync(authentication),
        fetch: async () => {
          requests += 1;
          if (requests === 1) {
            key = "secret-2";
            return new Response(null, { status: 401 });
          }
          return new Response(
            JSON.stringify({
              seven_day: {
                utilization: 20,
                resets_at: new Date(2_000_000).toISOString(),
              },
            }),
          );
        },
      },
    );
    const monitor = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.sync(() => ({
        kind: "available" as const,
        fingerprint: claudeCredentialFingerprint(authentication()) ?? "",
      })),
      acquireClaudeSubscriptionUsage,
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(requests, 2);
    assert.deepEqual(statuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped("does not publish an acquisition after its identity changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setIdentity(undefined);
    yield* f.monitor.start;
    f.setIdentity("fingerprint-1");
    const pending = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.as({
          usedPercent: 90,
          resetsAtMs: 2_000_000,
          credentialFingerprint: "fingerprint-1",
        }),
      ),
    );
    const refresh = yield* Effect.fork(f.monitor.refreshAfterActivity);
    while (f.reads() < 1) yield* Effect.yieldNow();
    f.setIdentity("fingerprint-2");
    yield* Deferred.succeed(pending, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("coalesces ordinary refreshes and supersedes old identities", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setIdentity(undefined);
    yield* f.monitor.start;
    f.setIdentity("fingerprint-1");
    const oldGate = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(oldGate).pipe(
        Effect.as({
          usedPercent: 90,
          resetsAtMs: 2_000_000,
          credentialFingerprint: "fingerprint-1",
        }),
      ),
    );
    const first = yield* Effect.fork(f.monitor.refreshAfterActivity);
    const second = yield* Effect.fork(f.monitor.refreshAfterActivity);
    while (f.reads() < 1) yield* Effect.yieldNow();
    assert.equal(f.reads(), 1);
    f.setIdentity("fingerprint-2");
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 20,
        resetsAtMs: 2_000_000,
        credentialFingerprint: "fingerprint-2",
      }),
    );
    yield* f.monitor.refreshForAccountChange;
    yield* Fiber.await(first);
    yield* Fiber.await(second);
    assert.equal(f.reads(), 2);
    const latest = f.statuses.at(-1);
    assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
  }),
);
