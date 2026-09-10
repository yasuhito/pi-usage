# Domain Docs

Before exploring the codebase, read:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

Missing files are created lazily when terminology or architectural decisions are
actually resolved.

This repository uses the single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use terminology defined in `CONTEXT.md`. Surface conflicts with existing ADRs
instead of silently overriding them.
