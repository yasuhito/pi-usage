# @yasuhito/pi-usage

A [Pi](https://pi.dev) extension that shows the active Codex account's weekly quota usage in the default footer.

```text
Codex wk ━━━━━━──── 63%
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

Sign in to Pi's `openai-codex` provider with `/login`. The meter is shown whenever that OAuth account is available, even when another model is selected.

## Display

| State | Status |
| --- | --- |
| Loading | `Codex wk loading…` |
| Current | `Codex wk ━━━━━━──── 63%` |
| Temporarily stale | `Codex wk ━━━━━━──── 63% ~` |
| Unavailable | `Codex wk unavailable` |
| Codex OAuth not configured | Hidden |

The percentage is Codex's provider-reported weighted **weekly quota usage**, not a token count divided by a fixed token limit. The bar has ten cells. The status becomes a warning at 75% and an error at 90%.

## How it works

The extension:

1. resolves the current `openai-codex` credential through Pi;
2. reads the account's usage from `https://chatgpt.com/backend-api/wham/usage`;
3. identifies a weekly window by its exact seven-day duration;
4. opportunistically incorporates `x-codex-*` response headers;
5. refreshes at startup, after relevant activity, and every minute.

It does not read Codex CLI files, spawn Codex, estimate quota from local token history, persist credentials, or follow redirects.

## Compatibility warning

The ChatGPT usage endpoint and `x-codex-*` headers are used by OpenAI's first-party Codex implementation, but they are **not documented as stable public OpenAI APIs**. The extension parses them defensively and displays `unavailable` if their format changes.

See [`docs/research/codex-weekly-usage.md`](docs/research/codex-weekly-usage.md) for the source comparison and rationale.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## License

MIT
