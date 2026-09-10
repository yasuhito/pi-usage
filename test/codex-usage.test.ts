import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexUsageRequestError,
  parseCodexRateLimitHeaders,
  readCodexWeeklyUsage,
} from "../src/codex-usage.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

test("reads the seven-day window from the base Codex rate limit", async () => {
  const fetchStub: typeof fetch = async () =>
    new Response(
      JSON.stringify({
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
      }),
      { status: 200 },
    );

  assert.deepEqual(
    await readCodexWeeklyUsage(
      { accessToken: "secret", accountId: "account-1" },
      fetchStub,
    ),
    { usedPercent: 63.4, resetsAt: 3_000 },
  );
});

test("rejects an unsuccessful usage response even when its body looks valid", async () => {
  const fetchStub: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: WEEK_SECONDS,
            reset_at: 3_000,
          },
        },
      }),
      { status: 500 },
    );

  await assert.rejects(
    readCodexWeeklyUsage(
      { accessToken: "secret", accountId: "account-1" },
      fetchStub,
    ),
    /Codex usage request failed with status 500/,
  );
});

test("rejects a usage response larger than one MiB before parsing it", async () => {
  const fetchStub: typeof fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(1024 * 1024 + 1) },
    });

  await assert.rejects(
    readCodexWeeklyUsage(
      { accessToken: "secret", accountId: "account-1" },
      fetchStub,
    ),
    /Codex usage response is too large/,
  );
});

test("sends credentials only to the fixed endpoint without following redirects", async () => {
  let request: {
    input: string | URL | Request | undefined;
    init: RequestInit | undefined;
  } = { input: undefined, init: undefined };
  const fetchStub: typeof fetch = async (input, init) => {
    request = { input, init };
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: WEEK_SECONDS,
            reset_at: 3_000,
          },
        },
      }),
    );
  };

  await readCodexWeeklyUsage(
    { accessToken: "secret", accountId: "account-1" },
    fetchStub,
  );

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

test("reads a seven-day secondary window from Codex response headers", () => {
  assert.deepEqual(
    parseCodexRateLimitHeaders({
      "x-codex-secondary-used-percent": "72.5",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    }),
    { usedPercent: 72.5, resetsAt: 4_000 },
  );
});

test("combines caller cancellation with the five-second request timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  let requestWasAborted = false;
  const fetchStub: typeof fetch = async (_input, init) => {
    requestWasAborted = init?.signal?.aborted ?? false;
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: WEEK_SECONDS,
            reset_at: 3_000,
          },
        },
      }),
    );
  };

  await readCodexWeeklyUsage(
    { accessToken: "secret", accountId: "account-1" },
    fetchStub,
    controller.signal,
  );

  assert.equal(requestWasAborted, true);
});

test("a rate-limited response exposes Retry-After without reading its body", async () => {
  const fetchStub: typeof fetch = async () =>
    new Response("sensitive error body", {
      status: 429,
      headers: { "retry-after": "120" },
    });

  await assert.rejects(
    readCodexWeeklyUsage(
      { accessToken: "secret", accountId: "account-1" },
      fetchStub,
    ),
    (error: unknown) =>
      error instanceof CodexUsageRequestError &&
      error.status === 429 &&
      error.retryAfter === "120",
  );
});
