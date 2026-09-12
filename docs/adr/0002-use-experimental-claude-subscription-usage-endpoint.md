# Use the experimental Claude subscription usage endpoint

Use the undocumented first-party Claude OAuth usage endpoint behind an isolated experimental adapter to present Claude Pro/Max seven-day subscription usage, because Anthropic provides no supported third-party endpoint for that information and API-key rate limits are a different domain concept. Only Pi-resolved OAuth credentials may be sent to the fixed Anthropic HTTPS origin; API keys do not fall back to API rate-limit display. A prototype must first prove that Pi's resolved credential can access the endpoint; if it cannot, Claude support is postponed rather than reading Claude Code credentials, spawning Claude Code, or adding a separate OAuth flow.

The prototype succeeded on 2026-09-12. See [Claude OAuth usage endpoint prototype](../research/claude-oauth-usage-prototype.md) for the sanitized request contract, response shape, and scope conclusion.
