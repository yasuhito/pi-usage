import { Data, Effect, Schema } from "effect";
import { exchangeProviderJson } from "./provider-json-exchange.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;
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

function interpretUsage(
  body: unknown,
): Effect.Effect<AcquiredWeeklyQuotaUsage, MalformedAcquisition> {
  return Schema.decodeUnknown(ProviderBody)(body).pipe(
    Effect.mapError(() => new MalformedAcquisition()),
    Effect.flatMap((providerBody) => {
      const usage = interpretProviderBody(providerBody);
      return usage === undefined
        ? Effect.fail(new MalformedAcquisition())
        : Effect.succeed(usage);
    }),
  );
}

export function createAcquireDedicatedWeeklyQuotaUsage(
  dependencies: DedicatedWeeklyQuotaAcquisitionDependencies,
): AcquireDedicatedWeeklyQuotaUsage {
  return (credential) =>
    exchangeProviderJson(
      dependencies.fetch,
      {
        target: CODEX_USAGE_URL,
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-Id": credential.accountId,
        },
        maximumResponseBytes: MAX_RESPONSE_BYTES,
      },
      interpretUsage,
    ).pipe(
      Effect.catchTags({
        // Codex honors a retry instruction only while rate limited.
        TemporaryProviderJsonExchangeFailure: ({ status, retryAtMs }) =>
          new TemporaryAcquisitionFailure({
            retryAtMs: status === 429 ? retryAtMs : undefined,
          }),
        ProviderJsonExchangeAuthenticationRejected: () =>
          new AuthenticationRejected(),
        PermanentProviderJsonExchangeFailure: () =>
          new PermanentAcquisitionFailure(),
        MalformedProviderJsonExchange: () => new MalformedAcquisition(),
      }),
    );
}
