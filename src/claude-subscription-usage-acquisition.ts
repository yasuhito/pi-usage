import { createHash } from "node:crypto";
import { Cause, Clock, Data, Effect, Schema } from "effect";
import {
  readBoundedResponseBody,
  withFinalizedResponseBody,
} from "./bounded-response-body.ts";
import type {
  CoordinatedAcquisitionAttempt,
  CoordinatedAcquisitionOutcome,
  ProviderAcquisitionCoordinator,
} from "./provider-acquisition-coordinator.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
// Compatibility identifier for the verified Claude Code OAuth request shape.
// Update only after re-verifying the contract documented in the prototype.
const CLAUDE_CODE_COMPATIBILITY_VERSION = "2.1.251";

const CLAUDE_USAGE_HEADERS = {
  Accept: "application/json",
  "User-Agent": `claude-cli/${CLAUDE_CODE_COMPATIBILITY_VERSION}`,
  "anthropic-beta": "oauth-2025-04-20",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
} as const;

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
  readonly observedAtMs?: number;
}

export class ClaudeAuthenticationUnavailable extends Data.TaggedError(
  "ClaudeAuthenticationUnavailable",
) {}
export class ClaudeAuthenticationRejected extends Data.TaggedError(
  "ClaudeAuthenticationRejected",
)<{ readonly retryAtMs?: number }> {
  constructor(options: { readonly retryAtMs?: number } = {}) {
    super(options);
  }
}
export class TemporaryClaudeSubscriptionUsageFailure extends Data.TaggedError(
  "TemporaryClaudeSubscriptionUsageFailure",
)<{
  readonly retryAtMs: number | undefined;
  readonly staleUsage?: AcquiredClaudeSubscriptionUsage & {
    readonly observedAtMs: number;
  };
  readonly preserveUsage?: boolean;
}> {}
export class PermanentClaudeSubscriptionUsageFailure extends Data.TaggedError(
  "PermanentClaudeSubscriptionUsageFailure",
)<{ readonly retryAtMs?: number }> {
  constructor(options: { readonly retryAtMs?: number } = {}) {
    super(options);
  }
}
export class MalformedClaudeSubscriptionUsage extends Data.TaggedError(
  "MalformedClaudeSubscriptionUsage",
)<{
  readonly retryAtMs?: number;
  readonly staleUsage?: AcquiredClaudeSubscriptionUsage & {
    readonly observedAtMs: number;
  };
}> {
  constructor(
    options: {
      readonly retryAtMs?: number;
      readonly staleUsage?: AcquiredClaudeSubscriptionUsage & {
        readonly observedAtMs: number;
      };
    } = {},
  ) {
    super(options);
  }
}

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
  readonly acquisitionCoordinator: ProviderAcquisitionCoordinator;
  readonly onCoordinationUnavailable?: (reason: string) => void;
}

interface SharedClaudeSubscriptionUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isValidIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number(rawHour) <= 23 &&
    Number(rawMinute) <= 59 &&
    Number(rawSecond ?? 0) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

const IsoInstant = Schema.String.pipe(
  Schema.filter(isValidIsoInstant),
  Schema.compose(Schema.Date),
);

