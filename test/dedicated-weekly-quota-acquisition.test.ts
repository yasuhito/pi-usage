import assert from "node:assert/strict";
import test from "node:test";

import { createAcquireDedicatedWeeklyQuotaUsage } from "../src/dedicated-weekly-quota-acquisition.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const credential = { accessToken: "secret", accountId: "account-1" };

function acquisition(fetchStub: typeof fetch, now = 1_000_000) {
  return createAcquireDedicatedWeeklyQuotaUsage({
    fetch: fetchStub,
    now: () => now,
  });
}

function usageBody() {
  return {
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
  };
}

function usageResponse(): Response {
  return new Response(JSON.stringify(usageBody()));
}

test("returns interpreted weekly quota usage", async () => {
  const acquire = acquisition(async () => usageResponse());

  assert.deepEqual(await acquire(credential), {
    kind: "acquired",
    usage: {
      usedPercent: 63.4,
      resetsAtMs: 3_000_000,
      windowPosition: "secondary",
    },
  });
});

test("captures a valid available limit reset credit count", async () => {
  const body = {
    ...usageBody(),
    rate_limit_reset_credits: { available_count: 2 },
  };
  const acquire = acquisition(async () => new Response(JSON.stringify(body)));

  assert.deepEqual(await acquire(credential), {
    kind: "acquired",
    usage: {
      usedPercent: 63.4,
      resetsAtMs: 3_000_000,
      windowPosition: "secondary",
      availableLimitResetCredits: 2,
    },
  });
});

test("ignores a malformed optional limit reset credit count", async () => {
  const body = {
    ...usageBody(),
    rate_limit_reset_credits: { available_count: -1 },
  };
  const acquire = acquisition(async () => new Response(JSON.stringify(body)));

  assert.deepEqual(await acquire(credential), {
    kind: "acquired",
    usage: {
      usedPercent: 63.4,
      resetsAtMs: 3_000_000,
      windowPosition: "secondary",
    },
  });
});

test("rejects a weekly reset time that overflows epoch milliseconds", async () => {
  const body = usageBody();
  body.rate_limit.secondary_window.reset_at = Number.MAX_VALUE;
  const acquire = acquisition(async () => new Response(JSON.stringify(body)));

  assert.deepEqual(await acquire(credential), {
    kind: "malformed-observation",
  });
});

test("maps unsuccessful responses to lifecycle meanings without reading their bodies", async () => {
  const cases = [
    [401, { kind: "authentication-rejected" }],
    [403, { kind: "authentication-rejected" }],
    [400, { kind: "permanently-unavailable" }],
    [302, { kind: "permanently-unavailable" }],
    [408, { kind: "temporary-failure", retryAtMs: undefined }],
    [425, { kind: "temporary-failure", retryAtMs: undefined }],
    [500, { kind: "temporary-failure", retryAtMs: undefined }],
  ] as const;

  for (const [status, expected] of cases) {
    const acquire = acquisition(
      async () => new Response("sensitive invalid JSON", { status }),
    );
    assert.deepEqual(await acquire(credential), expected);
  }
});

test("normalizes numeric and dated Retry-After values", async () => {
  const numeric = acquisition(
    async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  const dated = acquisition(
    async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": new Date(1_200_000).toUTCString() },
      }),
  );
  const invalid = acquisition(
    async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": "later" },
      }),
  );

  assert.deepEqual(await numeric(credential), {
    kind: "temporary-failure",
    retryAtMs: 1_120_000,
  });
  assert.deepEqual(await dated(credential), {
    kind: "temporary-failure",
    retryAtMs: 1_200_000,
  });
  assert.deepEqual(await invalid(credential), {
    kind: "temporary-failure",
    retryAtMs: undefined,
  });
});

test("ignores invalid Retry-After delay syntax", async () => {
  for (const retryAfter of ["1.5", "-10", "+5", "0x10"]) {
    const acquire = acquisition(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": retryAfter },
        }),
    );

    assert.deepEqual(await acquire(credential), {
      kind: "temporary-failure",
      retryAtMs: undefined,
    });
  }
});

test("times out an unresponsive request after five seconds", {
  timeout: 6_000,
}, async () => {
  const acquire = acquisition(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  const keepAlive = setTimeout(() => {}, 6_000);
  const startedAt = Date.now();

  try {
    assert.deepEqual(await acquire(credential), {
      kind: "temporary-failure",
      retryAtMs: undefined,
    });
    assert.ok(Date.now() - startedAt >= 4_900);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("marks a response larger than one MiB as malformed before parsing", async () => {
  const acquire = acquisition(
    async () =>
      new Response("{}", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
  );

  assert.deepEqual(await acquire(credential), {
    kind: "malformed-observation",
  });
});

test("cancels a streaming response as soon as it exceeds one MiB", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const acquire = acquisition(async () => new Response(body));

  assert.deepEqual(await acquire(credential), {
    kind: "malformed-observation",
  });
  assert.equal(cancelled, true);
});

test("sends credentials only to the fixed endpoint without following redirects", async () => {
  let request: {
    input: string | URL | Request | undefined;
    init: RequestInit | undefined;
  } = { input: undefined, init: undefined };
  const acquire = acquisition(async (input, init) => {
    request = { input, init };
    return usageResponse();
  });

  await acquire(credential);

  assert.deepEqual(
    {
      input: request.input,
      method: request.init?.method,
      redirect: request.init?.redirect,
      headers: request.init?.headers,
      hasSignal: request.init?.signal instanceof AbortSignal,
    },
    {
      input: "https://chatgpt.com/backend-api/wham/usage",
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: "Bearer secret",
        "ChatGPT-Account-Id": "account-1",
      },
      hasSignal: true,
    },
  );
});

test("preserves caller cancellation without issuing a request", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled");
  controller.abort(cancellation);
  let requested = false;
  const acquire = acquisition(async () => {
    requested = true;
    return usageResponse();
  });

  await assert.rejects(acquire(credential, controller.signal), cancellation);
  assert.equal(requested, false);
});

test("maps transport failures to temporary failure", async () => {
  const acquire = acquisition(async () => {
    throw new Error("network unavailable");
  });

  assert.deepEqual(await acquire(credential), {
    kind: "temporary-failure",
    retryAtMs: undefined,
  });
});

test("rejects invalid JSON and malformed weekly quota observations", async () => {
  const invalidJson = acquisition(async () => new Response("{"));
  const missingWeeklyWindow = acquisition(
    async () => new Response(JSON.stringify({ rate_limit: {} })),
  );

  assert.deepEqual(await invalidJson(credential), {
    kind: "malformed-observation",
  });
  assert.deepEqual(await missingWeeklyWindow(credential), {
    kind: "malformed-observation",
  });
});
