const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

export type DedicatedWeeklyQuotaAcquisitionResult =
  | { readonly kind: "acquired"; readonly body: unknown }
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
        return { kind: "acquired", body: JSON.parse(responseText) };
      } catch {
        return { kind: "malformed-observation" };
      }
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "temporary-failure", retryAtMs: undefined };
    }
  };
}
