import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";

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

function failureTag(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") return undefined;
  const error = exit.cause.error;
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "_tag")
    : undefined;
}

function retryAtMs(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") return undefined;
  const error = exit.cause.error;
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "retryAtMs")
    : undefined;
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
    assert.equal(failureTag(exit), "MalformedAcquisition");
  }),
);

it.effect("rejects malformed observations without carrying them", () =>
  Effect.gen(function* () {
    const body = usageBody();
    for (const rate_limit of [
      {},
      {
        secondary_window: {
          ...body.rate_limit.secondary_window,
          used_percent: "raw-response-secret",
        },
      },
    ]) {
      const exit = yield* Effect.exit(
        acquire(async () => new Response(JSON.stringify({ rate_limit }))),
      );
      assert.equal(failureTag(exit), "MalformedAcquisition");
      assert.equal(JSON.stringify(exit).includes("raw-response-secret"), false);
    }
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
    assert.equal(request?.[1]?.method, "GET");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Authorization: "Bearer secret",
      "ChatGPT-Account-Id": "account-1",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("bounds response bodies at 1 MiB", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(1024 * 1024 + 1) },
          }),
      ),
    );
    assert.equal(failureTag(exit), "MalformedAcquisition");
  }),
);

it.effect("maps every exchange outcome to an acquisition failure", () =>
  Effect.gen(function* () {
    for (const [status, tag] of [
      [401, "AuthenticationRejected"],
      [403, "AuthenticationRejected"],
      [408, "TemporaryAcquisitionFailure"],
      [425, "TemporaryAcquisitionFailure"],
      [429, "TemporaryAcquisitionFailure"],
      [500, "TemporaryAcquisitionFailure"],
      [302, "PermanentAcquisitionFailure"],
      [400, "PermanentAcquisitionFailure"],
    ] as const) {
      const exit = yield* Effect.exit(
        acquire(async () => new Response("{", { status })),
      );
      assert.equal(failureTag(exit), tag, String(status));
    }
    const malformed = yield* Effect.exit(
      acquire(async () => new Response("{")),
    );
    assert.equal(failureTag(malformed), "MalformedAcquisition");

    const rejected = yield* Effect.exit(
      acquire(async () => {
        throw new Error("network unavailable");
      }),
    );
    assert.equal(failureTag(rejected), "TemporaryAcquisitionFailure");
    assert.equal(retryAtMs(rejected), undefined);
  }),
);

it.effect("honors Retry-After only while rate limited", () =>
  Effect.gen(function* () {
    for (const [status, expected] of [
      [429, 120_000],
      [503, undefined],
    ] as const) {
      const exit = yield* Effect.exit(
        acquire(
          async () =>
            new Response(null, {
              status,
              headers: { "retry-after": "120" },
            }),
        ),
      );
      assert.equal(failureTag(exit), "TemporaryAcquisitionFailure");
      assert.equal(retryAtMs(exit), expected, String(status));
    }
  }),
);
