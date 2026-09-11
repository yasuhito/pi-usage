# Codex weekly quota meter

## Goal

Publish `@yasuhito/pi-usage`, a Pi package that shows the active Pi Codex account's provider-reported weekly quota usage in the default footer alongside other extension statuses.

## Scope

The first release supports only Pi's `openai-codex` OAuth provider. It does not support Claude, API-key OpenAI usage, proxy quotas, multiple Codex quota families, local token estimates, persistent cache, or a detail command.

## Usage semantics

- Weekly quota usage is the provider-reported percentage of the account's weighted weekly allowance that has been consumed; it is not derived from a fixed token denominator.
- A weekly window is recognized only by an exact seven-day duration (`604800` seconds or `10080` minutes), regardless of primary/secondary position.
- Only the base `rate_limit` is considered. Additional rate-limit families are ignored.
- Percentages are rounded to an integer and clamped to 0–100.

## Status presentation

Use `ctx.ui.setStatus()` so the meter coexists with `pi-smart-zone` and the default footer.

- Loading: `Codex wk loading…`
- Fresh: `Codex wk ━━━━━━──── 63% · resets 2`
- Stale: `Codex wk ━━━━━━──── 63% · resets 2 ~`
- Unavailable: `Codex wk unavailable`
- No configured Codex OAuth: clear the status.

The bar has ten cells. Filled cells are the used portion rounded to the nearest 10%. Theme colors are `dim` below 75%, `warning` from 75% through 89%, and `error` from 90%.

When `/wham/usage` provides `rate_limit_reset_credits.available_count`, append the compact `· resets N` suffix to the right of the percentage. Show zero explicitly and omit the suffix when the optional count is absent or malformed.

Display the status whenever Codex OAuth is configured, even if another model is selected.

## Acquisition

- Resolve current credentials through `ctx.modelRegistry.getProviderAuth("openai-codex")`.
- Fetch `GET https://chatgpt.com/backend-api/wham/usage` with the bearer token and matching `ChatGPT-Account-Id`.
- Isolate this undocumented first-party endpoint behind an exchangeable adapter.
- Opportunistically merge recognized `x-codex-*` fields received through `after_provider_response`; headers are not the authoritative startup source.
- Do not use the Codex CLI, `~/.codex/auth.json`, artificial model requests, local token accounting, redirects, or project-configured endpoints.

## Lifecycle and resilience

Run only in TUI mode.

- Fetch on session start and model selection.
- Refresh after Codex provider responses and agent settlement, with debouncing.
- Poll every 60 seconds while active.
- Permit at most one request at a time.
- Use a five-second timeout and one MiB response limit.
- Honor `Retry-After` for 429 responses and apply exponential backoff with jitter to temporary failures.
- Keep the last good value after a temporary failure and mark it stale immediately.
- Stop presenting a stale value after ten minutes or its reset time, whichever comes first.
- On 401/403, resolve Pi authentication again once and retry.
- Abort requests and clear timers during session shutdown.

## Security

- Use the fixed HTTPS origin and reject redirects.
- Never persist credentials, account IDs, raw responses, or response headers.
- Never log credentials or raw authenticated data.
- Parse current snake_case usage responses and known `x-codex-*` headers defensively, ignore unknown fields, and fail unavailable when required values are malformed.

## Delivery

- MIT licensed npm package named `@yasuhito/pi-usage`.
- Include the `pi-package` keyword and Pi extension manifest.
- Document installation and the undocumented endpoint dependency.
- Include behavior tests at the agreed acquisition, presentation, and Pi extension seams.
- Pass lint, typecheck, tests, package checks, and GitHub Actions.
- Publishing to npm is a separate explicit action.
