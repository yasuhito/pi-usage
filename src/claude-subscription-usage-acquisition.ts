import { Clock, Data, Effect, Schema } from "effect";
import { readBoundedResponseBody } from "./bounded-response-body.ts";

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
}

export class ClaudeAuthenticationUnavailable extends Data.TaggedError(
  "ClaudeAuthenticationUnavailable",
) {}
export class ClaudeAuthenticationRejected extends Data.TaggedError(
  "ClaudeAuthenticationRejected",
) {}
export class TemporaryClaudeSubscriptionUsageFailure extends Data.TaggedError(
  "TemporaryClaudeSubscriptionUsageFailure",
) {}
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
    catch: () => new TemporaryClaudeSubscriptionUsageFailure(),
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
    return Effect.fail(new TemporaryClaudeSubscriptionUsageFailure());
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
        () => new TemporaryClaudeSubscriptionUsageFailure(),
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
      Effect.flatMap(classifyResponse),
      Effect.flatMap(decodeUsage),
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () => new TemporaryClaudeSubscriptionUsageFailure(),
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
