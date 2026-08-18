# Spec — migrating MCP out of Heorth and KithLedger

**Status:** draft · **Decision:** ADR 0008 (meta repo `Wyrhta-Labs/wyrhta-labs`)

MCP is currently compiled into two services. This is what moves, in what order,
and what has to be true before each deletion.

## What exists today

### Heorth (`Wyrhta-Labs/Heorth`)

| Path | Lines | What it is |
|---|---|---|
| `src/mcp/server.ts` | 61 | Builds a stateless `McpServer` + Web Standard Streamable HTTP transport per request, bound to that request's `he_` key |
| `src/mcp/auth-adapter.ts` | 32 | `apiKey -> principal \| null`, bridged into core's `AuthAdapter` |
| `src/household/mcp.ts` | 29 | 2 tools |
| `src/modules/calendar/mcp.ts` | 108 | 5 tools |
| `src/modules/meals/mcp.ts` | 94 | 6 tools |
| `src/modules/library/mcp.ts` | 64 | 5 tools |
| `src/modules/inventory/mcp.ts` | 97 | 4 tools |
| `src/modules/tasks/mcp.ts` | 65 | 3 tools |
| `src/modules/feoh/mcp.ts` | 231 | 12 tools |
| `tests/*mcp*.test.ts` | — | 7 test files incl. `mcp-http-e2e.test.ts` |

Also entangled: `McpRegistry` in `src/modules/registry.ts` and the
`HeorthModule.register(app, mcp)` signature — **every module implements it**, so
removing MCP is a change to the module contract, not just a folder deletion.

### KithLedger (`Wyrhta-Labs/KithLedger`)

| Path | Lines | What it is |
|---|---|---|
| `src/mcp/server.ts` | 7 | stdio server |
| `src/mcp/index.ts` | 19 | entry point |
| `src/mcp/registry.ts` | 12 | registry assembly |
| `src/mcp/auth.ts` | 37 | resolves a single `kl_` key from env — one principal per process |
| `src/mcp/tools/*.ts` | 218 | 13 tools |
| `tests/mcp.*.test.ts` | — | 6 test files |
| `.superpowers/sdd/part2-mcp-conventions.md` | — | conventions doc |

KithLedger's MCP is **stdio-only**. `docs/strategy.md` Phase 4 lists "KithLedger's
MCP moves from stdio to HTTP" as a prerequisite for Ethel — that work is
superseded: the transport move happens by the tools landing here instead.

### wyrhta-core (`Wyrhta-Labs/wyrhta-core`)

`src/mcp/{index,scaffold,types}.ts` — `createMcpServer`, `McpTool`,
`AuthAdapter`, `McpPrincipal`, plus the `^[A-Z][A-Z0-9_]{1,63}$` domain-error
convention. Per ADR 0008 this **moves into heorth-mcp** and core stops
exporting `@wyrhta/core/mcp`.

## Order of operations

Each step is independently shippable; nothing is deleted upstream until its
replacement is green here.

1. **Scaffold heorth-mcp.** Copy `wyrhta-core/src/mcp/*` in as this repo's own
   `src/mcp/`, plus the Streamable HTTP transport wiring from Heorth's
   `src/mcp/server.ts` (which already does per-request, per-key server
   construction — keep that shape).
2. **Upstream clients.** `src/upstream/heorth.ts` and `src/upstream/kith.ts`:
   typed REST clients, `{ error: { code, message } }` envelope handling, key
   pass-through for Heorth and service key for KithLedger.
3. **Port the Heorth tools**, area by area, handler bodies rewritten from
   direct service calls into REST calls. Zod input schemas transfer verbatim.
   Port each area's tests alongside, against a faked upstream.
4. **Port the KithLedger tools** (`kith.*`), same treatment.
5. **Deploy** as a container in the meta repo's `deploy/` stack, alongside
   Heorth and KithLedger, and point a real MCP client at it.
6. **Delete upstream.** Only now, and only per area once its tools are verified
   against the deployed container:
   - Heorth: remove `src/mcp/`, every `src/**/mcp.ts`, the MCP tests, and drop
     the `mcp` parameter from `HeorthModule.register` / `createApp` — a
     mechanical but wide change.
   - KithLedger: remove `src/mcp/`, the MCP tests, the stdio entry point and its
     npm script, and `MCP_API_KEY` from config.
   - wyrhta-core: drop `src/mcp/`, cut a new tag, bump both consumers.

## What must be true before step 6

- Every tool in `tool-surface.md` is implemented here and its behaviour matches
  the upstream implementation it replaces (same inputs, same shape out, same
  error codes).
- The REST gaps in `tool-surface.md` § "Open items" are closed **upstream**, not
  worked around here.
- The deployed container is reachable by the household's MCP clients, and the
  `he_` pass-through has been exercised end to end with a real member key.
- Heorth and KithLedger still pass their own suites with MCP removed.

## What this buys, and what it costs

**Buys:** one MCP endpoint instead of two (one stdio, one HTTP); MCP versioning
decoupled from the services; the SDK dependency out of two production services;
a tool surface that provably cannot exceed the REST API.

**Costs:** one more container; an extra network hop per tool call; `kith.*`
loses per-member identity until ADR 0002 Phase B; tool changes that need new
data become two-repo changes.
