import { Data, Effect, Schema } from "effect";

import type { OpenRouterManagementKey } from "./openrouter-management-key-resolution.ts";
import { exchangeProviderJson } from "./provider-json-exchange.ts";

export type { OpenRouterManagementKey } from "./openrouter-management-key-resolution.ts";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const MAX_RESPONSE_BYTES = 64 * 1024;

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

function interpretBalance(
  body: unknown,
): Effect.Effect<
  AcquiredOpenRouterAccountCreditBalance,
  MalformedOpenRouterAccountCreditBalance
> {
  return Schema.decodeUnknown(OpenRouterCreditsBody)(body).pipe(
    Effect.mapError(() => new MalformedOpenRouterAccountCreditBalance()),
    Effect.flatMap(({ data }) => {
      const totalCreditsUsd = data.total_credits;
      const totalUsageUsd = data.total_usage;
      if (
        !Number.isFinite(totalCreditsUsd) ||
        !Number.isFinite(totalUsageUsd) ||
        totalCreditsUsd < 0 ||
        totalUsageUsd < 0
      ) {
        return Effect.fail(new MalformedOpenRouterAccountCreditBalance());
      }
      return Effect.succeed({
        totalCreditsUsd,
        totalUsageUsd,
        balanceUsd: totalCreditsUsd - totalUsageUsd,
      });
    }),
  );
}

export function createAcquireOpenRouterAccountCreditBalance(
  dependencies: OpenRouterAccountCreditBalanceAcquisitionDependencies,
): AcquireOpenRouterAccountCreditBalance {
  return (managementKey) =>
    exchangeProviderJson(
      dependencies.fetch,
      {
        target: OPENROUTER_CREDITS_URL,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${managementKey}`,
        },
        maximumResponseBytes: MAX_RESPONSE_BYTES,
      },
      interpretBalance,
    ).pipe(
      Effect.catchTags({
        TemporaryProviderJsonExchangeFailure: ({ retryAtMs }) =>
          new TemporaryOpenRouterAccountCreditBalanceFailure(
            retryAtMs === undefined ? {} : { retryAtMs },
          ),
        ProviderJsonExchangeAuthenticationRejected: () =>
          new OpenRouterManagementAuthenticationRejected(),
        PermanentProviderJsonExchangeFailure: () =>
          new PermanentOpenRouterAccountCreditBalanceFailure(),
        MalformedProviderJsonExchange: () =>
          new MalformedOpenRouterAccountCreditBalance(),
      }),
    );
}
