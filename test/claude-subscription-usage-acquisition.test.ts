import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, TestClock } from "effect";

import {
  claudeCredentialFingerprint,
  createAcquireClaudeSubscriptionUsage,
  type ResolveClaudeAuthentication,
} from "../src/claude-subscription-usage-acquisition.ts";

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

function oauth(key = "secret"): ResolveClaudeAuthentication {
  return Effect.succeed({ source: "OAuth", auth: { apiKey: key } });
}

function acquire(
  fetch: typeof globalThis.fetch,
  resolveAuthentication: ResolveClaudeAuthentication = oauth(),
) {
  return createAcquireClaudeSubscriptionUsage({
    fetch,
    resolveAuthentication,
  })();
}

function failureTag(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") return undefined;
  const error = exit.cause.error;
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "_tag")
    : undefined;
}

it.effect("decodes the allowlisted seven-day subscription window", () =>
  Effect.gen(function* () {
    const usage = yield* acquire(
      async () => new Response(JSON.stringify(goodBody)),
    );
    assert.deepEqual(usage, {
      usedPercent: 63.4,
      resetsAtMs: Date.parse("2026-09-18T12:34:56.789Z"),
      credentialFingerprint: claudeCredentialFingerprint({
        source: "OAuth",
        auth: { apiKey: "secret" },
      }),
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

it.effect(
  "does not request for missing, API-key, or invalid authentication",
  () =>
    Effect.gen(function* () {
      const resolutions: ResolveClaudeAuthentication[] = [
        Effect.succeed(undefined),
        Effect.succeed({
          source: "ANTHROPIC_API_KEY",
          auth: { apiKey: "key" },
        }),
        Effect.succeed({ source: "OAuth", auth: { apiKey: "   " } }),
        Effect.succeed({ source: "OAuth", auth: {} }),
      ];
      for (const resolveAuthentication of resolutions) {
        let requested = false;
        const exit = yield* Effect.exit(
          acquire(async () => {
            requested = true;
            return new Response(JSON.stringify(goodBody));
          }, resolveAuthentication),
        );
        assert.equal(failureTag(exit), "ClaudeAuthenticationUnavailable");
        assert.equal(requested, false);
      }
    }),
);

it.effect(
  "contains resolver defects without requesting or surfacing secrets",
  () =>
    Effect.gen(function* () {
      let requested = false;
      const exit = yield* Effect.exit(
        acquire(
          async () => {
            requested = true;
            return new Response(JSON.stringify(goodBody));
          },
          Effect.die(new Error("secret-resolver-detail")),
        ),
      );
      assert.equal(failureTag(exit), "ClaudeAuthenticationUnavailable");
      assert.equal(requested, false);
      assert.equal(
        JSON.stringify(exit).includes("secret-resolver-detail"),
        false,
      );
    }),
);

it.effect("uses only the fixed, minimal OAuth request contract", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    yield* acquire(async (input, init) => {
      request = [input, init];
      return new Response(JSON.stringify(goodBody));
    }, oauth("  secret  "));
    assert.equal(request?.[0], "https://api.anthropic.com/api/oauth/usage");
    assert.equal(request?.[1]?.method, "GET");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Authorization: "Bearer secret",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("re-resolves OAuth and retries authentication rejection once", () =>
  Effect.gen(function* () {
    let resolutions = 0;
    let requests = 0;
    const resolveAuthentication = Effect.sync(() => ({
      source: "OAuth",
      auth: { apiKey: `secret-${++resolutions}` },
    }));
    const usage = yield* acquire(async (_input, init) => {
      requests += 1;
      assert.deepEqual(init?.headers, {
        Authorization: `Bearer secret-${requests}`,
      });
      return requests === 1
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify(goodBody));
    }, resolveAuthentication);
    assert.equal(usage.usedPercent, 63.4);
    assert.equal(
      usage.credentialFingerprint,
      claudeCredentialFingerprint({
        source: "OAuth",
        auth: { apiKey: "secret-2" },
      }),
    );
    assert.equal(resolutions, 2);
    assert.equal(requests, 2);
  }),
);

it.effect(
  "retries a repeated 403 exactly once without surfacing response data",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const exit = yield* Effect.exit(
        acquire(async () => {
          requests += 1;
          return new Response("raw-secret-body", { status: 403 });
        }),
      );
      assert.equal(requests, 2);
      assert.equal(failureTag(exit), "ClaudeAuthenticationRejected");
      assert.equal(JSON.stringify(exit).includes("raw-secret-body"), false);
      assert.equal(JSON.stringify(exit).includes("secret"), false);
    }),
);

it.effect(
  "finalizes bodies for terminal, retryable, redirect, and repeated auth outcomes",
  () =>
    Effect.gen(function* () {
      const cases = [
        [400, "PermanentClaudeSubscriptionUsageFailure", 1],
        [302, "PermanentClaudeSubscriptionUsageFailure", 1],
        [408, "TemporaryClaudeSubscriptionUsageFailure", 1],
        [425, "TemporaryClaudeSubscriptionUsageFailure", 1],
        [429, "TemporaryClaudeSubscriptionUsageFailure", 1],
        [500, "TemporaryClaudeSubscriptionUsageFailure", 1],
        [403, "ClaudeAuthenticationRejected", 2],
      ] as const;
      for (const [status, tag, expectedRequests] of cases) {
        let cancelled = 0;
        const bodies: ReadableStream<Uint8Array>[] = [];
        const exit = yield* Effect.exit(
          acquire(async () => {
            const body = new ReadableStream<Uint8Array>({
              cancel() {
                cancelled += 1;
              },
            });
            bodies.push(body);
            return new Response(body, { status });
          }),
        );
        assert.equal(failureTag(exit), tag);
        assert.equal(cancelled, expectedRequests);
        assert.equal(bodies.length, expectedRequests);
        assert.equal(
          bodies.every((body) => !body.locked),
          true,
        );
      }
    }),
);

it.effect(
  "keeps an OAuth-authenticated 429 separate from authentication metadata",
  () =>
    Effect.gen(function* () {
      let resolutions = 0;
      let requests = 0;
      const exit = yield* Effect.exit(
        acquire(
          async (_input, init) => {
            requests += 1;
            assert.deepEqual(init?.headers, {
              Authorization: "Bearer oauth-secret",
            });
            return new Response("rate-limit-raw-secret", { status: 429 });
          },
          Effect.sync(() => {
            resolutions += 1;
            return {
              source: "OAuth",
              auth: { apiKey: "oauth-secret" },
            };
          }),
        ),
      );
      assert.equal(failureTag(exit), "TemporaryClaudeSubscriptionUsageFailure");
      assert.equal(resolutions, 1);
      assert.equal(requests, 1);
      assert.equal(JSON.stringify(exit).includes("oauth-secret"), false);
      assert.equal(
        JSON.stringify(exit).includes("rate-limit-raw-secret"),
        false,
      );
    }),
);

it.effect("keeps every unsuccessful exchange outcome secret-safe", () =>
  Effect.gen(function* () {
    const cases = [
      [400, "PermanentClaudeSubscriptionUsageFailure", 1],
      [404, "PermanentClaudeSubscriptionUsageFailure", 1],
      [302, "PermanentClaudeSubscriptionUsageFailure", 1],
      [408, "TemporaryClaudeSubscriptionUsageFailure", 1],
      [425, "TemporaryClaudeSubscriptionUsageFailure", 1],
      [429, "TemporaryClaudeSubscriptionUsageFailure", 1],
      [503, "TemporaryClaudeSubscriptionUsageFailure", 1],
      [401, "ClaudeAuthenticationRejected", 2],
      [403, "ClaudeAuthenticationRejected", 2],
      [200, "MalformedClaudeSubscriptionUsage", 1],
    ] as const;
    for (const [status, expectedTag, expectedRequests] of cases) {
      let requests = 0;
      const exit = yield* Effect.exit(
        acquire(async () => {
          requests += 1;
          return new Response("raw-response-secret", {
            status,
            headers: { "x-authenticated-secret": "header-secret" },
          });
        }, oauth("credential-secret")),
      );
      const serialized = JSON.stringify(exit);
      assert.equal(failureTag(exit), expectedTag);
      assert.equal(requests, expectedRequests);
      for (const secret of [
        "credential-secret",
        "raw-response-secret",
        "header-secret",
        "x-authenticated-secret",
      ]) {
        assert.equal(
          serialized.includes(secret),
          false,
          `${status}: ${secret}`,
        );
      }
    }

    const networkExit = yield* Effect.exit(
      acquire(async () => {
        throw new Error("transport-secret");
      }, oauth("credential-secret")),
    );
    assert.equal(
      failureTag(networkExit),
      "TemporaryClaudeSubscriptionUsageFailure",
    );
    assert.equal(JSON.stringify(networkExit).includes("secret"), false);
  }),
);

it.effect("honors valid Retry-After instructions", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "7" },
          }),
      ),
    );
    assert.equal(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? Reflect.get(exit.cause.error, "retryAtMs")
        : undefined,
      7_000,
    );
  }),
);

