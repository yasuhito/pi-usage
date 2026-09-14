import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, TestClock } from "effect";

import { makeClaudeProviderMonitor } from "../src/claude-provider-monitor.ts";
import {
  type AcquiredClaudeSubscriptionUsage,
  ClaudeAuthenticationRejected,
  MalformedClaudeSubscriptionUsage,
  PermanentClaudeSubscriptionUsageFailure,
  TemporaryClaudeSubscriptionUsageFailure,
} from "../src/claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";

function fixture() {
  return Effect.gen(function* () {
    let acquisition: Effect.Effect<
      AcquiredClaudeSubscriptionUsage,
      | ClaudeAuthenticationRejected
      | TemporaryClaudeSubscriptionUsageFailure
      | PermanentClaudeSubscriptionUsageFailure
      | MalformedClaudeSubscriptionUsage
    > = Effect.succeed({
      usedPercent: 63.4,
      resetsAtMs: 2_000_000,
    });
    let credential: string | undefined = "secret-1";
    let reads = 0;
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const monitor = yield* makeClaudeProviderMonitor({
      resolveAuthentication: () =>
        Effect.sync(() =>
          credential === undefined
            ? undefined
            : { source: "OAuth", auth: { apiKey: credential } },
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
      setCredential: (value: string | undefined) => {
        credential = value;
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

it.scoped(
  "keeps a shared observation's original three-minute freshness boundary",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setAcquisition(
        Effect.succeed({
          usedPercent: 63.4,
          resetsAtMs: 2_000_000,
          observedAtMs: 0,
        }),
      );
      yield* TestClock.adjust("179 seconds");
      yield* f.monitor.start;
      yield* TestClock.adjust("1 second");
      yield* f.monitor.refreshAfterActivity;

      assert.equal(f.reads(), 2);
    }),
);

it.scoped(
  "limits activity refreshes to three minutes and polls every fifteen",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      yield* TestClock.adjust("179999 millis");
      yield* f.monitor.refreshAfterActivity;
      assert.equal(f.reads(), 1);
      yield* TestClock.adjust("1 millis");
      yield* f.monitor.refreshAfterActivity;
      assert.equal(f.reads(), 2);
      yield* TestClock.adjust("719999 millis");
      assert.equal(f.reads(), 2);
      yield* TestClock.adjust("1 millis");
      assert.equal(f.reads(), 3);
    }),
);

it.scoped("keeps temporary failures stale until the reported reset", () =>
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
    yield* TestClock.adjust("1999999 millis");
    assert.equal(f.statuses.at(-1)?.kind, "available");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("presents a shared preceding observation as stale on startup", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({
          retryAtMs: 900_000,
          staleUsage: {
            usedPercent: 27,
            resetsAtMs: 2_000_000,
            observedAtMs: 1_000,
          },
        }),
      ),
    );

    yield* f.monitor.start;

    assert.deepEqual(f.statuses.at(-1), {
      kind: "available",
      usedPercent: 27,
      stale: true,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped(
  "clears prior usage when shared suppression must not preserve it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      f.setAcquisition(
        Effect.fail(
          new TemporaryClaudeSubscriptionUsageFailure({
            retryAtMs: 900_000,
            preserveUsage: false,
          }),
        ),
      );

      yield* f.monitor.refreshForAccountChange;

      assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    }),
);

it.scoped("does not let stale expiration clear newly acquired usage", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    harness.setAcquisition(
      Effect.fail(
        new TemporaryClaudeSubscriptionUsageFailure({
          retryAtMs: 2_000_000,
        }),
      ),
    );
    yield* harness.monitor.refreshForAccountChange;
    yield* TestClock.adjust("599999 millis");
    harness.setAcquisition(
      Effect.sleep("1 millis").pipe(
        Effect.as({
          usedPercent: 20,
          resetsAtMs: 2_000_000,
        }),
      ),
    );
    const refresh = yield* Effect.fork(harness.monitor.refreshForAccountChange);
    while (harness.reads() < 3) yield* Effect.yieldNow();
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(refresh);

    assert.deepEqual(harness.statuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped("keeps malformed observations stale until the reset instant", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 50,
        resetsAtMs: 120_000,
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

it.scoped("does not disguise acquisition defects as retryable failures", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(Effect.die("unexpected defect"));
    const exit = yield* Effect.exit(f.monitor.refreshForAccountChange);
    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    yield* TestClock.adjust("1 second");
    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("899 seconds");
    assert.equal(f.reads(), 3);
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
    f.setCredential(undefined);
    yield* f.monitor.start;
    assert.equal(f.reads(), 0);
    f.setCredential("secret-2");
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 63.4,
        resetsAtMs: 2_000_000,
      }),
    );
    yield* TestClock.adjust("15 minutes");
    assert.equal(f.reads(), 1);
    assert.equal(f.statuses.at(-1)?.kind, "available");
  }),
);

