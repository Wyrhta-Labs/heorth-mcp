# CLAUDE.md — heorth-mcp

The household's **single MCP server**, running as its own container. It owns no
data and no domain logic: every tool call is translated into one or more calls
against an upstream service's **public REST API**.

Node.js 22 + TypeScript, Hono, Zod, Vitest. No database, no ORM, no migrations.

> **Status: skeleton.** The MCP scaffold, the HTTP transport, config, and the
> two upstream REST clients are in place; **no tools are ported yet**, so the
> server currently serves an empty tool list. The MCP code still lives embedded
> in Heorth (`src/mcp/`, `src/**/mcp.ts`) and KithLedger (`src/mcp/`) and is
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

**Settled (A1/A2 — these are decided, not open):**

- **`initialize` and `tools/list` are unauthenticated; the key is demanded at
  `tools/call`.** This matches Heorth's existing MCP behaviour and is
  deliberate: a client may discover the surface before it holds a credential.
- **`McpPrincipal.userId` is a SHA-256 fingerprint of the presented key**, used
  only for log correlation, and `role` is unset. heorth-mcp validates nothing
  locally and must not assert an identity it did not verify.
  **Verified (task A4):** Heorth's REST routes carry the guards themselves —
  `requireRole('admin','adult')` on every feoh and inventory write, the
  maintenance-admin quarantine on the acting principal, `assertCanMutate` on
  calendar writes — and derive the actor from the authenticated caller
  (`requireAuth` resolves an `he_` key to `{ userId, role }`). **No guard is
  lost in the port: whoever ports `feoh.*` (or `inventory.*`) must not re-add a
  local role check.** Likewise `household.whoami` has to go through
  `GET /api/v1/auth/whoami` — the fingerprint is not a member id.
- **`KITH_BASE_URL` without `KITH_API_KEY` fails at boot.** Temporary: issue #1
  decision 9 replaces the service key with a member JWT (task B11), at which
  point the credential is resolved per request instead of from the environment.

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

```
npm run dev         # tsx watch src/index.ts
npm run typecheck   # src + tests
npm test            # vitest run (hermetic: no network, no database)
npm run build       # tsc -> dist/
npm start           # node dist/index.js
```

Config comes from the environment, validated in `src/config/env.ts`:
`HEORTH_BASE_URL`, `KITH_BASE_URL`, `KITH_API_KEY` (required when
`KITH_BASE_URL` is set), `PORT` (default **3200**), `UPSTREAM_TIMEOUT_MS`
(default **10000** — 10s per upstream call). See `.env.example`. The container
also serves **`/health`** for its healthcheck, alongside `/mcp`.

Git operations against GitHub go through `gh` (the credential helper).