it("creates a normalized non-reversible credential identity", () => {
  const fingerprint = claudeCredentialFingerprint({
    source: "OAuth",
    auth: { apiKey: "  secret  " },
  });
  assert.equal(fingerprint?.length, 64);
  assert.equal(fingerprint?.includes("secret"), false);
  assert.equal(
    fingerprint,
    claudeCredentialFingerprint({
      source: "OAuth",
      auth: { apiKey: "secret" },
    }),
  );
});

it.effect("enforces the five-second timeout", () =>
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
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "TemporaryClaudeSubscriptionUsageFailure",
    );
  }),
);

it.effect("times out and cancels a stalled response body", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const fiber = yield* Effect.fork(
      Effect.exit(
        acquire(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull() {},
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        ),
      ),
    );
    yield* Effect.yieldNow();
    yield* TestClock.adjust("5 seconds");
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "TemporaryClaudeSubscriptionUsageFailure",
    );
    assert.equal(cancelled, true);
  }),
);

it.effect("awaits streamed response cancellation before completing", () =>
  Effect.gen(function* () {
    let cancelStarted = false;
    let finishCancellation: (() => void) | undefined;
    const fiber = yield* Effect.fork(
      Effect.exit(
        acquire(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(64 * 1024 + 1));
                },
                cancel() {
                  cancelStarted = true;
                  return new Promise<void>((resolve) => {
                    finishCancellation = resolve;
                  });
                },
              }),
            ),
        ),
      ),
    );
    while (!cancelStarted) yield* Effect.yieldNow();
    yield* Effect.promise<void>(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
    assert.equal((yield* Fiber.poll(fiber))._tag, "None");
    assert.ok(finishCancellation);
    finishCancellation();
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "MalformedClaudeSubscriptionUsage",
    );
  }),
);

