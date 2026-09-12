# Claude OAuth usage endpoint prototype

**Prototype date:** 2026-09-12  
**Verdict:** Success

A disposable Pi extension proved that authentication returned by
`ctx.modelRegistry.getProviderAuth("anthropic")` can read Claude subscription
usage from Anthropic's undocumented OAuth usage endpoint. The spike remains in
`/tmp` and is not part of the extension implementation.

## Result

The resolved authentication was recognizably OAuth-derived without inspecting
the credential:

```text
source: "OAuth"
auth.apiKey: string
auth.headers: undefined
auth.baseUrl: undefined
```

Pi's Anthropic OAuth adapter derives that request shape from the stored OAuth
credential. The prototype did not read Pi or Claude Code credential files and
did not inspect, print, persist, or hash the token.

The following request succeeded:

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <Pi-resolved OAuth access token>
```

Observed minimum contract:

- method: `GET`;
- fixed HTTPS origin: `https://api.anthropic.com`;
- path: `/api/oauth/usage`;
- query parameters: none;
- explicit non-secret headers: none were required by this observation;
- redirects: disabled;
- request timeout: five seconds;
- response body limit: 64 KiB.

The request returned HTTP 200 both without query parameters and without an
explicit `anthropic-beta` header. Although Claude Code 2.1.257 contains the
beta identifier `oauth-2025-04-20`, it was not required for this observed
request and should not be added to the minimum contract without a separate
reason. The result establishes only current behavior of an undocumented
endpoint, not a compatibility guarantee.

## Sanitized response shape

Only allowlisted field names and runtime types were emitted by the spike. The
observed response included:

```text
five_hour:
  utilization: number
  resets_at: string
seven_day:
  utilization: number
  resets_at: string
seven_day_oauth_apps: null
seven_day_opus: null
seven_day_sonnet: null
cinder_cove: null
extra_usage: object
limits: array
```

The observed `seven_day.utilization` was a finite numeric percentage on the
0–100 display scale. The observed `seven_day.resets_at` was an ISO 8601 string
with an explicit UTC offset and fractional seconds. It parsed as a future
instant within the named seven-day window. Account-specific values are omitted
from this persisted report.

This matches Claude Code's own usage rendering, which floors `utilization` and
prints it as a percentage used. It differs from the passive
`anthropic-ratelimit-unified-*` response-header utilization, which Claude Code
describes as a fraction usually on the 0–1 scale. The production adapter must
not mix those two scales.

The production parser should therefore treat a present weekly window as:

```ts
interface ClaudeSevenDayWindow {
  utilization: number;
  resets_at: string;
}
```

It should still validate that `utilization` is finite and that `resets_at` is a
valid future timestamp. Optional sibling windows may be absent or `null` and
must not be required for weekly subscription usage.

## Authentication and scope conclusion

The installed Pi Anthropic OAuth flow requests:

```text
org:create_api_key
user:profile
user:inference
user:sessions:claude_code
user:mcp_servers
user:file_upload
```

Because the Pi-resolved OAuth token received HTTP 200 from the endpoint, the
credential does not appear to lack a scope required for this operation. This is
an empirical access result; the undocumented endpoint does not publish a scope
contract.

Relevant installed sources:

- `node_modules/@earendil-works/pi-ai/dist/auth/oauth/anthropic.js`
- `node_modules/@earendil-works/pi-ai/dist/auth/resolve.js`
- `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`
- `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`

## Error observations

A beta-bearing request without authorization returned HTTP 429 with this
sanitized body shape:

```text
error:
  type: string
  message: string
```

Thus the attempted unauthenticated request did not safely establish a 401 body
shape. No 403 or 404 was reproduced. Further requests solely to manufacture
those statuses are not justified for the feasibility gate and risk unnecessary
rate limiting.

## Adapter consequences

The production Claude adapter can proceed behind the experimental boundary in
ADR 0002. It should:

1. resolve `anthropic` authentication at acquisition time;
2. proceed only when `AuthResult.source === "OAuth"` and
   `auth.apiKey` is a non-empty string;
3. send only that token as `Authorization: Bearer` to the fixed endpoint;
4. use `GET /api/oauth/usage` with no query parameters;
5. reject redirects, apply a short timeout, and bound the response body;
6. parse only allowlisted fields and accept optional or null sibling windows;
7. interpret `seven_day.utilization` as percentage consumed and
   `seven_day.resets_at` as the provider-reported reset instant;
8. never include response bodies or credentials in errors or logs;
9. cache and poll conservatively because the endpoint is undocumented and the
   unauthenticated probe encountered HTTP 429.
