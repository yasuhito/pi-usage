const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class CodexUsageRequestError extends Error {
  readonly status: number;
  readonly retryAfter: string | undefined;

  constructor(status: number, retryAfter: string | undefined) {
    super(`Codex usage request failed with status ${status}`);
    this.name = "CodexUsageRequestError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

export interface WeeklyQuotaUsage {
  readonly usedPercent: number;
  readonly resetsAt: number;
}

interface UsageWindow {
  readonly used_percent?: unknown;
  readonly limit_window_seconds?: unknown;
  readonly reset_at?: unknown;
}

function isWeeklyWindow(value: unknown): value is UsageWindow {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "limit_window_seconds") === WEEK_SECONDS;
}

export function parseCodexRateLimitHeaders(
  headers: Readonly<Record<string, string>>,
): WeeklyQuotaUsage | undefined {
  for (const position of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${position}`;
    if (Number(headers[`${prefix}-window-minutes`]) !== 10_080) continue;

    const usedPercent = Number(headers[`${prefix}-used-percent`]);
    const resetsAt = Number(headers[`${prefix}-reset-at`]);
    if (Number.isFinite(usedPercent) && Number.isFinite(resetsAt)) {
      return { usedPercent, resetsAt };
    }
  }
  return undefined;
}

export async function readCodexWeeklyUsage(
  credential: CodexCredential,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WeeklyQuotaUsage> {
  const response = await transport(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "ChatGPT-Account-Id": credential.accountId,
    },
    redirect: "manual",
    signal:
      signal === undefined
        ? AbortSignal.timeout(5_000)
        : AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) {
    throw new CodexUsageRequestError(
      response.status,
      response.headers.get("retry-after") ?? undefined,
    );
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new Error("Codex usage response is too large");
  }

  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Codex usage response is too large");
  }
  const body: unknown = JSON.parse(responseText);
  const rateLimit =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "rate_limit")
      : undefined;
  const primary =
    typeof rateLimit === "object" && rateLimit !== null
      ? Reflect.get(rateLimit, "primary_window")
      : undefined;
  const secondary =
    typeof rateLimit === "object" && rateLimit !== null
      ? Reflect.get(rateLimit, "secondary_window")
      : undefined;
  const weekly = [primary, secondary].find(isWeeklyWindow);

  if (
    weekly === undefined ||
    typeof weekly.used_percent !== "number" ||
    typeof weekly.reset_at !== "number"
  ) {
    throw new Error("Codex weekly quota is unavailable");
  }

  return {
    usedPercent: weekly.used_percent,
    resetsAt: weekly.reset_at,
  };
}
