import { Clock, Data, Effect, Schema } from "effect";
import {
  readBoundedResponseBody,
  withFinalizedResponseBody,
} from "./bounded-response-body.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_POSITIONS = ["primary", "secondary"] as const;

type RateLimitWindowPosition = (typeof WINDOW_POSITIONS)[number];

export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

export interface AcquiredWeeklyQuotaUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly windowPosition: RateLimitWindowPosition;
  readonly availableLimitResetCredits?: number;
}

/** The value-level vocabulary consumed by the pure reconciliation state machine. */
export type DedicatedWeeklyQuotaAcquisitionResult =
  | { readonly kind: "acquired"; readonly usage: AcquiredWeeklyQuotaUsage }
  | { readonly kind: "authentication-rejected" }
  | {
      readonly kind: "temporary-failure";
      readonly retryAtMs: number | undefined;
    }
  | { readonly kind: "permanently-unavailable" }
  | { readonly kind: "malformed-observation" };

export class AuthenticationRejected extends Data.TaggedError(
  "AuthenticationRejected",
) {}
export class TemporaryAcquisitionFailure extends Data.TaggedError(
  "TemporaryAcquisitionFailure",
)<{ readonly retryAtMs: number | undefined }> {}
export class PermanentAcquisitionFailure extends Data.TaggedError(
  "PermanentAcquisitionFailure",
) {}
export class MalformedAcquisition extends Data.TaggedError(
  "MalformedAcquisition",
) {}

export type DedicatedWeeklyQuotaAcquisitionError =
  | AuthenticationRejected
  | TemporaryAcquisitionFailure
  | PermanentAcquisitionFailure
  | MalformedAcquisition;

export type AcquireDedicatedWeeklyQuotaUsage = (
  credential: CodexCredential,
) => Effect.Effect<
  AcquiredWeeklyQuotaUsage,
  DedicatedWeeklyQuotaAcquisitionError
>;

export interface DedicatedWeeklyQuotaAcquisitionDependencies {
  readonly fetch: typeof fetch;
}

const ProviderBody = Schema.Struct({
  rate_limit: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  rate_limit_reset_credits: Schema.optional(Schema.Unknown),
});

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

function interpretProviderBody(
  body: typeof ProviderBody.Type,
): AcquiredWeeklyQuotaUsage | undefined {
  const creditContainer = body.rate_limit_reset_credits;
  const credits =
    typeof creditContainer === "object" && creditContainer !== null
      ? Reflect.get(creditContainer, "available_count")
      : undefined;
  const validCredits =
    typeof credits === "number" &&
    Number.isSafeInteger(credits) &&
    credits >= 0;

  for (const position of WINDOW_POSITIONS) {
    const window = body.rate_limit[`${position}_window`];
    if (typeof window !== "object" || window === null) continue;
    if (Reflect.get(window, "limit_window_seconds") !== WEEK_SECONDS) continue;
    const usedPercent = Reflect.get(window, "used_percent");
    const resetsAtSeconds = Reflect.get(window, "reset_at");
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      typeof resetsAtSeconds !== "number" ||
      !Number.isFinite(resetsAtSeconds) ||
      resetsAtSeconds <= 0
    )
      return undefined;
    const resetsAtMs = resetsAtSeconds * 1_000;
    if (!Number.isFinite(resetsAtMs)) return undefined;
    return {
      usedPercent,
      resetsAtMs,
      windowPosition: position,
      ...(validCredits ? { availableLimitResetCredits: credits } : {}),
    };
  }
  return undefined;
}

export function createAcquireDedicatedWeeklyQuotaUsage(
  dependencies: DedicatedWeeklyQuotaAcquisitionDependencies,
): AcquireDedicatedWeeklyQuotaUsage {
  return (credential) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          dependencies.fetch(CODEX_USAGE_URL, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${credential.accessToken}`,
              "ChatGPT-Account-Id": credential.accountId,
            },
            redirect: "manual",
            signal,
          }),
        catch: () => new TemporaryAcquisitionFailure({ retryAtMs: undefined }),
      });

      return yield* withFinalizedResponseBody(response, (response) =>
        Effect.gen(function* () {
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              return yield* new AuthenticationRejected();
            }
            if (
              response.status === 408 ||
              response.status === 425 ||
              response.status === 429 ||
              response.status >= 500
            ) {
              const now = yield* Clock.currentTimeMillis;
              return yield* new TemporaryAcquisitionFailure({
                retryAtMs:
                  response.status === 429
                    ? retryAtMs(response, now)
                    : undefined,
              });
            }
            return yield* new PermanentAcquisitionFailure();
          }

          const text = yield* readBoundedResponseBody(
            response,
            MAX_RESPONSE_BYTES,
            () => new MalformedAcquisition(),
            () => new TemporaryAcquisitionFailure({ retryAtMs: undefined }),
          );
          let unknownBody: unknown;
          try {
            unknownBody = JSON.parse(text) as unknown;
          } catch {
            return yield* new MalformedAcquisition();
          }
          const body = yield* Schema.decodeUnknown(ProviderBody)(
            unknownBody,
          ).pipe(Effect.mapError(() => new MalformedAcquisition()));
          const usage = interpretProviderBody(body);
          return usage === undefined
            ? yield* new MalformedAcquisition()
            : usage;
        }),
      );
    }).pipe(
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () =>
          new TemporaryAcquisitionFailure({ retryAtMs: undefined }),
      }),
    );
}
