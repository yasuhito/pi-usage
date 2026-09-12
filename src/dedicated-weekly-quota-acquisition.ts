const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const DEDICATED_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const DEDICATED_WINDOW_POSITIONS = ["primary", "secondary"] as const;

type RateLimitWindowPosition = (typeof DEDICATED_WINDOW_POSITIONS)[number];

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

export type DedicatedWeeklyQuotaAcquisitionResult =
  | { readonly kind: "acquired"; readonly usage: AcquiredWeeklyQuotaUsage }
  | { readonly kind: "authentication-rejected" }
  | {
      readonly kind: "temporary-failure";
      readonly retryAtMs: number | undefined;
    }
  | { readonly kind: "permanently-unavailable" }
  | { readonly kind: "malformed-observation" };

export type AcquireDedicatedWeeklyQuotaUsage = (
  credential: CodexCredential,
  signal?: AbortSignal,
) => Promise<DedicatedWeeklyQuotaAcquisitionResult>;

export interface DedicatedWeeklyQuotaAcquisitionDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

function declaredResponseSize(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readBoundedBody(
  response: Response,
): Promise<string | undefined> {
  const declaredSize = declaredResponseSize(response);
  if (declaredSize !== undefined && declaredSize > MAX_RESPONSE_BYTES) {
    return undefined;
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
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

function weeklyQuotaUsageFromProviderBody(
  body: unknown,
): AcquiredWeeklyQuotaUsage | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const rateLimit = Reflect.get(body, "rate_limit");
  if (typeof rateLimit !== "object" || rateLimit === null) return undefined;

  const limitResetCredits = Reflect.get(body, "rate_limit_reset_credits");
  const availableLimitResetCredits =
    typeof limitResetCredits === "object" && limitResetCredits !== null
      ? Reflect.get(limitResetCredits, "available_count")
      : undefined;
  const hasValidLimitResetCreditCount =
    typeof availableLimitResetCredits === "number" &&
    Number.isSafeInteger(availableLimitResetCredits) &&
    availableLimitResetCredits >= 0;

  for (const position of DEDICATED_WINDOW_POSITIONS) {
    const window = Reflect.get(rateLimit, `${position}_window`);
    if (typeof window !== "object" || window === null) continue;
    if (
      Reflect.get(window, "limit_window_seconds") !==
      DEDICATED_WEEKLY_WINDOW_SECONDS
    ) {
      continue;
    }

    const usedPercent = Reflect.get(window, "used_percent");
    const resetsAtSeconds = Reflect.get(window, "reset_at");
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      typeof resetsAtSeconds !== "number" ||
      !Number.isFinite(resetsAtSeconds) ||
      resetsAtSeconds <= 0
    ) {
      return undefined;
    }

    const resetsAtMs = resetsAtSeconds * 1_000;
    if (!Number.isFinite(resetsAtMs)) return undefined;

    return {
      usedPercent,
      resetsAtMs,
      windowPosition: position,
      ...(hasValidLimitResetCreditCount ? { availableLimitResetCredits } : {}),
    };
  }

  return undefined;
}

export function createAcquireDedicatedWeeklyQuotaUsage(
  dependencies: DedicatedWeeklyQuotaAcquisitionDependencies,
): AcquireDedicatedWeeklyQuotaUsage {
  return async (credential, signal) => {
    if (signal?.aborted) throw signal.reason;

    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal =
        signal === undefined
          ? timeoutSignal
          : AbortSignal.any([signal, timeoutSignal]);
      const response = await dependencies.fetch(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-Id": credential.accountId,
        },
        redirect: "manual",
        signal: requestSignal,
      });
      if (signal?.aborted) throw signal.reason;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { kind: "authentication-rejected" };
        }
        if (
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          return {
            kind: "temporary-failure",
            retryAtMs:
              response.status === 429
                ? retryAtMs(response, dependencies.now())
                : undefined,
          };
        }
        return { kind: "permanently-unavailable" };
      }

      const responseText = await readBoundedBody(response);
      if (signal?.aborted) throw signal.reason;
      if (responseText === undefined) return { kind: "malformed-observation" };

      try {
        const usage = weeklyQuotaUsageFromProviderBody(
          JSON.parse(responseText) as unknown,
        );
        return usage === undefined
          ? { kind: "malformed-observation" }
          : { kind: "acquired", usage };
      } catch {
        return { kind: "malformed-observation" };
      }
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "temporary-failure", retryAtMs: undefined };
    }
  };
}
