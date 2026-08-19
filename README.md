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

**All 50 tools ported.** The 37 Heorth tools (`household.*`, `calendar.*`,
`meals.*`, `library.*`, `inventory.*`, `tasks.*`, `feoh.*`) landed in task A5;
the 13 `kith.*` tools in task B11. `tools/list` serves whatever the configured
upstreams provide — both, one, or (with neither configured) nothing at all. The
MCP code still lives embedded in Heorth and KithLedger and is deleted there only
once the equivalent tool here is verified against the deployed container.

## Configuration

| Variable | Meaning |
|---|---|
| `HEORTH_BASE_URL` | Heorth's base URL. Unset -> the 37 Heorth tools are not registered. |
| `KITH_BASE_URL` | KithLedger's base URL. Unset -> the 13 `kith.*` tools are not registered. **Requires `HEORTH_BASE_URL`** (see below) — set alone, it is a boot error. |
| `KITH_AUDIENCE` | The satellite audience for exchanged tokens (default `kithledger`). Must match Heorth's `SATELLITE_AUDIENCES` and KithLedger's `SATELLITE_AUDIENCE`. |
| `PORT` | Default `3200`. |
| `UPSTREAM_TIMEOUT_MS` | Per upstream call, default `10000`. |

**heorth-mcp holds no credential of its own — for either upstream.** Heorth
calls carry the caller's `Bearer he_...` verbatim. KithLedger calls carry a
short-lived member token that heorth-mcp exchanges at Heorth
(`POST /api/v1/auth/satellite-token`, ADR 0009) using that same caller
credential, cached in memory per caller for just under its 5-minute life. That
is why `kith.*` needs both upstreams: Heorth is the identity authority, so with
it unreachable the `kith.*` tools fail (`IDENTITY_UNAVAILABLE`) even when
KithLedger is healthy.

`KITH_API_KEY` is **gone**. KithLedger enforces per-member access control
(ADR 0004) and none of its three `kl_` credential kinds is the calling member: a
`member` key reads as the issuing account's own scope, a `household` key sees
only the household slice, an `ops` key has no data access at all.

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
