import { createHash } from "node:crypto";
import { Clock, Data, Effect, Schema } from "effect";
import {
  readBoundedResponseBody,
  withFinalizedResponseBody,
} from "./bounded-response-body.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ClaudeAuthentication {
  readonly source?: string;
  readonly auth: {
    readonly apiKey?: string;
  };
}

export type ResolveClaudeAuthentication = Effect.Effect<
  ClaudeAuthentication | undefined
>;

export interface AcquiredClaudeSubscriptionUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly credentialFingerprint: string;
}

export class ClaudeAuthenticationUnavailable extends Data.TaggedError(
  "ClaudeAuthenticationUnavailable",
) {}
export class ClaudeAuthenticationRejected extends Data.TaggedError(
  "ClaudeAuthenticationRejected",
) {}
export class TemporaryClaudeSubscriptionUsageFailure extends Data.TaggedError(
  "TemporaryClaudeSubscriptionUsageFailure",
)<{ readonly retryAtMs: number | undefined }> {}
export class PermanentClaudeSubscriptionUsageFailure extends Data.TaggedError(
  "PermanentClaudeSubscriptionUsageFailure",
) {}
export class MalformedClaudeSubscriptionUsage extends Data.TaggedError(
  "MalformedClaudeSubscriptionUsage",
) {}

export type ClaudeSubscriptionUsageAcquisitionError =
  | ClaudeAuthenticationUnavailable
  | ClaudeAuthenticationRejected
  | TemporaryClaudeSubscriptionUsageFailure
  | PermanentClaudeSubscriptionUsageFailure
  | MalformedClaudeSubscriptionUsage;

export type AcquireClaudeSubscriptionUsage = () => Effect.Effect<
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError
>;

export interface ClaudeSubscriptionUsageAcquisitionDependencies {
  readonly fetch: typeof fetch;
  readonly resolveAuthentication: ResolveClaudeAuthentication;
}

const ClaudeUsageBody = Schema.Struct({
  seven_day: Schema.Struct({
    utilization: Schema.Number.pipe(Schema.between(0, 100)),
    resets_at: Schema.Date,
  }),
});

function oauthKey(
  authentication: ClaudeAuthentication | undefined,
): string | undefined {
  if (authentication?.source !== "OAuth") return undefined;
  const key = authentication.auth.apiKey?.trim();
  return key === undefined || key === "" ? undefined : key;
}

function fingerprintOAuthKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Returns only a non-reversible, session-memory-safe identity for eligible OAuth. */
export function claudeCredentialFingerprint(
  authentication: ClaudeAuthentication | undefined,
): string | undefined {
  const key = oauthKey(authentication);
  return key === undefined ? undefined : fingerprintOAuthKey(key);
}

function retryAtMs(response: Response, now: number): number | undefined {
  const rawValue = response.headers.get("retry-after");
  if (rawValue === null) return undefined;
  if (/^\d+$/.test(rawValue)) {
    const retryAt = now + Number(rawValue) * 1_000;
    return Number.isFinite(retryAt) ? retryAt : undefined;
  }
  const retryAt = Date.parse(rawValue);
  return Number.isFinite(retryAt) &&
    new Date(retryAt).toUTCString() === rawValue
    ? retryAt
    : undefined;
}

function requestUsage(
  fetchImplementation: typeof fetch,
  key: string,
): Effect.Effect<Response, ClaudeSubscriptionUsageAcquisitionError> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImplementation(CLAUDE_USAGE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "manual",
        signal,
      }),
    catch: () =>
      new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs: undefined }),
  });
}

function classifyResponse(
  response: Response,
): Effect.Effect<Response, ClaudeSubscriptionUsageAcquisitionError> {
  if (response.ok) return Effect.succeed(response);
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(new ClaudeAuthenticationRejected());
  }
  if (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.fail(
          new TemporaryClaudeSubscriptionUsageFailure({
            retryAtMs: retryAtMs(response, now),
          }),
        ),
      ),
    );
  }
  return Effect.fail(new PermanentClaudeSubscriptionUsageFailure());
}

export function createAcquireClaudeSubscriptionUsage(
  dependencies: ClaudeSubscriptionUsageAcquisitionDependencies,
): AcquireClaudeSubscriptionUsage {
  const resolveKey = dependencies.resolveAuthentication.pipe(
    Effect.catchAllCause(() =>
      Effect.fail(new ClaudeAuthenticationUnavailable()),
    ),
    Effect.flatMap((authentication) => {
      const key = oauthKey(authentication);
      return key === undefined
        ? Effect.fail(new ClaudeAuthenticationUnavailable())
        : Effect.succeed(key);
    }),
  );

  const decodeUsage = (response: Response) =>
    Effect.gen(function* () {
      const text = yield* readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new MalformedClaudeSubscriptionUsage(),
        () =>
          new TemporaryClaudeSubscriptionUsageFailure({
            retryAtMs: undefined,
          }),
      );
      let unknownBody: unknown;
      try {
        unknownBody = JSON.parse(text) as unknown;
      } catch {
        return yield* new MalformedClaudeSubscriptionUsage();
      }
      const body = yield* Schema.decodeUnknown(ClaudeUsageBody)(
        unknownBody,
      ).pipe(Effect.mapError(() => new MalformedClaudeSubscriptionUsage()));
      const resetsAtMs = body.seven_day.resets_at.getTime();
      const now = yield* Clock.currentTimeMillis;
      if (resetsAtMs <= now) {
        return yield* new MalformedClaudeSubscriptionUsage();
      }
      return {
        usedPercent: body.seven_day.utilization,
        resetsAtMs,
      };
    });

  const exchange = (key: string) =>
    requestUsage(dependencies.fetch, key).pipe(
      Effect.flatMap((response) =>
        withFinalizedResponseBody(response, (response) =>
          classifyResponse(response).pipe(Effect.flatMap(decodeUsage)),
        ),
      ),
      Effect.map((usage) => ({
        ...usage,
        credentialFingerprint: fingerprintOAuthKey(key),
      })),
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () =>
          new TemporaryClaudeSubscriptionUsageFailure({
            retryAtMs: undefined,
          }),
      }),
    );

  return () =>
    Effect.gen(function* () {
      const key = yield* resolveKey;
      return yield* exchange(key).pipe(
        Effect.catchTag("ClaudeAuthenticationRejected", () =>
          resolveKey.pipe(Effect.flatMap(exchange)),
        ),
      );
    });
}
