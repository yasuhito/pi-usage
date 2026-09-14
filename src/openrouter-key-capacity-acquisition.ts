import { Clock, Data, Effect, Schema } from "effect";

import {
  readBoundedResponseBody,
  withFinalizedResponseBody,
} from "./bounded-response-body.ts";
import { IsoInstant } from "./iso-instant.ts";
import { retryAfterDeadlineMs } from "./retry-after.ts";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

declare const openRouterApiKeyBrand: unique symbol;

export type OpenRouterApiKey = string & {
  readonly [openRouterApiKeyBrand]: true;
};

export type AcquiredOpenRouterKeyCapacity =
  | {
      readonly kind: "limited";
      readonly remainingUsd: number;
      readonly validUntilMs?: number;
    }
  | {
      readonly kind: "no-limit";
      readonly validUntilMs?: number;
    };

export class OpenRouterAuthenticationRejected extends Data.TaggedError(
  "OpenRouterAuthenticationRejected",
) {}
export class TemporaryOpenRouterKeyCapacityFailure extends Data.TaggedError(
  "TemporaryOpenRouterKeyCapacityFailure",
)<{ readonly retryAtMs?: number }> {
  constructor(options: { readonly retryAtMs?: number } = {}) {
    super(options);
  }
}
export class PermanentOpenRouterKeyCapacityFailure extends Data.TaggedError(
  "PermanentOpenRouterKeyCapacityFailure",
) {}
export class MalformedOpenRouterKeyCapacity extends Data.TaggedError(
  "MalformedOpenRouterKeyCapacity",
) {}

export type OpenRouterKeyCapacityAcquisitionError =
  | OpenRouterAuthenticationRejected
  | TemporaryOpenRouterKeyCapacityFailure
  | PermanentOpenRouterKeyCapacityFailure
  | MalformedOpenRouterKeyCapacity;

export type AcquireOpenRouterKeyCapacity = (
  apiKey: OpenRouterApiKey,
) => Effect.Effect<
  AcquiredOpenRouterKeyCapacity,
  OpenRouterKeyCapacityAcquisitionError
>;

export interface OpenRouterKeyCapacityAcquisitionDependencies {
  readonly fetch: typeof fetch;
}

const OpenRouterKeyBody = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.NullOr(Schema.Number),
    limit_remaining: Schema.NullOr(Schema.Number),
    limit_reset: Schema.NullOr(Schema.Literal("daily", "weekly", "monthly")),
    expires_at: Schema.NullOr(IsoInstant),
  }),
});

function nextResetAtMs(
  cadence: "daily" | "weekly" | "monthly" | null,
  nowMs: number,
): number | undefined {
  if (cadence === null) return undefined;
  const now = new Date(nowMs);
  if (cadence === "daily") {
    return Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
  }
  if (cadence === "weekly") {
    const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
    return Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday,
    );
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function requestCapacity(
  fetchImplementation: typeof fetch,
  key: string,
): Effect.Effect<Response, TemporaryOpenRouterKeyCapacityFailure> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImplementation(OPENROUTER_KEY_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
        },
        redirect: "manual",
        signal,
      }),
    catch: () => new TemporaryOpenRouterKeyCapacityFailure(),
  });
}

function classifyResponse(
  response: Response,
): Effect.Effect<Response, OpenRouterKeyCapacityAcquisitionError> {
  if (response.ok) return Effect.succeed(response);
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(new OpenRouterAuthenticationRejected());
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
          new TemporaryOpenRouterKeyCapacityFailure(
            retryDeadline === undefined ? {} : { retryAtMs: retryDeadline },
          ),
        );
      }),
    );
  }
  return Effect.fail(new PermanentOpenRouterKeyCapacityFailure());
}

export function createAcquireOpenRouterKeyCapacity(
  dependencies: OpenRouterKeyCapacityAcquisitionDependencies,
): AcquireOpenRouterKeyCapacity {
  const decodeCapacity = (response: Response) =>
    Effect.gen(function* () {
      const text = yield* readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new MalformedOpenRouterKeyCapacity(),
        () => new TemporaryOpenRouterKeyCapacityFailure(),
      );
      let unknownBody: unknown;
      try {
        unknownBody = JSON.parse(text) as unknown;
      } catch {
        return yield* new MalformedOpenRouterKeyCapacity();
      }
      const body = yield* Schema.decodeUnknown(OpenRouterKeyBody)(
        unknownBody,
      ).pipe(Effect.mapError(() => new MalformedOpenRouterKeyCapacity()));
      const {
        limit,
        limit_remaining: remainingUsd,
        limit_reset: limitReset,
        expires_at: expiresAt,
      } = body.data;
      const nowMs = yield* Clock.currentTimeMillis;
      const expirationMs = expiresAt === null ? undefined : expiresAt.getTime();
      if (expirationMs !== undefined && expirationMs <= nowMs) {
        return yield* new MalformedOpenRouterKeyCapacity();
      }
      const resetAtMs = nextResetAtMs(limitReset, nowMs);
      const validUntilMs =
        resetAtMs === undefined
          ? expirationMs
          : expirationMs === undefined
            ? resetAtMs
            : Math.min(resetAtMs, expirationMs);
      const validity = validUntilMs === undefined ? {} : { validUntilMs };
      if (limit === null && remainingUsd === null) {
        return { kind: "no-limit" as const, ...validity };
      }
      if (
        limit === null ||
        remainingUsd === null ||
        !Number.isFinite(limit) ||
        !Number.isFinite(remainingUsd) ||
        limit < 0 ||
        remainingUsd < 0 ||
        remainingUsd > limit
      ) {
        return yield* new MalformedOpenRouterKeyCapacity();
      }
      return { kind: "limited" as const, remainingUsd, ...validity };
    });

  return (apiKey) =>
    requestCapacity(dependencies.fetch, apiKey).pipe(
      Effect.flatMap((response) =>
        withFinalizedResponseBody(response, (response) =>
          classifyResponse(response).pipe(Effect.flatMap(decodeCapacity)),
        ),
      ),
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () => new TemporaryOpenRouterKeyCapacityFailure(),
      }),
    );
}