it.scoped("clears old usage before acquiring for a new identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    const pending = yield* Deferred.make<void>();
    f.setCredential("secret-2");
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.as({
          usedPercent: 20,
          resetsAtMs: 2_000_000,
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
    const requestedCredentials: string[] = [];
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const monitor = yield* makeClaudeProviderMonitor({
      resolveAuthentication: () =>
        Effect.sync(() => ({
          source: "OAuth",
          auth: { apiKey: key },
        })),
      acquireClaudeSubscriptionUsage: (credential) =>
        Effect.suspend(() => {
          requestedCredentials.push(credential);
          if (requestedCredentials.length === 1) {
            key = "secret-2";
            return Effect.fail(new ClaudeAuthenticationRejected());
          }
          return Effect.succeed({
            usedPercent: 20,
            resetsAtMs: 2_000_000,
          });
        }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.deepEqual(requestedCredentials, ["secret-1", "secret-2"]);
    assert.deepEqual(statuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped("passes a normalized OAuth credential to acquisition", () =>
  Effect.gen(function* () {
    let receivedCredential: string | undefined;
    const monitor = yield* makeClaudeProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({
          source: "OAuth",
          auth: { apiKey: "  secret  " },
        }),
      acquireClaudeSubscriptionUsage: (credential) => {
        receivedCredential = credential;
        return Effect.succeed({ usedPercent: 90, resetsAtMs: 2_000_000 });
      },
      publish: () => Effect.void,
    });

    yield* monitor.start;

    assert.equal(receivedCredential, "secret");
  }),
);

it.scoped("normalizes OAuth before checking credential continuity", () =>
  Effect.gen(function* () {
    let resolutions = 0;
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const monitor = yield* makeClaudeProviderMonitor({
      resolveAuthentication: () =>
        Effect.sync(() => ({
          source: "OAuth",
          auth: { apiKey: resolutions++ === 0 ? " secret" : "secret " },
        })),
      acquireClaudeSubscriptionUsage: () =>
        Effect.succeed({ usedPercent: 90, resetsAtMs: 2_000_000 }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(statuses.at(-1)?.kind, "available");
  }),
);

it.scoped("contains authentication resolver failures", () =>
  Effect.gen(function* () {
    let reads = 0;
    const monitor = yield* makeClaudeProviderMonitor({
      resolveAuthentication: () =>
        Effect.die(new Error("secret-resolver-detail")),
      acquireClaudeSubscriptionUsage: () => {
        reads += 1;
        return Effect.succeed({ usedPercent: 90, resetsAtMs: 2_000_000 });
      },
      publish: () => Effect.void,
    });

    const exit = yield* Effect.exit(monitor.start);

    assert.equal(Exit.isSuccess(exit), true);
    assert.equal(reads, 0);
    assert.equal(
      JSON.stringify(exit).includes("secret-resolver-detail"),
      false,
    );
  }),
);

it.scoped("does not acquire without an eligible OAuth credential", () =>
  Effect.gen(function* () {
    for (const authentication of [
      undefined,
      { source: "ANTHROPIC_API_KEY", auth: { apiKey: "key" } },
      { source: "OAuth", auth: { apiKey: "   " } },
      { source: "OAuth", auth: {} },
    ]) {
      let reads = 0;
      const monitor = yield* makeClaudeProviderMonitor({
        resolveAuthentication: () => Effect.succeed(authentication),
        acquireClaudeSubscriptionUsage: () => {
          reads += 1;
          return Effect.succeed({ usedPercent: 90, resetsAtMs: 2_000_000 });
        },
        publish: () => Effect.void,
      });

      yield* monitor.start;

      assert.equal(reads, 0);
    }
  }),
);

it.scoped("retries a rejected OAuth credential only once immediately", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(new ClaudeAuthenticationRejected({ retryAtMs: 900_000 })),
    );

    yield* f.monitor.start;

    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("899999 millis");
    assert.equal(f.reads(), 2);
  }),
);

it.scoped("does not publish an acquisition after its identity changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setCredential(undefined);
    yield* f.monitor.start;
    f.setCredential("secret-1");
    const pending = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.as({
          usedPercent: 90,
          resetsAtMs: 2_000_000,
        }),
      ),
    );
    const refresh = yield* Effect.fork(f.monitor.refreshAfterActivity);
    while (f.reads() < 1) yield* Effect.yieldNow();
    f.setCredential("secret-2");
    yield* Deferred.succeed(pending, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("rechecks identity before handling an acquisition defect", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    const pending = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.andThen(Effect.die("old identity defect")),
      ),
    );
    const refresh = yield* Effect.fork(f.monitor.refreshForAccountChange);
    while (f.reads() < 2) yield* Effect.yieldNow();
    f.setCredential("secret-2");
    yield* Deferred.succeed(pending, undefined);
    yield* Fiber.join(refresh);

    f.setAcquisition(
      Effect.succeed({
        usedPercent: 20,
        resetsAtMs: 2_000_000,
      }),
    );
    yield* f.monitor.refreshAfterActivity;

    assert.equal(f.reads(), 3);
    const latest = f.statuses.at(-1);
    assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
  }),
);

it.scoped("does not restore stale usage after its identity changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    const pending = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(pending).pipe(
        Effect.andThen(
          Effect.fail(
            new TemporaryClaudeSubscriptionUsageFailure({
              retryAtMs: undefined,
              staleUsage: {
                usedPercent: 63.4,
                resetsAtMs: 2_000_000,
                observedAtMs: 0,
              },
            }),
          ),
        ),
      ),
    );
    const refresh = yield* Effect.fork(f.monitor.refreshForAccountChange);
    while (f.reads() < 2) yield* Effect.yieldNow();
    f.setCredential("secret-2");
    yield* Deferred.succeed(pending, undefined);
    yield* Fiber.join(refresh);

    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("coalesces ordinary refreshes and supersedes old identities", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setCredential(undefined);
    yield* f.monitor.start;
    f.setCredential("secret-1");
    const oldGate = yield* Deferred.make<void>();
    f.setAcquisition(
      Deferred.await(oldGate).pipe(
        Effect.as({
          usedPercent: 90,
          resetsAtMs: 2_000_000,
        }),
      ),
    );
    const first = yield* Effect.fork(f.monitor.refreshAfterActivity);
    const second = yield* Effect.fork(f.monitor.refreshAfterActivity);
    while (f.reads() < 1) yield* Effect.yieldNow();
    assert.equal(f.reads(), 1);
    f.setCredential("secret-2");
    f.setAcquisition(
      Effect.succeed({
        usedPercent: 20,
        resetsAtMs: 2_000_000,
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
