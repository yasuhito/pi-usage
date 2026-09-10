import {
  parseFiniteNumber,
  weeklyQuotaUsageFromProviderValues,
} from "./codex-weekly-quota-values.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
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

async function readBoundedBody(response: Response): Promise<string> {
  const declaredSize = parseFiniteNumber(
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

    const result = weeklyQuotaUsageFromProviderValues(
      name === "primary_window" ? "primary" : "secondary",
      Reflect.get(window, "limit_window_seconds"),
      Reflect.get(window, "used_percent"),
      Reflect.get(window, "reset_at"),
    );
    if (result.kind === "malformed") {
      throw new CodexUsageFormatError(
        "Codex weekly quota values are malformed",
      );
    }
    if (result.kind === "observed") return result.usage;
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
