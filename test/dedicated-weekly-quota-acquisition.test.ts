import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, TestClock } from "effect";

import { createAcquireDedicatedWeeklyQuotaUsage } from "../src/dedicated-weekly-quota-acquisition.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const credential = { accessToken: "secret", accountId: "account-1" };
const usageBody = () => ({
  rate_limit: {
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
    secondary_window: {
      used_percent: 63.4,
      limit_window_seconds: WEEK_SECONDS,
      reset_at: 3_000,
    },
  },
});

function acquire(fetch: typeof globalThis.fetch) {
  return createAcquireDedicatedWeeklyQuotaUsage({ fetch })(credential);
}

it.effect("decodes weekly usage and optional reset credits", () =>
  Effect.gen(function* () {
    const body = {
      ...usageBody(),
      rate_limit_reset_credits: { available_count: 2 },
    };
    const usage = yield* acquire(
      async () => new Response(JSON.stringify(body)),
    );
    assert.deepEqual(usage, {
      usedPercent: 63.4,
      resetsAtMs: 3_000_000,
      windowPosition: "secondary",
      availableLimitResetCredits: 2,
    });
  }),
);

it.effect("ignores malformed optional reset credits", () =>
  Effect.gen(function* () {
    for (const rate_limit_reset_credits of [
      { available_count: -1 },
      null,
      "malformed",
    ]) {
      const body = { ...usageBody(), rate_limit_reset_credits };
      const usage = yield* acquire(
        async () => new Response(JSON.stringify(body)),
      );
      assert.equal(usage.availableLimitResetCredits, undefined);
    }
  }),
);

it.effect("rejects reset timestamps that overflow epoch milliseconds", () =>
  Effect.gen(function* () {
    const body = usageBody();
    body.rate_limit.secondary_window.reset_at = Number.MAX_VALUE;
    const exit = yield* Effect.exit(
      acquire(async () => new Response(JSON.stringify(body))),
    );
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : undefined,
      "MalformedAcquisition",
    );
  }),
);

it.effect("expresses HTTP outcomes as typed failures", () =>
  Effect.gen(function* () {
    const cases = [
      [401, "AuthenticationRejected"],
      [302, "PermanentAcquisitionFailure"],
      [408, "TemporaryAcquisitionFailure"],
      [500, "TemporaryAcquisitionFailure"],
    ] as const;
    for (const [status, tag] of cases) {
      const exit = yield* Effect.exit(
        acquire(async () => new Response(null, { status })),
      );
      assert.equal(
        Exit.isFailure(exit) && exit.cause._tag === "Fail"
          ? exit.cause.error._tag
          : undefined,
        tag,
      );
    }
  }),
);

it.effect("normalizes Retry-After", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      ),
    );
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : undefined,
      "TemporaryAcquisitionFailure",
    );
    if (
      Exit.isFailure(exit) &&
      exit.cause._tag === "Fail" &&
      exit.cause.error._tag === "TemporaryAcquisitionFailure"
    ) {
      assert.equal(exit.cause.error.retryAtMs, 120_000);
    }
  }),
);

it.effect("rejects invalid Retry-After syntax", () =>
  Effect.gen(function* () {
    for (const value of ["1.5", "-10", "+5", "0x10", "later"]) {
      const exit = yield* Effect.exit(
        acquire(
          async () =>
            new Response(null, {
              status: 429,
              headers: { "retry-after": value },
            }),
        ),
      );
      if (
        Exit.isFailure(exit) &&
        exit.cause._tag === "Fail" &&
        exit.cause.error._tag === "TemporaryAcquisitionFailure"
      ) {
        assert.equal(exit.cause.error.retryAtMs, undefined);
      } else {
        assert.fail("expected a temporary acquisition failure");
      }
    }
  }),
);

it.effect("maps transport failures to a typed temporary failure", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(async () => {
        throw new Error("network unavailable");
      }),
    );
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : undefined,
      "TemporaryAcquisitionFailure",
    );
  }),
);

it.effect("times out through the Effect clock", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      Effect.exit(
        acquire(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        ),
      ),
    );
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Fiber.join(fiber);
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : undefined,
      "TemporaryAcquisitionFailure",
    );
  }),
);

it.effect("interrupts response-body reads when the timeout expires", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const fiber = yield* Effect.fork(
      Effect.exit(acquire(async () => new Response(stream))),
    );
    yield* Effect.yieldNow();
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Fiber.join(fiber);
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : undefined,
      "TemporaryAcquisitionFailure",
    );
    assert.equal(cancelled, true);
  }),
);

it.effect("bounds declared and streamed bodies", () =>
  Effect.gen(function* () {
    const declared = yield* Effect.exit(
      acquire(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(1024 * 1024 + 1) },
          }),
      ),
    );
    assert.equal(
      Exit.isFailure(declared) && declared.cause._tag === "Fail"
        ? declared.cause.error._tag
        : undefined,
      "MalformedAcquisition",
    );

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = yield* Effect.exit(
      acquire(async () => new Response(stream)),
    );
    assert.equal(
      Exit.isFailure(streamed) && streamed.cause._tag === "Fail"
        ? streamed.cause.error._tag
        : undefined,
      "MalformedAcquisition",
    );
    assert.equal(cancelled, true);
  }),
);

it.effect("uses only the fixed endpoint and rejects redirects", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    yield* acquire(async (input, init) => {
      request = [input, init];
      return new Response(JSON.stringify(usageBody()));
    });
    assert.equal(request?.[0], "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Authorization: "Bearer secret",
      "ChatGPT-Account-Id": "account-1",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("rejects invalid JSON and malformed observations", () =>
  Effect.gen(function* () {
    for (const response of [
      new Response("{"),
      new Response(JSON.stringify({ rate_limit: {} })),
    ]) {
      const exit = yield* Effect.exit(acquire(async () => response));
      assert.equal(
        Exit.isFailure(exit) && exit.cause._tag === "Fail"
          ? exit.cause.error._tag
          : undefined,
        "MalformedAcquisition",
      );
    }
  }),
);
