# @yasuhito/pi-usage

A [Pi](https://pi.dev) extension that shows Codex and Claude subscription usage in the default footer.

```text
Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h
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

Sign in to Pi's `openai-codex` and `anthropic` providers with `/login`. Codex and Claude are both monitored by default, even when another model is selected. There are no provider settings in this release: missing or unsuitable authentication leaves that provider visible as `unavailable` rather than removing it.

Claude subscription usage requires the OAuth authentication that Pi resolves after a Claude Pro or Max login. An ordinary Anthropic API key is not suitable and is never sent to the subscription usage endpoint. The extension asks Pi to resolve authentication at request time; it does not read Pi or Claude Code credential files.

## Display

| State | Status |
| --- | --- |
| Loading | `Codex wk loading… Claude wk loading…` |
| Available | `Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h` |
| Temporarily stale | `Codex wk ━━━━━━──── 63% 3d2h ↻2 ~ Claude wk ━━━━━━━━── 80% 4d1h ~` |
| Unavailable | `Codex wk unavailable Claude wk unavailable` |

Each percentage is provider-reported **weekly subscription usage**. The two providers retain different meanings:

- **Codex weekly quota usage** is the consumed percentage of the account's weighted weekly allowance, not a token count divided by a fixed token limit.
- **Claude subscription usage** is the consumed percentage of the Claude Pro or Max seven-day window.
- **Anthropic API-key rate limits** are request and token capacity for API use. They are not Claude subscription usage and are not shown.
- **OpenRouter usage** concerns OpenRouter keys, spending, and limits. It is not direct Claude subscription usage and is not shown, including when a Claude model is routed through OpenRouter.

Each bar has ten cells. A provider's presentation independently becomes a warning at 75% and an error at 90%.

The weekly reset countdown after the percentage is the remaining time until the provider-reported weekly window reset. It uses compact day/hour, hour/minute, or minute units without spaces between units.

The `↻N` suffix is the provider-reported number of available **limit reset credits**. It is Codex-only and appears when Codex supplies the count, including when the count is zero.

## How it works

The extension runs independent Codex and Claude monitor lifecycles. Codex usage comes from the ChatGPT usage endpoint and opportunistic `x-codex-*` response headers. Claude usage comes from the experimental first-party OAuth usage endpoint and is requested only with Pi-resolved OAuth authentication. Each monitor refreshes at startup, after relevant activity, and every minute.

Internally, session-scoped Effect monitors independently own acquisition,
polling, backoff, stale expiration, and interruption. Provider-specific
decoding stays behind small Effect interfaces; Pi event handlers are the only
runtime boundary.

### Security posture

Authenticated requests are restricted to fixed HTTPS origins: `https://chatgpt.com` for Codex and `https://api.anthropic.com` for Claude. Redirects are rejected, requests time out, and response bodies are bounded before schema validation. Credentials, usage observations, and raw provider responses are neither logged nor persisted.

The extension does not spawn provider CLIs or estimate quota from local token history.

## Current scope

This release does not implement OpenRouter usage, provider settings, Claude's five-hour window, detail commands, or manual refresh. Refreshes use the built-in schedule.

## Compatibility warning

The Codex ChatGPT usage endpoint and the Claude OAuth usage endpoint are undocumented first-party interfaces. The `x-codex-*` headers are undocumented as well. None has a public compatibility guarantee, and any may change without notice. The extension isolates and parses them defensively and displays `unavailable` when a response no longer matches the expected contract.

See [`docs/research/codex-weekly-usage.md`](docs/research/codex-weekly-usage.md), [`docs/research/codex-limit-reset-credits.md`](docs/research/codex-limit-reset-credits.md), and [`docs/research/claude-oauth-usage-prototype.md`](docs/research/claude-oauth-usage-prototype.md) for sanitized source comparisons and rationale.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## License

MIT
