# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `yasuhito/pi-usage`.
Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
- Close: `gh issue close <number> --comment "..."`
- Pull requests are not treated as a triage request surface.

## Skill operations

- “Publish to the issue tracker” means creating a GitHub issue.
- “Fetch the relevant ticket” means running `gh issue view <number> --comments`.
- `/wayfinder` uses a map issue and linked child issues.
- Blocking relationships use GitHub native issue dependencies when available.
- Claiming an issue assigns it to the current user.
- Resolving an issue means commenting with the answer and closing it.
