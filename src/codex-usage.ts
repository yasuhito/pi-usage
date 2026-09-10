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

export class CodexUsageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexUsageFormatError";
  }
}

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

function numberHeader(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createWeeklyQuotaUsage(
  position: RateLimitWindowPosition,
  durationSeconds: unknown,
  usedPercent: unknown,
  resetsAtSeconds: unknown,
): WeeklyQuotaUsage | undefined {
  if (durationSeconds !== WEEK_SECONDS) return undefined;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    typeof resetsAtSeconds !== "number" ||
    !Number.isFinite(resetsAtSeconds) ||
    resetsAtSeconds <= 0
  ) {
    throw new CodexUsageFormatError("Codex weekly quota values are malformed");
  }
  return {
    usedPercent,
    resetsAtMs: resetsAtSeconds * 1_000,
    windowPosition: position,
  };
}

export function parseCodexRateLimitHeaders(
  headers: Readonly<Record<string, string>>,
  previous?: WeeklyQuotaUsage,
): WeeklyQuotaUsage | undefined {
  for (const position of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${position}`;
    const rawDuration = headers[`${prefix}-window-minutes`];
    const rawUsedPercent = headers[`${prefix}-used-percent`];
    const rawResetsAt = headers[`${prefix}-reset-at`];
    if (
      rawDuration === undefined &&
      rawUsedPercent === undefined &&
      rawResetsAt === undefined
    ) {
      continue;
    }

    const priorWindow =
      previous?.windowPosition === position ? previous : undefined;
    const durationMinutes =
      rawDuration === undefined
        ? priorWindow === undefined
          ? undefined
          : 10_080
        : numberHeader(rawDuration);
    const usedPercent =
      rawUsedPercent === undefined
        ? priorWindow?.usedPercent
        : numberHeader(rawUsedPercent);
    const resetsAtSeconds =
      rawResetsAt === undefined
        ? priorWindow === undefined
          ? undefined
          : priorWindow.resetsAtMs / 1_000
        : numberHeader(rawResetsAt);
    if (
      (rawDuration !== undefined && durationMinutes === undefined) ||
      (rawUsedPercent !== undefined && usedPercent === undefined) ||
      (rawResetsAt !== undefined && resetsAtSeconds === undefined)
    ) {
      throw new CodexUsageFormatError("Codex rate-limit headers are malformed");
    }
    if (
      durationMinutes === undefined ||
      usedPercent === undefined ||
      resetsAtSeconds === undefined
    ) {
      continue;
    }

    const usage = createWeeklyQuotaUsage(
      position,
      durationMinutes * 60,
      usedPercent,
      resetsAtSeconds,
    );
    if (usage !== undefined) return usage;
  }
  return undefined;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredSize = numberHeader(
    response.headers.get("content-length") ?? undefined,
  );
  if (declaredSize !== undefined && declaredSize > MAX_RESPONSE_BYTES) {
    throw new CodexUsageFormatError("Codex usage response is too large");
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
        await reader.cancel();
        throw new CodexUsageFormatError("Codex usage response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function weeklyUsageFromBody(body: unknown): WeeklyQuotaUsage {
  const rateLimit =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "rate_limit")
      : undefined;
  if (typeof rateLimit !== "object" || rateLimit === null) {
    throw new CodexUsageFormatError("Codex weekly quota is unavailable");
  }

  for (const name of ["primary_window", "secondary_window"] as const) {
    const window = Reflect.get(rateLimit, name);
    if (typeof window !== "object" || window === null) continue;
    if (Reflect.get(window, "limit_window_seconds") !== WEEK_SECONDS) continue;

    const usage = createWeeklyQuotaUsage(
      name === "primary_window" ? "primary" : "secondary",
      Reflect.get(window, "limit_window_seconds"),
      Reflect.get(window, "used_percent"),
      Reflect.get(window, "reset_at"),
    );
    if (usage !== undefined) return usage;
  }

  throw new CodexUsageFormatError("Codex weekly quota is unavailable");
}

export async function readCodexWeeklyQuotaUsage(
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

  const responseText = await readBoundedBody(response);
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new CodexUsageFormatError("Codex usage response is invalid JSON");
  }
  return weeklyUsageFromBody(body);
}
