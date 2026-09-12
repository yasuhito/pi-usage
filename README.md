# @yasuhito/pi-usage

A [Pi](https://pi.dev) extension that shows Codex and Claude subscription usage in the default footer.

```text
Codex wk ━━━━━━──── 63% · reset 3d 2h · ↻2 Claude wk ━━━━━━━━── 80% · reset 4d 1h
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

Sign in to Pi's `openai-codex` and `anthropic` providers with `/login`. Both providers are monitored even when another model is selected. Missing or unsuitable authentication remains visible as unavailable.

## Display

| State | Status |
| --- | --- |
| Loading | `Codex wk loading… Claude wk loading…` |
| Available | `Codex wk ━━━━━━──── 63% · reset 3d 2h · ↻2 Claude wk ━━━━━━━━── 80% · reset 4d 1h` |
| Temporarily stale | `Codex wk ━━━━━━──── 63% · reset 3d 2h · ↻2 ~ Claude wk ━━━━━━━━── 80% · reset 4d 1h ~` |
| Unavailable | `Codex wk unavailable Claude wk unavailable` |

Each percentage is the provider-reported **weekly subscription usage**. Codex's percentage is weighted **weekly quota usage**, not a token count divided by a fixed token limit. Each bar has ten cells. A provider's presentation independently becomes a warning at 75% and an error at 90%.

The `reset` suffix is the remaining time until the provider-reported weekly window reset. It uses compact day/hour, hour/minute, or minute units.

The `↻N` suffix is the provider-reported number of available **limit reset credits**. It appears when Codex supplies the count, including when the count is zero.

## How it works

The extension runs independent Codex and Claude monitor lifecycles. Codex usage comes from the ChatGPT usage endpoint and opportunistic `x-codex-*` response headers. Claude usage comes from the experimental first-party OAuth usage endpoint and is requested only with Pi-resolved OAuth authentication. Each monitor refreshes at startup, after relevant activity, and every minute.

Internally, session-scoped Effect monitors independently own acquisition,
polling, backoff, stale expiration, and interruption. Provider-specific
decoding stays behind small Effect interfaces; Pi event handlers are the only
runtime boundary.

It does not read Codex or Claude Code credential files, spawn their CLIs, estimate quota from local token history, persist credentials, or follow redirects.

## Compatibility warning

The ChatGPT usage endpoint, `x-codex-*` headers, and Claude OAuth usage endpoint are **not documented as stable public APIs**. The extension parses them defensively and displays `unavailable` if their format changes.

See [`docs/research/codex-weekly-usage.md`](docs/research/codex-weekly-usage.md) and [`docs/research/codex-limit-reset-credits.md`](docs/research/codex-limit-reset-credits.md) for source comparisons and rationale.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## License

MIT
