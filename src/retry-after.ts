/** Converts a strict HTTP Retry-After value to an absolute deadline. */
export function retryAfterDeadlineMs(
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
