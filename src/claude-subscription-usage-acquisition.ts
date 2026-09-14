import { Cause, Clock, Data, Effect, Schema } from "effect";
import { IsoInstant } from "./iso-instant.ts";
import type {
  CoordinatedAcquisitionAttempt,
  CoordinatedAcquisitionOutcome,
  ProviderAcquisitionCoordinator,
} from "./provider-acquisition-coordinator.ts";
import { exchangeProviderJson } from "./provider-json-exchange.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_RESPONSE_BYTES = 64 * 1024;
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

declare const claudeOAuthCredentialBrand: unique symbol;

export type ClaudeOAuthCredential = string & {
  readonly [claudeOAuthCredentialBrand]: true;
};

export interface AcquiredClaudeSubscriptionUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly observedAtMs?: number;
}

export class ClaudeAcquisitionCoordinationUnavailable extends Data.TaggedError(
  "ClaudeAcquisitionCoordinationUnavailable",
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

type ClaudeSubscriptionUsageExchangeError =
  | ClaudeAuthenticationRejected
  | TemporaryClaudeSubscriptionUsageFailure
  | PermanentClaudeSubscriptionUsageFailure
  | MalformedClaudeSubscriptionUsage;

export type ClaudeSubscriptionUsageAcquisitionError =
  | ClaudeAcquisitionCoordinationUnavailable
  | ClaudeSubscriptionUsageExchangeError;

export type AcquireClaudeSubscriptionUsage = (
  oauthCredential: ClaudeOAuthCredential,
) => Effect.Effect<
  AcquiredClaudeSubscriptionUsage,
  ClaudeSubscriptionUsageAcquisitionError
>;

export interface ClaudeSubscriptionUsageAcquisitionDependencies {
  readonly fetch: typeof fetch;
  readonly acquisitionCoordinator: ProviderAcquisitionCoordinator;
  readonly onCoordinationUnavailable?: (reason: string) => void;
}

interface SharedClaudeSubscriptionUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

const ClaudeUsageBody = Schema.Struct({
  seven_day: Schema.Struct({
    utilization: Schema.Number.pipe(Schema.between(0, 100)),
    resets_at: IsoInstant,
  }),
});

function interpretUsage(
  body: unknown,
): Effect.Effect<
  AcquiredClaudeSubscriptionUsage,
  MalformedClaudeSubscriptionUsage
> {
  return Effect.gen(function* () {
    const usage = yield* Schema.decodeUnknown(ClaudeUsageBody)(body).pipe(
      Effect.mapError(() => new MalformedClaudeSubscriptionUsage()),
    );
    const resetsAtMs = usage.seven_day.resets_at.getTime();
    const now = yield* Clock.currentTimeMillis;
    if (resetsAtMs <= now) {
      return yield* new MalformedClaudeSubscriptionUsage();
    }
    return {
      usedPercent: usage.seven_day.utilization,
      resetsAtMs,
    };
  });
}

/** Rate limiting waits at least fifteen minutes, whatever the provider asked. */
function temporaryFailure(
  status: number | undefined,
  retryAtMs: number | undefined,
): Effect.Effect<never, TemporaryClaudeSubscriptionUsageFailure> {
  if (status !== 429) {
    return new TemporaryClaudeSubscriptionUsageFailure({ retryAtMs });
  }
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap(
      (now) =>
        new TemporaryClaudeSubscriptionUsageFailure({
          retryAtMs: Math.max(now + RATE_LIMIT_COOLDOWN_MS, retryAtMs ?? 0),
        }),
    ),
  );
}

export function createAcquireClaudeSubscriptionUsage(
  dependencies: ClaudeSubscriptionUsageAcquisitionDependencies,
): AcquireClaudeSubscriptionUsage {
  const exchange = (
    key: string,
  ): Effect.Effect<
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageExchangeError
  > =>
    exchangeProviderJson(
      dependencies.fetch,
      {
        target: CLAUDE_USAGE_URL,
        method: "GET",
        headers: {
          ...CLAUDE_USAGE_HEADERS,
          Authorization: `Bearer ${key}`,
        },
        maximumResponseBytes: MAX_RESPONSE_BYTES,
      },
      interpretUsage,
    ).pipe(
      Effect.catchTags({
        TemporaryProviderJsonExchangeFailure: ({ status, retryAtMs }) =>
          temporaryFailure(status, retryAtMs),
        ProviderJsonExchangeAuthenticationRejected: () =>
          new ClaudeAuthenticationRejected(),
        PermanentProviderJsonExchangeFailure: () =>
          new PermanentClaudeSubscriptionUsageFailure(),
        MalformedProviderJsonExchange: () =>
          new MalformedClaudeSubscriptionUsage(),
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
        Effect.mapError(() => new ClaudeAcquisitionCoordinationUnavailable()),
      );

  const usageFromOutcome = (
    outcome: CoordinatedAcquisitionOutcome<SharedClaudeSubscriptionUsage>,
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
        });
      }
      const staleUsage =
        outcome.stale === undefined
          ? undefined
          : {
              ...outcome.stale.value,
              observedAtMs: outcome.stale.observedAtMs,
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

  return (oauthCredential) =>
    coordinateExchange(oauthCredential).pipe(Effect.flatMap(usageFromOutcome));
}
