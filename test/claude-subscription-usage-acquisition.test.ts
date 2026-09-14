import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  type ClaudeOAuthCredential,
  createAcquireClaudeSubscriptionUsage,
} from "../src/claude-subscription-usage-acquisition.ts";
import { immediateAcquisitionCoordinator } from "./fixtures/immediate-acquisition-coordinator.ts";

const goodBody = {
  five_hour: null,
  seven_day: {
    utilization: 63.4,
    resets_at: "2026-09-18T12:34:56.789Z",
    future_field: true,
  },
  seven_day_oauth_apps: null,
  extra_usage: { enabled: false },
};

function validatedCredential(value: string): ClaudeOAuthCredential {
  return value as ClaudeOAuthCredential;
}

function acquire(fetch: typeof globalThis.fetch, credential = "secret") {
  return createAcquireClaudeSubscriptionUsage({
    fetch,
    acquisitionCoordinator: immediateAcquisitionCoordinator,
  })(validatedCredential(credential));
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

it.effect(
  "uses a coordinated successful observation without another request",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const usage = yield* createAcquireClaudeSubscriptionUsage({
        fetch: async () => {
          requests += 1;
          return new Response(JSON.stringify(goodBody));
        },
        acquisitionCoordinator: {
          coordinate: (request) => {
            const value = request.decode({
              usedPercent: 27,
              resetsAtMs: Date.parse("2026-09-18T12:34:56.789Z"),
            });
            return value === undefined
              ? Effect.die("test fixture failed to decode")
              : Effect.succeed({
                  kind: "success" as const,
                  value,
                  observedAtMs: 1_000,
                });
          },
        },
      })(validatedCredential("secret"));

      assert.equal(requests, 0);
      assert.deepEqual(usage, {
        usedPercent: 27,
        resetsAtMs: Date.parse("2026-09-18T12:34:56.789Z"),
        observedAtMs: 1_000,
      });
    }),
);

it.effect(
  "carries a coordinated preceding observation through shared backoff",
  () =>
    Effect.gen(function* () {
      const resetsAtMs = Date.parse("2026-09-18T12:34:56.789Z");
      const exit = yield* Effect.exit(
        createAcquireClaudeSubscriptionUsage({
          fetch: async () => new Response(JSON.stringify(goodBody)),
          acquisitionCoordinator: {
            coordinate: (request) => {
              const value = request.decode({ usedPercent: 27, resetsAtMs });
              return value === undefined
                ? Effect.die("test fixture failed to decode")
                : Effect.succeed({
                    kind: "deferred" as const,
                    reason: "temporary" as const,
                    retryAtMs: 900_000,
                    stale: { value, observedAtMs: 1_000 },
                  });
            },
          },
        })(validatedCredential("secret")),
      );

      assert.equal(Exit.isFailure(exit), true);
      assert.deepEqual(
        Exit.isFailure(exit) && exit.cause._tag === "Fail"
          ? Reflect.get(exit.cause.error, "staleUsage")
          : undefined,
        {
          usedPercent: 27,
          resetsAtMs,
          observedAtMs: 1_000,
        },
      );
    }),
);

it.effect("decodes the allowlisted seven-day subscription window", () =>
  Effect.gen(function* () {
    const usage = yield* acquire(
      async () => new Response(JSON.stringify(goodBody)),
    );
    assert.deepEqual(usage, {
      usedPercent: 63.4,
      resetsAtMs: Date.parse("2026-09-18T12:34:56.789Z"),
      observedAtMs: 0,
    });
  }),
);

it.effect("rejects malformed required weekly data without clamping", () =>
  Effect.gen(function* () {
    for (const seven_day of [
      undefined,
      null,
      { utilization: -1, resets_at: "2026-09-18T12:34:56Z" },
      { utilization: 101, resets_at: "2026-09-18T12:34:56Z" },
      { utilization: 50, resets_at: "not-an-instant" },
      { utilization: 50, resets_at: "2026-02-30T00:00:00Z" },
      { utilization: 50, resets_at: "2026-09-18" },
      { utilization: 50, resets_at: "1969-01-01T00:00:00Z" },
      { utilization: 50, resets_at: "+275760-09-13T00:00:00.001Z" },
      { utilization: "raw-response-secret", resets_at: "2026-09-18T12:34:56Z" },
    ]) {
      const exit = yield* Effect.exit(
        acquire(
          async () => new Response(JSON.stringify({ ...goodBody, seven_day })),
        ),
      );
      assert.equal(
        failureTag(exit),
        "MalformedClaudeSubscriptionUsage",
        JSON.stringify(seven_day),
      );
      assert.equal(JSON.stringify(exit).includes("raw-response-secret"), false);
    }
  }),
);

