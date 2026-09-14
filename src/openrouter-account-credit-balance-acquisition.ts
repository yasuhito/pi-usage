import { Clock, Data, Effect, Schema } from "effect";

import {
  readBoundedResponseBody,
  withFinalizedResponseBody,
} from "./bounded-response-body.ts";
import type { OpenRouterManagementKey } from "./openrouter-management-key-resolution.ts";
import { retryAfterDeadlineMs } from "./retry-after.ts";

export type { OpenRouterManagementKey } from "./openrouter-management-key-resolution.ts";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface AcquiredOpenRouterAccountCreditBalance {
  readonly totalCreditsUsd: number;
  readonly totalUsageUsd: number;
  readonly balanceUsd: number;
}

export class OpenRouterManagementAuthenticationRejected extends Data.TaggedError(
  "OpenRouterManagementAuthenticationRejected",
) {}
export class TemporaryOpenRouterAccountCreditBalanceFailure extends Data.TaggedError(
  "TemporaryOpenRouterAccountCreditBalanceFailure",
)<{ readonly retryAtMs?: number }> {
  constructor(options: { readonly retryAtMs?: number } = {}) {
    super(options);
  }
}
export class PermanentOpenRouterAccountCreditBalanceFailure extends Data.TaggedError(
  "PermanentOpenRouterAccountCreditBalanceFailure",
) {}
export class MalformedOpenRouterAccountCreditBalance extends Data.TaggedError(
  "MalformedOpenRouterAccountCreditBalance",
) {}

export type OpenRouterAccountCreditBalanceAcquisitionError =
  | OpenRouterManagementAuthenticationRejected
  | TemporaryOpenRouterAccountCreditBalanceFailure
  | PermanentOpenRouterAccountCreditBalanceFailure
  | MalformedOpenRouterAccountCreditBalance;

export type AcquireOpenRouterAccountCreditBalance = (
  managementKey: OpenRouterManagementKey,
) => Effect.Effect<
  AcquiredOpenRouterAccountCreditBalance,
  OpenRouterAccountCreditBalanceAcquisitionError
>;

export interface OpenRouterAccountCreditBalanceAcquisitionDependencies {
  readonly fetch: typeof fetch;
}

const OpenRouterCreditsBody = Schema.Struct({
  data: Schema.Struct({
    total_credits: Schema.Number,
    total_usage: Schema.Number,
  }),
});

function requestBalance(
  fetchImplementation: typeof fetch,
  key: string,
): Effect.Effect<Response, TemporaryOpenRouterAccountCreditBalanceFailure> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImplementation(OPENROUTER_CREDITS_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
        },
        redirect: "manual",
        signal,
      }),
    catch: () => new TemporaryOpenRouterAccountCreditBalanceFailure(),
  });
}

function classifyResponse(
  response: Response,
): Effect.Effect<Response, OpenRouterAccountCreditBalanceAcquisitionError> {
  if (response.ok) return Effect.succeed(response);
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(new OpenRouterManagementAuthenticationRejected());
  }
  if (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => {
        const retryDeadline = retryAfterDeadlineMs(response, nowMs);
        return Effect.fail(
          new TemporaryOpenRouterAccountCreditBalanceFailure(
            retryDeadline === undefined ? {} : { retryAtMs: retryDeadline },
          ),
        );
      }),
    );
  }
  return Effect.fail(new PermanentOpenRouterAccountCreditBalanceFailure());
}

export function createAcquireOpenRouterAccountCreditBalance(
  dependencies: OpenRouterAccountCreditBalanceAcquisitionDependencies,
): AcquireOpenRouterAccountCreditBalance {
  const decodeBalance = (response: Response) =>
    Effect.gen(function* () {
      const text = yield* readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new MalformedOpenRouterAccountCreditBalance(),
        () => new TemporaryOpenRouterAccountCreditBalanceFailure(),
      );
      let unknownBody: unknown;
      try {
        unknownBody = JSON.parse(text) as unknown;
      } catch {
        return yield* new MalformedOpenRouterAccountCreditBalance();
      }
      const body = yield* Schema.decodeUnknown(OpenRouterCreditsBody)(
        unknownBody,
      ).pipe(
        Effect.mapError(() => new MalformedOpenRouterAccountCreditBalance()),
      );
      const totalCreditsUsd = body.data.total_credits;
      const totalUsageUsd = body.data.total_usage;
      if (
        !Number.isFinite(totalCreditsUsd) ||
        !Number.isFinite(totalUsageUsd) ||
        totalCreditsUsd < 0 ||
        totalUsageUsd < 0
      ) {
        return yield* new MalformedOpenRouterAccountCreditBalance();
      }
      return {
        totalCreditsUsd,
        totalUsageUsd,
        balanceUsd: totalCreditsUsd - totalUsageUsd,
      };
    });

  return (managementKey) =>
    requestBalance(dependencies.fetch, managementKey).pipe(
      Effect.flatMap((response) =>
        withFinalizedResponseBody(response, (response) =>
          classifyResponse(response).pipe(Effect.flatMap(decodeBalance)),
        ),
      ),
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () => new TemporaryOpenRouterAccountCreditBalanceFailure(),
      }),
    );
}
