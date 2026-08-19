# Contributing

Thanks for looking. Read this first — it is short, and it will save you effort
on a project whose shape is unusual.

## What this project is, honestly

Wyrhta Labs is a **one-maintainer, pre-1.0** self-hosted household system,
developed in the open because that is a better way to build it — not because it
is looking for a team. The primary user is the maintainer's own household. That
has consequences you should know before investing time:

- **Design decisions are made deliberately and recorded**, as ADRs in the
  [`wyrhta`](https://github.com/Wyrhta-Labs/wyrhta) meta repo. A pull request
  that contradicts an accepted ADR will be declined on those grounds, however
  good the code is. Read the relevant ADR first; if you disagree with it, argue
  with the ADR in an issue — that is a welcome conversation and a cheaper one.
- **Scope is defended.** Features land demand-driven, when something concretely
  needs them. "It would be nice if it also did X" is usually a no.
- **Review may be slow.** Evenings-and-weekends slow.

None of that means contributions are unwelcome. It means the highest-value ones
are bug reports, reproductions, security findings, documentation fixes, and
small focused patches — rather than large unsolicited features.

## Before you open a pull request

**Open an issue first** for anything beyond a typo or an obvious bug fix. A
short "here is what I hit, here is what I would change" saves you from writing
code that gets declined for a reason you could not have known.

## The repository layout will surprise you

Each service is its **own repository** — this is not a monorepo:

| Repo | What it is |
|---|---|
| [`wyrhta`](https://github.com/Wyrhta-Labs/wyrhta) | Meta repo: concept, ADRs, and the Docker Compose stack |
| [`wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core) | `@wyrhta/core` — the shared foundation library |
| [`Heorth`](https://github.com/Wyrhta-Labs/Heorth) | The flagship household system |
| [`KithLedger`](https://github.com/Wyrhta-Labs/KithLedger) | API-first personal relationship manager |
| [`heorth-mcp`](https://github.com/Wyrhta-Labs/heorth-mcp) | The household's single MCP server |
| [`website`](https://github.com/Wyrhta-Labs/website) | The public site |

The services share `@wyrhta/core` as a **pinned git-tag dependency**, not a
workspace link. A change in core reaches a consumer only when a new tag is cut
*and* the consumer's `package.json` pin is deliberately bumped — so a change
that spans core and a service is **two pull requests in two repos**, core first.
Say so in both descriptions.

To get all the repos side by side in the layout the Compose stack expects, use
the meta repo's `scripts/clone-all` — see its README.

## Working on a change

Start from the repository's own README for install and run instructions; each
service carries its own. Then:

- **Tests are not optional.** Fix a bug, add the test that would have caught it.
- **Run what CI runs** before pushing — typically `npm run typecheck` and
  `npm test`, and the web build where a repo has one. CI runs the full suite
  against a real PostgreSQL; a green local run against a different database is
  not proof.
- **The test databases are destructive.** The suites truncate every table
  between tests and refuse to run against a database whose name does not end in
  `_test`. Never point `DATABASE_URL` at anything you care about.
- **Never commit a `.env`, a key, or a real hostname.** No repository in this
  org has ever contained a secret and it should stay that way. If you need to
  show a value in documentation, use `example.com` and obvious placeholders.

## Commit messages

Conventional Commits, with an optional scope, and a subject line that says what
changed rather than what you touched:

```
feat(calendar): bound the expanded-occurrence range query with limit/offset
fix(db): one postgres pool per process, memoised on globalThis
docs: feoh always-on, inventory/occurrences/ledger surfaces, changelog
test: cut the per-test truncate churn and migrate once per process
```

Common types here: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.

## Pull requests

- One concern per pull request. A refactor bundled with a fix gets asked to
  split.
- Target `main`. The repos run a single-trunk, pre-alpha flow.
- Say what you changed, **why**, and how you verified it. "Tests pass" is not
  verification; "added `x.test.ts` covering the timezone boundary, and ran it
  against Postgres 18" is.
- Expect questions about edge cases. They are not objections.

## Reporting bugs

Include the version or commit, what you expected, what happened, and the
smallest reproduction you can manage. Logs beat prose. If it involves data from
your own household, **redact it** — nobody needs your real calendar to fix a
date bug.

## Security

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under this
repository's MIT licence.
