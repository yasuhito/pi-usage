# @yasuhito/pi-usage

A [Pi](https://pi.dev) extension that shows Codex and Claude subscription usage plus OpenRouter key remaining spend in the default footer.

```text
Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h OpenRouter $12.34 left
```

It uses `ctx.ui.setStatus()`, so it coexists with other status extensions such as [`pi-smart-zone`](https://pi.dev/packages/pi-smart-zone).

## Install

From npm after the package is published:

```bash
pi install npm:@yasuhito/pi-usage
```

From GitHub:

```bash
pi install git:github.com/yasuhito/pi-usage
```

For local development:

```bash
pi -e .
```

## Authentication

Sign in to Pi's `openai-codex`, `anthropic`, and `openrouter` providers with `/login`. Codex, Claude, and OpenRouter are all monitored by default, even when another model is selected. There are no provider settings in this release: missing or unsuitable authentication leaves that provider visible as `unavailable` rather than removing it.

Claude subscription usage requires the OAuth authentication that Pi resolves after a Claude Pro or Max login. An ordinary Anthropic API key is not suitable and is never sent to the subscription usage endpoint. The extension asks Pi to resolve authentication at request time; it does not read Pi or Claude Code credential files.

Cross-process Claude acquisition currently requires Linux and a private, user-owned `XDG_RUNTIME_DIR` (normally `/run/user/<uid>` with mode `0700`). Without that secure runtime location, Claude remains `unavailable` and the TUI warns once per Pi process. macOS and Windows coordination are not yet supported.

## Display

| State | Status |
| --- | --- |
| Loading | `Codex wk loading… Claude wk loading… OpenRouter loading…` |
| Available | `Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h OpenRouter $12.34 left` |
| No OpenRouter key limit | `OpenRouter no limit` |
| Temporarily stale | `Codex wk ━━━━━━──── 63% 3d2h ↻2 ~ Claude wk ━━━━━━━━── 80% 4d1h ~ OpenRouter $12.34 left ~` |
| Unavailable | `Codex wk unavailable Claude wk unavailable OpenRouter unavailable` |

Each percentage is provider-reported **weekly subscription usage**. The two providers retain different meanings:

- **Codex weekly quota usage** is the consumed percentage of the account's weighted weekly allowance, not a token count divided by a fixed token limit.
- **Claude subscription usage** is the consumed percentage of the Claude Pro or Max seven-day window.
- **Anthropic API-key rate limits** are request and token capacity for API use. They are not Claude subscription usage and are not shown.
- **OpenRouter key remaining spend** is the US-dollar amount left under the authenticated key's configured spending limit. It is key-scoped, not the account's purchased-credit balance. A key without a configured limit is shown as `no limit`; this does not promise unlimited account credit.

Each bar has ten cells. A provider's presentation independently becomes a warning at 75% and an error at 90%.

The weekly reset countdown after the percentage is the remaining time until the provider-reported weekly window reset. It uses compact day/hour, hour/minute, or minute units without spaces between units.

The `↻N` suffix is the provider-reported number of available **limit reset credits**. It is Codex-only and appears when Codex supplies the count, including when the count is zero.

## How it works

The extension runs independent Codex, Claude, and OpenRouter monitor lifecycles. Codex usage comes from the ChatGPT usage endpoint and opportunistic `x-codex-*` response headers. Claude usage comes from the experimental first-party OAuth usage endpoint and is requested only with Pi-resolved OAuth authentication. OpenRouter capacity comes from its documented current-key endpoint using Pi-resolved OpenRouter authentication.

Each monitor refreshes at startup and after relevant activity. Codex polls every minute. Claude limits activity refreshes to every three minutes and polls every fifteen minutes. OpenRouter does not poll periodically; it refreshes after OpenRouter activity and provider/account changes. A failed OpenRouter refresh retains the last successful observation, marked `~`, for at most ten minutes and never beyond its key reset or expiration.

Claude acquisitions are coordinated across `/reload`, `/new`, and concurrent Pi processes. A successful observation is reused for three minutes. Temporary failures share their retry deadline; a `429` observes `Retry-After` with a fifteen-minute floor. This prevents each loaded extension instance from independently repeating the same request.

Internally, session-scoped Effect monitors independently own acquisition,
polling, backoff, stale expiration, and interruption. Provider-specific
decoding stays behind small Effect interfaces; Pi event handlers are the only
runtime boundary.

### Security posture

Authenticated requests are restricted to fixed HTTPS origins: `https://chatgpt.com` for Codex, `https://api.anthropic.com` for Claude, and `https://openrouter.ai` for OpenRouter. Redirects are rejected, requests time out, and response bodies are bounded before schema validation. Credentials and raw provider responses are neither logged nor persisted.

To coordinate Claude requests, sanitized usage percentages, reset timestamps, and retry scheduling metadata are stored only in the OS-managed user-runtime `XDG_RUNTIME_DIR`; they are never written to durable package or project storage. Entries are partitioned by an HMAC of the OAuth credential using an ephemeral runtime secret, so neither the credential nor its plain fingerprint is stored. Runtime entries untouched for twenty-four hours are removed best-effort.

The extension does not spawn provider CLIs or estimate quota from local token history.

## Current scope

This release does not implement provider settings, OpenRouter account-credit balance, Claude's five-hour window, detail commands, or manual refresh. Refreshes use the built-in schedule.

## Compatibility warning

The Codex ChatGPT usage endpoint and the Claude OAuth usage endpoint are undocumented first-party interfaces. The `x-codex-*` headers are undocumented as well. None has a public compatibility guarantee, and any may change without notice. The extension isolates and parses them defensively and displays `unavailable` when a response no longer matches the expected contract.

See [`docs/research/codex-weekly-usage.md`](docs/research/codex-weekly-usage.md), [`docs/research/codex-limit-reset-credits.md`](docs/research/codex-limit-reset-credits.md), [`docs/research/claude-oauth-usage-prototype.md`](docs/research/claude-oauth-usage-prototype.md), and [`docs/research/claude-openrouter-usage.md`](docs/research/claude-openrouter-usage.md) for source comparisons and rationale.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## License

MIT
