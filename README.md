# heorth-mcp

The Wyrhta Labs household's **single MCP server**, running as its own container.

It owns no data and no domain logic. Every tool call is translated into calls
against an upstream service's public REST API — so an MCP tool can only ever do
what an authenticated household member could already do over HTTP.

```
MCP client ──Streamable HTTP──▶ heorth-mcp ──▶ Heorth REST      (37 tools)
                                           └─▶ KithLedger REST  (13 tools)
```

## Status

**Skeleton — no tools yet.** The MCP scaffold, HTTP transport, config, and the
Heorth/KithLedger REST clients are in place; the tool surface itself is still
being ported, so the server currently answers `tools/list` with an empty list.
The MCP code still lives embedded in Heorth and KithLedger.

- [`docs/spec/tool-surface.md`](docs/spec/tool-surface.md) — the 50-tool contract
  and its REST mapping
- [`docs/spec/migration.md`](docs/spec/migration.md) — what moves out of the
  upstream repos, in what order, and what must be true before each deletion
- [`CLAUDE.md`](CLAUDE.md) — architecture, auth model, and conventions

Created by **ADR 0008 — MCP as a standalone container over REST** in the meta
repo `Wyrhta-Labs/wyrhta-labs`.

## Container image

Published to the GitHub Container Registry as
**`ghcr.io/wyrhta-labs/heorth-mcp`** by
[`.github/workflows/build-image.yml`](.github/workflows/build-image.yml). The
workflow typechecks and runs the full test suite first — a red suite blocks the
publish — then builds this repo's `Dockerfile` for `linux/amd64`.

Only two things publish: a push to `main` and a `v*` git tag. Nothing else
does, so the registry stays free of branch junk.

| Tag | Produced by | Pinnable? |
|---|---|---|
| `main-<short sha>` | every push to `main` | yes — immutable, one build per commit |
| `<version>`, `<major>.<minor>`, `<major>` | a `v*` tag push (e.g. `v0.2.0` -> `0.2.0`, `0.2`, `0`) | `<version>` yes; the truncated ones move |
| `main` | every push to `main` | no — moving pointer |
| `latest` | a `v*` tag push only | no — moving pointer |

**Pinning it in production.** The meta repo's `deploy/compose.prod.yml`
requires an explicit tag in `deploy/.env`:

```
HEORTH_MCP_IMAGE_TAG=main-a1b2c3d   # a main build, by short commit sha
HEORTH_MCP_IMAGE_TAG=0.2.0          # a release, once a v0.2.0 tag exists
```

Never pin `latest` or `main` — both move under the running deployment and
defeat the point of pinning. Use the exact `main-<sha>` shown in the workflow
run (or `docker images`), or the semver of a release.

The image is private, like the repo. A host that pulls it needs a GHCR login
with `read:packages` for the `Wyrhta-Labs` org.

## Related repos

| Repo | Role |
|---|---|
| [`Wyrhta-Labs/wyrhta-labs`](https://github.com/Wyrhta-Labs/wyrhta-labs) | Concept, ADRs, deploy stack |
| [`Wyrhta-Labs/Heorth`](https://github.com/Wyrhta-Labs/Heorth) | Household hub — upstream |
| [`Wyrhta-Labs/KithLedger`](https://github.com/Wyrhta-Labs/KithLedger) | Relationship manager — upstream |
| [`Wyrhta-Labs/wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core) | Shared lib, pinned by git tag |
