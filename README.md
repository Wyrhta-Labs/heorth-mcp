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

## Related repos

| Repo | Role |
|---|---|
| [`Wyrhta-Labs/wyrhta-labs`](https://github.com/Wyrhta-Labs/wyrhta-labs) | Concept, ADRs, deploy stack |
| [`Wyrhta-Labs/Heorth`](https://github.com/Wyrhta-Labs/Heorth) | Household hub — upstream |
| [`Wyrhta-Labs/KithLedger`](https://github.com/Wyrhta-Labs/KithLedger) | Relationship manager — upstream |
| [`Wyrhta-Labs/wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core) | Shared lib, pinned by git tag |
