# AGENTS.md — heorth-mcp

The household's **single MCP server**, running as its own container. It owns no
data and no domain logic: every tool call is translated into one or more calls
against an upstream service's **public REST API**.

Node.js 22 + TypeScript, Hono, Zod, Vitest. No database, no ORM, no migrations.

> All 50 tools are ported. The MCP code still lives embedded in Heorth
> (`src/mcp/`, `src/**/mcp.ts`) and KithLedger (`src/mcp/`), and is removed
> from those repos only once the equivalent tool here is green — see
> [`docs/spec/migration.md`](docs/spec/migration.md).

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
            ── HEORTH_BASE_URL ──▶  POST /auth/satellite-token (exchange, ADR 0009)
            ── KITH_BASE_URL   ──▶  KithLedger REST /api/v1/* (exchanged member JWT)
```

- **One process, both upstreams.** The 37 Heorth tools (`household.*`,
  `calendar.*`, `meals.*`, `library.*`, `inventory.*`, `tasks.*`, `feoh.*`) and
  the 13 KithLedger tools (`kith.*`) are served from the same endpoint.
- **Each upstream is optional** — with one asymmetry. With `HEORTH_BASE_URL`
  unset the Heorth tools are not registered; same for `KITH_BASE_URL` and
  `kith.*`. But `kith.*` also needs Heorth, because that is where its member
  token is minted, so `KITH_BASE_URL` alone is a boot error. The container
  starts and serves whatever is configured, including nothing.
- **Transport is HTTP.** Streamable HTTP is the only supported transport;
  stdio is not offered, not even for local dev — point a local client at the
  container's URL instead.

## Auth

- **Heorth: pass-through.** The caller's `Authorization: Bearer he_...` header is
  forwarded verbatim to Heorth. heorth-mcp never validates the key itself, holds
  no Heorth credential, and cannot act without a caller. Per-member permissions
  and Heorth's audit log stay intact end to end.
- **KithLedger: exchanged member token** (ADR 0009). heorth-mcp holds
  **no** KithLedger credential. On the first `kith.*` call of a caller it posts
  the caller's own `Authorization` header to Heorth's
  `POST /api/v1/auth/satellite-token` with `{ "audience": "kithledger" }`, and
  presents the returned 5-minute JWT (`sub`, `role`, `iss: heorth`,
  `aud: kithledger`) to KithLedger, which verifies it against Heorth's JWKS and
  provisions the member just in time. So `kith.*` acts as the **calling
  member**, and KithLedger's ADR 0004 enforcement applies to it — do not
  re-add a local permission check here, exactly as with the Heorth tools.
  - **heorth-mcp must stay unmintable.** It holds no signing key and must never
    acquire one; it can only ask Heorth, with a credential the caller supplied.
  - **Token cache** (`src/upstream/exchange.ts`): in memory only, keyed by
    `sha256(presented credential)` plus the audience, evicted at `exp - 30s`.
    Never written to disk, never logged, never shared between callers — a
    coarser key would let one member act as another.
  - **Heorth is a runtime dependency of `kith.*`.** With Heorth unreachable they
    fail `IDENTITY_UNAVAILABLE` even when KithLedger is healthy. ADR 0009
    accepts that: Heorth is the identity authority.
  - The old `kl_` service key (`KITH_API_KEY`) is **removed**, not repurposed.
    None of KithLedger's three credential kinds is the calling member.
- A missing or malformed `Authorization` header fails the request before any
  upstream call. Never log key material.

**Settled — decided, not open:**

- **`initialize` and `tools/list` are unauthenticated; the key is demanded at
  `tools/call`.** This matches Heorth's existing MCP behaviour and is
  deliberate: a client may discover the surface before it holds a credential.
- **`McpPrincipal.userId` is a SHA-256 fingerprint of the presented key**, used
  only for log correlation, and `role` is unset. heorth-mcp validates nothing
  locally and must not assert an identity it did not verify. Heorth's REST
  routes carry the guards themselves — `requireRole('admin','adult')` on every
  feoh and inventory write, the maintenance-admin quarantine on the acting
  principal, `assertCanMutate` on calendar writes — and derive the actor from
  the authenticated caller (`requireAuth` resolves an `he_` key to
  `{ userId, role }`). **Never re-add a local role check here.** Likewise
  `household.whoami` goes through `GET /api/v1/auth/whoami` — the fingerprint
  is not a member id.
- **`KITH_BASE_URL` without `HEORTH_BASE_URL` fails at boot**, because the
  member credential is exchanged per request at Heorth rather than read from the
  environment. Both upstreams, or no `kith.*` tools.

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
`HEORTH_BASE_URL`, `KITH_BASE_URL` (requires `HEORTH_BASE_URL`), `KITH_AUDIENCE`
(default **kithledger**), `PORT` (default **3200**), `UPSTREAM_TIMEOUT_MS`
(default **10000** — 10s per upstream call). See `.env.example`. The container
also serves **`/health`** for its healthcheck, alongside `/mcp`.

Git operations against GitHub go through `gh` (the credential helper).
