import assert from "node:assert/strict";
import { test } from "vitest";

import { createStaleCapacityLifecycle } from "../src/stale-capacity-lifecycle.ts";

interface Capacity {
  readonly value: number;
  readonly resetsAtMs?: number;
}

const fixedRetention = (retentionMs: number) =>
  createStaleCapacityLifecycle<Capacity>({
    staleExpiresAtMs: ({ observedAtMs }) => observedAtMs + retentionMs,
  });

test("progresses capacity from fresh through stale to expired", () => {
  const lifecycle = fixedRetention(600_000);
  const capacity = { value: 63 };

  assert.deepEqual(
    lifecycle.advance({ kind: "observed", capacity, observedAtMs: 1_000 }),
    {
      observation: { kind: "capacity", capacity, freshness: "fresh" },
      staleExpiration: undefined,
      publication: "replace",
    },
  );

  const stale = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 2_000,
  });
  assert.deepEqual(stale.observation, {
    kind: "capacity",
    capacity,
    freshness: "stale",
  });
  assert.equal(stale.staleExpiration?.expiresAtMs, 601_000);
  assert.equal(stale.publication, "replace");

  assert.deepEqual(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadline: assertDefined(stale.staleExpiration),
      nowMs: 601_000,
    }),
    {
      observation: { kind: "none" },
      staleExpiration: undefined,
      publication: "replace",
    },
  );
});

test("uses provider policy without requiring a common capacity shape", () => {
  const lifecycle = createStaleCapacityLifecycle<Capacity>({
    staleExpiresAtMs: ({ capacity, observedAtMs }) =>
      Math.min(
        capacity.resetsAtMs ?? Number.POSITIVE_INFINITY,
        observedAtMs + 600_000,
      ),
  });
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 63, resetsAtMs: 500_000 },
    observedAtMs: 1_000,
  });

  const stale = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 2_000,
  });

  assert.equal(stale.staleExpiration?.expiresAtMs, 500_000);
});

test("does not extend expiration after repeated temporary failures", () => {
  const lifecycle = fixedRetention(600_000);
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 63 },
    observedAtMs: 1_000,
  });
  const first = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 2_000,
  });
  const second = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 3_000,
  });

  assert.equal(second.staleExpiration, first.staleExpiration);
});

test("rejects an old deadline even when a newer deadline has the same time", () => {
  const lifecycle = fixedRetention(9_000);
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 40 },
    observedAtMs: 1_000,
  });
  const oldDeadline = assertDefined(
    lifecycle.advance({ kind: "temporarily-unavailable", nowMs: 2_000 })
      .staleExpiration,
  );
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 41 },
    observedAtMs: 1_000,
  });
  const current = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 3_000,
  });

  const ignored = lifecycle.advance({
    kind: "stale-expiration-reached",
    deadline: oldDeadline,
    nowMs: 10_000,
  });

  assert.equal(ignored.publication, "preserve");
  assert.deepEqual(ignored.observation, {
    kind: "capacity",
    capacity: { value: 41 },
    freshness: "stale",
  });
  assert.notEqual(ignored.staleExpiration, oldDeadline);
  assert.equal(ignored.staleExpiration, current.staleExpiration);
});

test("rejects early and duplicate expiration events", () => {
  const lifecycle = fixedRetention(9_000);
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 40 },
    observedAtMs: 1_000,
  });
  const deadline = assertDefined(
    lifecycle.advance({ kind: "temporarily-unavailable", nowMs: 2_000 })
      .staleExpiration,
  );

  assert.equal(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadline,
      nowMs: 9_999,
    }).publication,
    "preserve",
  );
  assert.equal(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadline,
      nowMs: 10_000,
    }).publication,
    "replace",
  );
  assert.equal(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadline,
      nowMs: 10_001,
    }).publication,
    "preserve",
  );
});

test("distinguishes invalidation from authoritative unavailability", () => {
  const lifecycle = fixedRetention(600_000);

  assert.equal(
    lifecycle.advance({ kind: "invalidated" }).publication,
    "preserve",
  );
  assert.equal(
    lifecycle.advance({ kind: "unavailable" }).publication,
    "replace",
  );
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 80 },
    observedAtMs: 1_000,
  });
  assert.equal(
    lifecycle.advance({ kind: "invalidated" }).publication,
    "replace",
  );
});

test("session end discards capacity and absorbs every later event", () => {
  const lifecycle = fixedRetention(600_000);
  lifecycle.advance({
    kind: "observed",
    capacity: { value: 80 },
    observedAtMs: 1_000,
  });

  assert.deepEqual(lifecycle.advance({ kind: "session-ended" }), {
    observation: { kind: "none" },
    staleExpiration: undefined,
    publication: "preserve",
  });
  assert.deepEqual(
    lifecycle.advance({
      kind: "observed",
      capacity: { value: 90 },
      observedAtMs: Number.NaN,
    }),
    {
      observation: { kind: "none" },
      staleExpiration: undefined,
      publication: "preserve",
    },
  );
});

test("validates the contract before replacing existing capacity", () => {
  const prior = { value: 40 };
  const lifecycle = createStaleCapacityLifecycle<Capacity>({
    staleExpiresAtMs: ({ capacity, observedAtMs }) =>
      capacity.value === 99 ? Number.NaN : observedAtMs + 600_000,
  });
  lifecycle.advance({ kind: "observed", capacity: prior, observedAtMs: 1_000 });

  assert.throws(
    () =>
      lifecycle.advance({
        kind: "observed",
        capacity: { value: 99 },
        observedAtMs: 2_000,
      }),
    { name: "RangeError", message: "stale expiration must be finite" },
  );
  assert.deepEqual(lifecycle.current().observation, {
    kind: "capacity",
    capacity: prior,
    freshness: "fresh",
  });
  assert.throws(
    () =>
      lifecycle.advance({
        kind: "temporarily-unavailable",
        nowMs: Number.POSITIVE_INFINITY,
      }),
    { name: "RangeError", message: "nowMs must be finite" },
  );
});

function assertDefined<Value>(value: Value | undefined): Value {
  assert.notEqual(value, undefined);
  return value as Value;
}