it.effect(
  "awaits cancellation and releases the lock for an oversized declared body",
  () =>
    Effect.gen(function* () {
      let cancelStarted = false;
      let finishCancellation: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelStarted = true;
          return new Promise<void>((resolve) => {
            finishCancellation = resolve;
          });
        },
      });
      const fiber = yield* Effect.fork(
        Effect.exit(
          acquire(
            async () =>
              new Response(body, {
                headers: { "content-length": String(64 * 1024 + 1) },
              }),
          ),
        ),
      );
      while (!cancelStarted) yield* Effect.yieldNow();
      assert.equal((yield* Fiber.poll(fiber))._tag, "None");
      assert.equal(body.locked, true);
      assert.ok(finishCancellation);
      finishCancellation();
      assert.equal(
        failureTag(yield* Fiber.join(fiber)),
        "MalformedClaudeSubscriptionUsage",
      );
      assert.equal(body.locked, false);
    }),
);

it.effect("bounds declared and streamed response bodies at 64 KiB", () =>
  Effect.gen(function* () {
    const declared = yield* Effect.exit(
      acquire(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      ),
    );
    assert.equal(failureTag(declared), "MalformedClaudeSubscriptionUsage");

    let cancelled = false;
    const streamed = yield* Effect.exit(
      acquire(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(64 * 1024 + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    );
    assert.equal(failureTag(streamed), "MalformedClaudeSubscriptionUsage");
    assert.equal(cancelled, true);
  }),
);
