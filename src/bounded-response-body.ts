import { Effect } from "effect";

function declaredResponseSize(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads a response without retaining or exposing bytes beyond the bound. */
export function readBoundedResponseBody<Malformed, Temporary>(
  response: Response,
  maximumBytes: number,
  malformed: () => Malformed,
  temporary: () => Temporary,
): Effect.Effect<string, Malformed | Temporary> {
  const declaredSize = declaredResponseSize(response);
  if (declaredSize !== undefined && declaredSize > maximumBytes) {
    return Effect.fail(malformed());
  }
  const body = response.body;
  if (body === null) return Effect.succeed("");

  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let overflow: Malformed | undefined;
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
          overflow !== undefined && error === overflow ? overflow : temporary(),
      }),
    (reader) =>
      Effect.promise(async () => {
        try {
          await reader.cancel();
        } catch {
          // Cancellation failure must not replace the bounded-read outcome.
        }
        try {
          reader.releaseLock();
        } catch {
          // A reader may already have released its lock while unwinding.
        }
      }),
  );
}
