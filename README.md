# @yasuhito/pi-usage

A [Pi](https://pi.dev) extension that shows Codex and Claude subscription usage plus the OpenRouter account credit balance in the default footer.

```text
Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h OpenRouter $12.34 left
```

It uses `ctx.ui.setStatus()`, so it coexists with other status extensions such as [`pi-smart-zone`](https://pi.dev/packages/pi-smart-zone).

## Install

From npm:

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

Sign in to Pi's `openai-codex` and `anthropic` providers with `/login` to enable their usage meters. Sign in to `openrouter` separately only when you want to run OpenRouter models; its inference credential does not give access to the balance shown here. Codex, Claude, and OpenRouter are always monitored, even when another model is selected. This release has no provider settings, so a provider with missing or unsuitable credentials stays in the footer as `unavailable` instead of disappearing.

Reading the OpenRouter credit balance requires a separate [Management Key](https://openrouter.ai/docs/guides/overview/auth/management-api-keys); the inference key created by `/login openrouter` cannot read it. On Linux, store the Management Key once in the OS keychain without placing it in shell history:

```bash
secret-tool store \
  --label="Pi Usage OpenRouter Management Key" \
  application pi-usage \
  credential openrouter-management-key
```

Pi Usage looks up that key automatically. If `secret-tool` is missing, the keychain has no matching entry, or the platform is not Linux, it falls back to the `OPENROUTER_MANAGEMENT_KEY` environment variable. Never commit the key to any repository.

Claude subscription usage requires the OAuth authentication that Pi resolves after a Claude Pro or Max login. An ordinary Anthropic API key is not suitable and is never sent to the Claude OAuth usage endpoint. Pi Usage asks Pi to resolve authentication at request time; it does not read Pi or Claude Code credential files.

Claude usage currently requires Linux and a private, user-owned `XDG_RUNTIME_DIR` (normally `/run/user/<uid>` with mode `0700`) for cross-process coordination. Without that secure runtime location, Claude remains `unavailable` and the TUI warns once per Pi process. Claude usage is not yet supported on macOS or Windows.

## Display

| State | Status |
| --- | --- |
| Loading | `Codex wk loading… Claude wk loading… OpenRouter loading…` |
| Available | `Codex wk ━━━━━━──── 63% 3d2h ↻2 Claude wk ━━━━━━━━── 80% 4d1h OpenRouter $12.34 left` |
| Temporarily stale | `Codex wk ━━━━━━──── 63% 3d2h ↻2 ~ Claude wk ━━━━━━━━── 80% 4d1h ~ OpenRouter $12.34 left ~` |
| Unavailable | `Codex wk unavailable Claude wk unavailable OpenRouter unavailable` |

`wk` means weekly. A trailing `~` means the last observed value is temporarily stale: Codex and OpenRouter keep it for at most ten minutes, while Claude keeps it until its reported reset. A reset can shorten Codex's retention.

Each percentage is provider-reported **weekly subscription usage**, but Codex and Claude measure it differently. The terms used here mean:

- **Codex weekly quota usage** is the percentage of the account's weighted weekly allowance used, not a token count divided by a fixed token limit.
- **Claude subscription usage** is the percentage of the Claude Pro or Max seven-day window used.
- **Anthropic API-key rate limits** are request and token capacity for API use. They are not Claude subscription usage and are not shown.
- **OpenRouter account credit balance** is the account's total purchased credits minus its total usage. It is account-scoped and differs from an individual inference key's configured spending limit.

Each bar has ten cells. Used cells are green below 80%; at 80% a provider's presentation changes to a warning, and at 90% to an error, independently of the other providers.

The countdown after the percentage is the time left until the provider-reported weekly window resets. It is written compactly in days and hours, hours and minutes, or minutes, with no spaces (for example, `3d2h`).

The `↻N` suffix shows the provider-reported number of available **limit reset credits**. It appears only for Codex, whenever Codex reports the count, even when the count is zero.

## How it works

Pi Usage runs a separate monitor for each of Codex, Claude, and OpenRouter. Codex usage comes from the Codex ChatGPT usage endpoint and from `x-codex-*` response headers when they appear. Claude usage comes from the experimental, undocumented Claude OAuth usage endpoint and is requested only with Pi-resolved OAuth authentication. The OpenRouter balance comes from its documented credits endpoint using a separately configured Management Key.

Each monitor refreshes at startup and after relevant activity. Codex polls every minute. Claude refreshes after activity at most once every three minutes, and polls every fifteen minutes. OpenRouter does not poll periodically; it refreshes after OpenRouter activity and provider/account changes. If an OpenRouter refresh fails, the last successful value stays in the footer, marked `~`, for up to ten minutes.

Claude requests are coordinated across `/reload`, `/new`, and concurrent Pi processes. A successful result is reused for three minutes. After a temporary failure, every instance waits for the same retry time; a `429` response waits for `Retry-After`, but never less than fifteen minutes. This stops each loaded instance from repeating the same request.

Internally, session-scoped Effect monitors independently own acquisition, polling, backoff, stale expiration, and interruption. Provider-specific decoding stays behind small Effect interfaces; Pi event handlers connect the monitors to Pi's runtime.

### Security posture

Authenticated requests are restricted to fixed HTTPS origins: `https://chatgpt.com` for Codex, `https://api.anthropic.com` for Claude, and `https://openrouter.ai` for OpenRouter. Redirects are rejected, requests time out, and response bodies are bounded before schema validation. Pi Usage never logs or persists credentials or raw provider responses. On Linux, Management Key lookup runs `secret-tool` directly, without a shell, and limits both its run time and its output.

To coordinate Claude requests, Pi Usage stores sanitized usage percentages, reset timestamps, and retry scheduling metadata only in `XDG_RUNTIME_DIR`, the per-user runtime directory the OS manages. It never writes them to durable package or project storage. Entries are partitioned by an HMAC of the OAuth credential using an ephemeral runtime secret, so neither the credential nor its plain fingerprint is stored. Entries unused for twenty-four hours are removed on a best-effort basis.

Pi Usage does not spawn provider CLIs or estimate quota from local token history.

## Current scope

This release does not implement provider settings, OpenRouter inference-key spending limits, non-Linux keychain integrations, Claude usage on macOS or Windows, Claude's five-hour window, detail commands, or manual refresh. Refreshes follow the built-in schedule.

## Compatibility warning

The Codex ChatGPT usage endpoint and the experimental Claude OAuth usage endpoint are undocumented first-party interfaces. The `x-codex-*` headers are undocumented as well. None of them has a public compatibility guarantee, and any of them may change without notice. Pi Usage isolates and parses them defensively and displays `unavailable` when a response no longer matches the expected contract.

See [`codex-weekly-usage.md`](https://github.com/yasuhito/pi-usage/blob/main/docs/research/codex-weekly-usage.md), [`codex-limit-reset-credits.md`](https://github.com/yasuhito/pi-usage/blob/main/docs/research/codex-limit-reset-credits.md), [`claude-oauth-usage-prototype.md`](https://github.com/yasuhito/pi-usage/blob/main/docs/research/claude-oauth-usage-prototype.md), and [`claude-openrouter-usage.md`](https://github.com/yasuhito/pi-usage/blob/main/docs/research/claude-openrouter-usage.md) for source comparisons and rationale.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## License

MIT