const ClaudeUsageBody = Schema.Struct({
  seven_day: Schema.Struct({
    utilization: Schema.Number.pipe(Schema.between(0, 100)),
    resets_at: IsoInstant,
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
        headers: {
          ...CLAUDE_USAGE_HEADERS,
          Authorization: `Bearer ${key}`,
        },
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
            retryAtMs:
              response.status === 429
                ? Math.max(
                    now + RATE_LIMIT_COOLDOWN_MS,
                    retryAtMs(response, now) ?? 0,
                  )
                : retryAtMs(response, now),
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

  const coordinator = dependencies.acquisitionCoordinator;

  const decodeSharedUsage = (
    value: unknown,
  ): SharedClaudeSubscriptionUsage | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const usedPercent = Reflect.get(value, "usedPercent");
    const resetsAtMs = Reflect.get(value, "resetsAtMs");
    return typeof usedPercent === "number" &&
      Number.isFinite(usedPercent) &&
      usedPercent >= 0 &&
      usedPercent <= 100 &&
      Number.isSafeInteger(resetsAtMs) &&
      resetsAtMs > 0 &&
      resetsAtMs <= 8_640_000_000_000_000
      ? { usedPercent, resetsAtMs }
      : undefined;
  };

  const coordinateExchange = (key: string) =>
    coordinator
      .coordinate<SharedClaudeSubscriptionUsage>({
        provider: "claude-subscription-usage",
        credential: key,
        decode: decodeSharedUsage,
        reusableUntilMs: (usage, observedAtMs) =>
          Math.min(observedAtMs + 3 * 60_000, usage.resetsAtMs),
        acquire: Effect.exit(exchange(key)).pipe(
          Effect.flatMap((exit) => {
            if (exit._tag === "Success") {
              return Effect.succeed<
                CoordinatedAcquisitionAttempt<SharedClaudeSubscriptionUsage>
              >({
                kind: "success",
                value: {
                  usedPercent: exit.value.usedPercent,
                  resetsAtMs: exit.value.resetsAtMs,
                },
              });
            }
            const failure = Cause.failureOption(exit.cause);
            if (failure._tag === "Some") {
              switch (failure.value._tag) {
                case "TemporaryClaudeSubscriptionUsageFailure":
                  return Effect.succeed({
                    kind: "temporary" as const,
                    ...(failure.value.retryAtMs === undefined
                      ? {}
                      : { retryAtMs: failure.value.retryAtMs }),
                  });
                case "MalformedClaudeSubscriptionUsage":
                  return Effect.succeed({ kind: "malformed" as const });
                case "ClaudeAuthenticationUnavailable":
                case "ClaudeAuthenticationRejected":
                  return Effect.succeed({
                    kind: "credential-rejected" as const,
                  });
                case "PermanentClaudeSubscriptionUsageFailure":
                  return Effect.succeed({ kind: "terminal" as const });
              }
            }
            const defects = Cause.keepDefects(exit.cause);
            return defects._tag === "Some"
              ? Effect.failCause(defects.value)
              : Effect.interrupt;
          }),
        ),
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            dependencies.onCoordinationUnavailable?.(error.reason),
          ),
        ),
        Effect.mapError(() => new ClaudeAuthenticationUnavailable()),
      );

  const usageFromOutcome = (
    outcome: CoordinatedAcquisitionOutcome<SharedClaudeSubscriptionUsage>,
    key: string,
  ): Effect.Effect<
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageAcquisitionError
  > =>
    Effect.suspend<
      AcquiredClaudeSubscriptionUsage,
      ClaudeSubscriptionUsageAcquisitionError,
      never
    >(() => {
      if (outcome.kind === "success") {
        return Effect.succeed({
          ...outcome.value,
          observedAtMs: outcome.observedAtMs,
          credentialFingerprint: fingerprintOAuthKey(key),
        });
      }
      const staleUsage =
        outcome.stale === undefined
          ? undefined
          : {
              ...outcome.stale.value,
              observedAtMs: outcome.stale.observedAtMs,
              credentialFingerprint: fingerprintOAuthKey(key),
            };
      switch (outcome.reason) {
        case "temporary":
        case "follower-timeout":
          return Effect.fail(
            new TemporaryClaudeSubscriptionUsageFailure({
              retryAtMs: outcome.retryAtMs,
              preserveUsage: true,
              ...(staleUsage === undefined ? {} : { staleUsage }),
            }),
          );
        case "malformed":
          return Effect.fail(
            new MalformedClaudeSubscriptionUsage({
              retryAtMs: outcome.retryAtMs,
              ...(staleUsage === undefined ? {} : { staleUsage }),
            }),
          );
        case "credential-rejected":
          return Effect.fail(
            new ClaudeAuthenticationRejected({
              retryAtMs: outcome.retryAtMs,
            }),
          );
        case "terminal":
          return Effect.fail(
            new PermanentClaudeSubscriptionUsageFailure({
              retryAtMs: outcome.retryAtMs,
            }),
          );
      }
    });

  return () =>
    Effect.gen(function* () {
      const key = yield* resolveKey;
      let outcome = yield* coordinateExchange(key);
      if (
        outcome.kind === "deferred" &&
        outcome.reason === "credential-rejected"
      ) {
        const refreshedKey = yield* resolveKey;
        outcome = yield* coordinateExchange(refreshedKey);
        return yield* usageFromOutcome(outcome, refreshedKey);
      }
      return yield* usageFromOutcome(outcome, key);
    });
}