it.effect("rejects non-finite utilization without publication", () =>
  Effect.gen(function* () {
    for (const utilization of ["NaN", "1e400", "-1e400"]) {
      const exit = yield* Effect.exit(
        acquire(
          async () =>
            new Response(
              `{"seven_day":{"utilization":${utilization},"resets_at":"2026-09-18T12:34:56Z"}}`,
            ),
        ),
      );
      assert.equal(
        failureTag(exit),
        "MalformedClaudeSubscriptionUsage",
        utilization,
      );
    }
  }),
);

it.effect("applies the additive and optional-window response contract", () =>
  Effect.gen(function* () {
    const acceptedBodies = [
      {
        seven_day: goodBody.seven_day,
      },
      {
        five_hour: null,
        seven_day: goodBody.seven_day,
        seven_day_opus: null,
        unknown_top_level: { raw: true },
      },
      {
        seven_day: {
          utilization: 63.4,
          resets_at: "2026-09-18T12:34Z",
        },
      },
    ];
    for (const body of acceptedBodies) {
      const usage = yield* acquire(
        async () => new Response(JSON.stringify(body)),
      );
      assert.equal(usage.usedPercent, 63.4);
    }

    for (const body of ["", "{", "{}", '{"seven_day":null}']) {
      const exit = yield* Effect.exit(acquire(async () => new Response(body)));
      assert.equal(failureTag(exit), "MalformedClaudeSubscriptionUsage", body);
    }
  }),
);

it.effect("accepts utilization boundaries without sibling windows", () =>
  Effect.gen(function* () {
    for (const utilization of [0, 100]) {
      const usage = yield* acquire(
        async () =>
          new Response(
            JSON.stringify({
              seven_day: {
                utilization,
                resets_at: "2026-09-18T12:34:56.789Z",
              },
            }),
          ),
      );
      assert.equal(usage.usedPercent, utilization);
    }
  }),
);

it.effect("uses the fixed Claude Code OAuth request contract", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    yield* acquire(async (input, init) => {
      request = [input, init];
      return new Response(JSON.stringify(goodBody));
    }, "secret");
    assert.equal(request?.[0], "https://api.anthropic.com/api/oauth/usage");
    assert.equal(request?.[1]?.method, "GET");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Accept: "application/json",
      Authorization: "Bearer secret",
      "User-Agent": "claude-cli/2.1.251",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect(
  "maps every exchange outcome to an acquisition failure without retrying",
  () =>
    Effect.gen(function* () {
      const cases = [
        [400, "PermanentClaudeSubscriptionUsageFailure"],
        [404, "PermanentClaudeSubscriptionUsageFailure"],
        [302, "PermanentClaudeSubscriptionUsageFailure"],
        [408, "TemporaryClaudeSubscriptionUsageFailure"],
        [425, "TemporaryClaudeSubscriptionUsageFailure"],
        [429, "TemporaryClaudeSubscriptionUsageFailure"],
        [503, "TemporaryClaudeSubscriptionUsageFailure"],
        [401, "ClaudeAuthenticationRejected"],
        [403, "ClaudeAuthenticationRejected"],
        [200, "MalformedClaudeSubscriptionUsage"],
      ] as const;
      for (const [status, expectedTag] of cases) {
        let requests = 0;
        const exit = yield* Effect.exit(
          acquire(async (_input, init) => {
            requests += 1;
            assert.equal(
              (init?.headers as Record<string, string> | undefined)
                ?.Authorization,
              "Bearer oauth-secret",
            );
            return new Response("raw-response-secret", { status });
          }, "oauth-secret"),
        );
        assert.equal(failureTag(exit), expectedTag, String(status));
        assert.equal(requests, 1, String(status));
      }

      const rejected = yield* Effect.exit(
        acquire(async () => {
          throw new Error("network unavailable");
        }),
      );
      assert.equal(
        failureTag(rejected),
        "TemporaryClaudeSubscriptionUsageFailure",
      );
    }),
);

it.effect("floors 429 retry instructions at fifteen minutes only", () =>
  Effect.gen(function* () {
    for (const [retryAfter, expectedRetryAtMs] of [
      ["0", 900_000],
      ["7", 900_000],
      ["300", 900_000],
      ["1200", 1_200_000],
    ] as const) {
      const exit = yield* Effect.exit(
        acquire(
          async () =>
            new Response(null, {
              status: 429,
              headers: { "retry-after": retryAfter },
            }),
        ),
      );
      assert.equal(retryAtMs(exit), expectedRetryAtMs, retryAfter);
    }
    const unfloored = yield* Effect.exit(
      acquire(
        async () =>
          new Response(null, {
            status: 503,
            headers: { "retry-after": "7" },
          }),
      ),
    );
    assert.equal(
      failureTag(unfloored),
      "TemporaryClaudeSubscriptionUsageFailure",
    );
    assert.equal(retryAtMs(unfloored), 7_000);
  }),
);

it.effect("bounds response bodies at 64 KiB", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      ),
    );
    assert.equal(failureTag(exit), "MalformedClaudeSubscriptionUsage");
  }),
);
