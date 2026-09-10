import {
  parseFiniteNumber,
  weeklyQuotaUsageFromProviderValues,
} from "./codex-weekly-quota-values.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

export type RateLimitWindowPosition = "primary" | "secondary";

export interface WeeklyQuotaUsage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly windowPosition: RateLimitWindowPosition;
}

export type DedicatedWeeklyQuotaAcquisitionResult =
  | { readonly kind: "observed"; readonly usage: WeeklyQuotaUsage }
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

async function readBoundedBody(
  response: Response,
): Promise<string | undefined> {
  const declaredSize = parseFiniteNumber(
    response.headers.get("content-length") ?? undefined,
  );
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

function weeklyQuotaObservationFromBody(
  body: unknown,
): DedicatedWeeklyQuotaAcquisitionResult {
  const rateLimit =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "rate_limit")
      : undefined;
  if (typeof rateLimit !== "object" || rateLimit === null) {
    return { kind: "malformed-observation" };
  }

  for (const name of ["primary_window", "secondary_window"] as const) {
    const window = Reflect.get(rateLimit, name);
    if (typeof window !== "object" || window === null) continue;

    const result = weeklyQuotaUsageFromProviderValues(
      name === "primary_window" ? "primary" : "secondary",
      Reflect.get(window, "limit_window_seconds"),
      Reflect.get(window, "used_percent"),
      Reflect.get(window, "reset_at"),
    );
    if (result.kind === "malformed") {
      return { kind: "malformed-observation" };
    }
    if (result.kind === "observed") {
      return { kind: "observed", usage: result.usage };
    }
  }

  return { kind: "malformed-observation" };
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

export function createAcquireDedicatedWeeklyQuotaUsage(
  dependencies: DedicatedWeeklyQuotaAcquisitionDependencies,
): AcquireDedicatedWeeklyQuotaUsage {
  return async (credential, signal) => {
    if (signal?.aborted) {
      throw signal.reason;
    }

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
      if (responseText === undefined) {
        return { kind: "malformed-observation" };
      }

      let body: unknown;
      try {
        body = JSON.parse(responseText);
      } catch {
        return { kind: "malformed-observation" };
      }
      return weeklyQuotaObservationFromBody(body);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "temporary-failure", retryAtMs: undefined };
    }
  };
}
