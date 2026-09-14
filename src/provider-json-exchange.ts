import { Clock, Data, Effect } from "effect";

/**
 * Provider JSON exchange: one direct JSON request-response interaction with a
 * provider, made within capacity acquisition.
 *
 * Only fetch is replaceable. Everything else about the exchange is fixed here:
 * the five-second timeout around the whole exchange, manual redirects, HTTP
 * status classification, strict Retry-After parsing, response finalization,
 * declared and streamed byte limits, UTF-8 decoding and JSON parsing, and
 * secret-safe failures. Credential resolution, request facts, interpretation
 * into provider capacity, retry policy, and acquisition coordination stay with
 * each provider.
 */

const EXCHANGE_TIMEOUT_MS = 5_000;

/** The request facts a provider owns for one exchange. Bodies are unsupported. */
export interface ProviderJsonExchangeRequest {
  readonly target: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maximumResponseBytes: number;
}

/**
 * Neutral exchange failures carry only what providers can observe: the HTTP
 * status when a response was classified and the normalized Retry-After
 * deadline. They never carry a credential, target, header, or response data.
 * A temporary failure without a status arose before any response could be
 * classified: a rejected fetch, a failed body read, or the exchange timeout.
 */
export class TemporaryProviderJsonExchangeFailure extends Data.TaggedError(
  "TemporaryProviderJsonExchangeFailure",
)<{
  readonly status: number | undefined;
  readonly retryAtMs: number | undefined;
}> {}
export class ProviderJsonExchangeAuthenticationRejected extends Data.TaggedError(
  "ProviderJsonExchangeAuthenticationRejected",
)<{ readonly status: number }> {}
export class PermanentProviderJsonExchangeFailure extends Data.TaggedError(
  "PermanentProviderJsonExchangeFailure",
)<{ readonly status: number }> {}
export class MalformedProviderJsonExchange extends Data.TaggedError(
  "MalformedProviderJsonExchange",
) {}

export type ProviderJsonExchangeFailure =
  | TemporaryProviderJsonExchangeFailure
  | ProviderJsonExchangeAuthenticationRejected
  | PermanentProviderJsonExchangeFailure
  | MalformedProviderJsonExchange;

function temporaryWithoutResponse(): TemporaryProviderJsonExchangeFailure {
  return new TemporaryProviderJsonExchangeFailure({
    status: undefined,
    retryAtMs: undefined,
  });
}

function malformed(): MalformedProviderJsonExchange {
  return new MalformedProviderJsonExchange();
}

/**
 * Performs one exchange and interprets its JSON body inside the timed,
 * finalized exchange. Interpretation failures, defects, and interruption pass
 * through unchanged; transport outcomes become neutral failures.
 */
export function exchangeProviderJson<A, E>(
  fetchImplementation: typeof fetch,
  request: ProviderJsonExchangeRequest,
  interpret: (body: unknown) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ProviderJsonExchangeFailure> {
  const maximumBytes = request.maximumResponseBytes;
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    return Effect.die(
      new RangeError(
        `Provider JSON exchange requires a positive integer byte limit, received ${String(maximumBytes)}`,
      ),
    );
  }
  return sendRequest(fetchImplementation, request).pipe(
    Effect.flatMap((response) =>
      withFinalizedResponse(response, (response) =>
        classifyResponse(response).pipe(
          Effect.flatMap((response) => readBoundedBody(response, maximumBytes)),
          Effect.flatMap(parseJson),
          Effect.flatMap(interpret),
        ),
      ),
    ),
    Effect.timeoutFail({
      duration: EXCHANGE_TIMEOUT_MS,
      onTimeout: temporaryWithoutResponse,
    }),
  );
}

function sendRequest(
  fetchImplementation: typeof fetch,
  request: ProviderJsonExchangeRequest,
): Effect.Effect<Response, TemporaryProviderJsonExchangeFailure> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImplementation(request.target, {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
        signal,
      }),
    catch: temporaryWithoutResponse,
  });
}

function classifyResponse(
  response: Response,
): Effect.Effect<Response, ProviderJsonExchangeFailure> {
  if (response.ok) return Effect.succeed(response);
  const status = response.status;
  if (status === 401 || status === 403) {
    return Effect.fail(
      new ProviderJsonExchangeAuthenticationRejected({ status }),
    );
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        Effect.fail(
          new TemporaryProviderJsonExchangeFailure({
            status,
            retryAtMs: retryAfterDeadlineMs(response, nowMs),
          }),
        ),
      ),
    );
  }
  return Effect.fail(new PermanentProviderJsonExchangeFailure({ status }));
}

/** Converts a strict HTTP Retry-After value to an absolute deadline. */
function retryAfterDeadlineMs(
  response: Response,
  nowMs: number,
): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const deadline = nowMs + Number(value) * 1_000;
    return Number.isFinite(deadline) ? deadline : undefined;
  }
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) && new Date(deadline).toUTCString() === value
    ? deadline
    : undefined;
}

function parseJson(
  text: string,
): Effect.Effect<unknown, MalformedProviderJsonExchange> {
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: malformed,
  });
}

function declaredResponseSize(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads a body without retaining or exposing bytes beyond the bound. */
function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Effect.Effect<
  string,
  MalformedProviderJsonExchange | TemporaryProviderJsonExchangeFailure
> {
  const declaredSize = declaredResponseSize(response);
  if (declaredSize !== undefined && declaredSize > maximumBytes) {
    return Effect.fail(malformed());
  }
  const body = response.body;
  if (body === null) return Effect.succeed("");

  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let overflow: MalformedProviderJsonExchange | undefined;
  return Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.tryPromise({
        try: async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maximumBytes) {
              overflow = malformed();
              throw overflow;
            }
            text += decoder.decode(value, { stream: true });
          }
          return text + decoder.decode();
        },
        catch: (error) =>
          overflow !== undefined && error === overflow
            ? overflow
            : temporaryWithoutResponse(),
      }),
    (reader) => Effect.promise(() => cancelAndReleaseReader(reader)),
  );
}

/** Scopes a response so unread data is cancelled and its reader lock released. */
function withFinalizedResponse<A, E>(
  response: Response,
  use: (response: Response) => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(Effect.succeed(response), use, (response) =>
    Effect.promise(async () => {
      const body = response.body;
      if (body === null) return;

      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = body.getReader();
      } catch {
        return;
      }
      await cancelAndReleaseReader(reader);
    }),
  );
}

async function cancelAndReleaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cleanup defects must not replace or expose the exchange outcome.
  }
  try {
    reader.releaseLock();
  } catch {
    // A reader may already have released its lock while unwinding.
  }
}
