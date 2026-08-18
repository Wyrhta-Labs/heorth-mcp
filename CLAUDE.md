# CLAUDE.md — heorth-mcp

The household's **single MCP server**, running as its own container. It owns no
data and no domain logic: every tool call is translated into one or more calls
against an upstream service's **public REST API**.

Node.js 22 + TypeScript, Hono, Zod, Vitest. No database, no ORM, no migrations.

> **Status: spec-only.** This repo currently contains the specification under
> `docs/spec/` and no implementation. The MCP code still lives embedded in
> Heorth (`src/mcp/`, `src/**/mcp.ts`) and KithLedger (`src/mcp/`) and is
> removed from those repos only once the equivalent tool here is green.
> See [`docs/spec/migration.md`](docs/spec/migration.md).

## The one rule that shapes everything

**heorth-mcp is a REST client.** It does not import Heorth or KithLedger code,
does not touch their databases, and does not reach for anything the REST API
does not already expose. If a tool needs a capability the upstream API lacks,
the fix is a new REST endpoint in the upstream repo — never a shortcut from
here.

This is what makes the container replaceable, the upstream services testable
without MCP, and the tool surface honest: an MCP tool can only ever do what an
authenticated household member could already do over HTTP.

## Architecture

```
MCP client (Claude Desktop, Claude Code, …)
  │  Streamable HTTP, Authorization: Bearer he_...
  ▼
heorth-mcp  ── HEORTH_BASE_URL ──▶  Heorth REST   /api/v1/*   (he_ key passed through)
            ── KITH_BASE_URL   ──▶  KithLedger REST /api/v1/* (kl_ service key)
```

- **One process, both upstreams.** The 37 Heorth tools (`household.*`,
  `calendar.*`, `meals.*`, `library.*`, `inventory.*`, `tasks.*`, `feoh.*`) and
  the 13 KithLedger tools (`kith.*`) are served from the same endpoint.
- **Each upstream is optional.** With `HEORTH_BASE_URL` unset the Heorth tools
  are not registered; same for `KITH_BASE_URL` and `kith.*`. The container
  starts and serves whatever is configured, including nothing.
- **Transport is HTTP.** Streamable HTTP is the only supported transport;
  stdio is not offered, not even for local dev — point a local client at the
  container's URL instead.

## Auth

- **Heorth: pass-through.** The caller's `Authorization: Bearer he_...` header is
  forwarded verbatim to Heorth. heorth-mcp never validates the key itself, holds
  no Heorth credential, and cannot act without a caller. Per-member permissions
  and Heorth's audit log stay intact end to end.
- **KithLedger: service key.** heorth-mcp holds one `kl_` key
  (`KITH_API_KEY`), per ADR 0002 Phase A — the same arrangement Heorth already
  uses for the reminders feed. `kith.*` tools therefore act as one service
  principal, not as the calling member. This is a known asymmetry; it resolves
  when ADR 0002 Phase B (Heorth-issued SSO) lands.
- A missing or malformed `Authorization` header fails the request before any
  upstream call. Never log key material.

## Conventions

- **Tools are namespaced by upstream area** (`<area>.<verb_noun>`, snake_case
  verb) and their names are frozen — they are a public contract with MCP
  clients. Renaming a tool is a breaking change; adding one is not.
- **One module per tool group** under `src/tools/<area>.ts`, each exporting a
  registry array. `src/tools/index.ts` assembles the full registry from the
  upstreams that are configured.
- **Upstream calls** go through the typed client in `src/upstream/` — one
  client per upstream, no bare `fetch` in tool handlers.
- **Errors:** upstream `4xx`/`5xx` bodies use the `{ error: { code, message } }`
  envelope from `@wyrhta/core/http`. Map `code` straight through as the tool
  error text when it matches `^[A-Z][A-Z0-9_]{1,63}$`; anything else becomes a
  generic `tool error`. Never leak upstream stack traces, URLs, or headers.
- **Tests are hermetic.** No database, no live upstream: tests run tool handlers
  against a faked HTTP upstream installed via a `set*Runtime` seam. A test that
  needs a real Heorth is an e2e test and lives in `tests/e2e/`.
- **The MCP scaffold lives here**, not in `@wyrhta/core` — it moved out of core
  as part of this change, so core no longer ships `@wyrhta/core/mcp`.

## Where this fits

Part of [Wyrhta Labs](https://github.com/Wyrhta-Labs). The cross-cutting
concept, architecture decisions, and the deploy stack live in the meta repo
`Wyrhta-Labs/wyrhta-labs`; the decision that created this repo is **ADR 0008 —
MCP as a standalone container over REST**.

Sibling repos: `Wyrhta-Labs/Heorth` (hub), `Wyrhta-Labs/KithLedger`
(satellite), `Wyrhta-Labs/wyrhta-core` (shared lib, pinned by git tag).

## Common commands

Not yet — there is no implementation. When there is, they belong here.

Git operations against GitHub go through `gh` (the credential helper).
