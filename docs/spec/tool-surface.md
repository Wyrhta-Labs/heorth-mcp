# Spec — MCP tool surface

**Status:** verified · **Verified:** 2026-08-18 (task A4) against
`Wyrhta-Labs/Heorth` @ `46666d7` and `Wyrhta-Labs/KithLedger` @ `main`.

**Source of truth for behaviour:** the MCP code still embedded in Heorth
(`src/household/mcp.ts`, `src/modules/*/mcp.ts`) and KithLedger
(`src/mcp/tools/*.ts`). **Source of truth for the mapping:** each module's
`index.ts` (mount prefix), `routes.ts` (path, guards, response shape) and
`validators.ts` (exact query/body field names).

This is the contract heorth-mcp implements. Tool names are frozen: they are what
MCP clients call. The **REST** column is the upstream endpoint the handler
translates to — relative to `/api/v1` on the respective base URL.

## How to read the tables

- Every row below was read off the real route table and Zod validator, not
  inferred from the tool's input schema. Where a row is **not** fully confirmed
  it says so in its Notes cell — nothing in this file is a guess presented as
  fact.
- **Field names are given exactly as the upstream validator spells them.** Heorth
  mixes conventions on purpose: query parameters are snake_case in calendar
  (`member_id`) and tasks (`member_id`, `list_id`, `due_from`, `due_to`) but
  camelCase in library (`mediaType`, `memberId`) and feoh (`billId`); request
  **bodies** are camelCase everywhere. KithLedger query parameters are
  snake_case (`person_id`, `birthday_month`, `due_before`), bodies camelCase —
  except `snooze_until`, which is snake_case in a body.
- **Response envelope.** Every JSON route returns core's `{ data, meta }`
  envelope via `ok(c, data, meta)`; errors return `{ error: { code, message } }`.
  The embedded MCP handlers returned bare or differently-keyed objects
  (`{ events: [...] }`, `{ items, total }`, …), so **every** port has some
  reshaping to do. The Notes column only calls this out where the reshaping is
  more than "unwrap `data`".

## Heorth upstream (`HEORTH_BASE_URL`) — 37 tools

Auth: caller's `Bearer he_...`, passed through. Heorth's `requireAuth` resolves
an `he_` API key to `{ userId, role }` (`src/wiring.ts`), so `requireRole` gates
work identically for key-authenticated callers — see AGENTS.md, "Auth".

### household (2) — mounted at `/api/v1/household`, `/api/v1/members`, `/api/v1/auth`

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `household.get_members` | `GET /members` | — | **Corrected.** Was `GET /household`, which returns the *household* record, not members. `GET /members` → `{ data: Member[], meta: { total } }`; tool returned `{ members }`. |
| `household.whoami` | `GET /auth/whoami` | — | **Corrected.** Was `GET /household/whoami` (no such route). The route derives the member from the authenticated caller — which is exactly what the port needs, since heorth-mcp's `McpPrincipal.userId` is a key fingerprint and carries no member id. 404 `NOT_FOUND` when unknown. |

### calendar (5) — mounted at **`/api/v1/events`** (`src/modules/calendar/index.ts`)

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `calendar.list_events` | `GET /events` | query: `from`, `to` (ISO datetime, both required together for the expanded range view), `member_id`, `limit`, `offset` | **Corrected path** (`/calendar` → `/events`). Query key is `member_id`, snake_case. Returns `{ data: occurrences, meta: { total, limit, offset } }`; tool returned `{ events: rows }`. |
| `calendar.create_event` | `POST /events` | body: `title`, `startAt`, `endAt`, `allDay`, `location`, `notes`, `category`, `color`, `recurrence`, `attendeeIds[]` | **Corrected path.** Body field names match the tool schema verbatim. `createdBy` is derived from the caller — never sent. REST adds a refine (`endAt >= startAt`) the tool lacked; stricter, not weaker. 201. |
| `calendar.update_event` | `PATCH /events/:id` | body: same fields, all optional (no `id` in the body) | **Corrected path.** The route runs `assertCanMutate` itself (mirrored M365 events → 403 `EVENT_READ_ONLY`; children may only edit their own → 403 `FORBIDDEN`). Do **not** re-implement that check in heorth-mcp. |
| `calendar.move_event` | `POST /events/:id/move` | body: `startAt` (required), `endAt` (optional) | **Corrected path.** Same `assertCanMutate` guard on the route. |
| `calendar.list_upcoming` | `GET /events?from=<now>&to=<now+90d>&limit=&member_id=` | query as above | **Corrected path, and expressible only since A3** (`46666d7`). Heorth's `service.listUpcoming` is now literally this bounded range query, so the two provably agree. The port computes `from = now` and `to = now + 90 days` client-side — that is arithmetic on the *request*, not filtering of results, so the "no compensating in heorth-mcp" rule holds. Tool default `limit` 10 (tool max 50; the endpoint caps at 100). |

### meals (6) — mounted at **`/api/v1/recipes`** and `/api/v1/meals` (`src/modules/meals/index.ts`)

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `meals.list_recipes` | `GET /recipes` | query: `tag`, `limit`, `offset` | **Corrected path** (`/meals` → `/recipes`). The route reads these three straight off the query (no Zod schema; `limit`/`offset` via `Number()`). Returns `{ data: rows, meta: { total, limit, offset } }`; tool returned `{ recipes: rows }`. |
| `meals.create_recipe` | `POST /recipes` | body: `title`, `servings`, `ingredients[{name,qty,unit}]`, `steps[]`, `tags[]` | **Corrected path.** Author derived from the caller. 201. |
| `meals.plan_meal` | `POST /meals/plan` | body: `date` (YYYY-MM-DD), `slot`, `recipeId`, `freeText`, `cook`, `helper` | Confirmed. Upserts; returns 201. |
| `meals.get_week_plan` | `GET /meals/plan` | query: `from`, `to` (both required, YYYY-MM-DD) | Confirmed. Returns `{ data: entries }`; tool returned `{ entries }`. |
| `meals.generate_shopping_list` | `POST /meals/shopping-list/generate` | **query** (not body): `from`, `to` (both required, YYYY-MM-DD) | Confirmed path; `from`/`to` are **query parameters on a POST** — easy to get wrong. 201, `{ data: items }`; tool returned `{ items }`. |
| `meals.check_off_item` | `PATCH /meals/shopping-list/:id` | body: `checked` (endpoint also accepts `name`, `qty`, `unit`) | Confirmed. The tool defaults `checked` to `true`; send it explicitly. |

### library (5) — mounted at `/api/v1/library`

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `library.list_items` | `GET /library/items` | query (camelCase): `mediaType`, `memberId`, `provider`, `status`, `list`, `tag`, `limit`, `offset` | Confirmed, camelCase keys included. Returns `{ data: rows, meta: { total, limit, offset } }`; tool returned `{ items, total }`. |
| `library.search` | `GET /library/items/search` | query: `q` (required, else 400) | Confirmed. The route is declared **before** `/items/:id`, so there is no collision. Returns `{ data: items }`. |
| `library.get_item` | `GET /library/items/:id` | — | Confirmed. 404 `NOT_FOUND`. |
| `library.list_connections` | `GET /library/connections` | — | Confirmed. Returns `{ data: connections }`; tool returned `{ connections }`. |
| `library.sync_connection` | `POST /library/connections/:id/sync` | — | Confirmed. Errors: 404 `NOT_FOUND`, **502 `SYNC_FAILED`** on provider failure. Both match the domain-code convention and pass through. |

### inventory (4) — mounted at `/api/v1/inventory`

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `inventory.list_items` | `GET /inventory/items` | query: `status` (`active`/`decommissioned`), `category`, `q`, `limit`, `offset` | Confirmed. The tool returned the raw `{ rows, total, limit, offset }`; REST splits it into `data` + `meta`. |
| `inventory.get_item` | `GET /inventory/items/:id` | — | Confirmed. 404 `NOT_FOUND` (the tool returned an `isError` "Item not found"). |
| `inventory.record_item` | `POST /inventory/items` | body: `name`, `category`, `manufacturer`, `model`, `serialNumber`, `location`, `notes`, `warrantyUntil`, `purchasePrice`, `purchaseDate` | Confirmed. The route is gated `requireRole('admin','adult')` — the tool's local `assertCanWrite` is **not** ported. 201. |
| `inventory.decommission_item` | `POST /inventory/items/:id/decommission` | body: `date`, `reason` (`broken`/`sold`/`given_away`/`worn_out`/`lost`/`other`), `proceeds?` | Confirmed. Same role gate on the route. 409 `ALREADY_DECOMMISSIONED`, 404 `NOT_FOUND`. |

### tasks (3) — mounted at `/api/v1/tasks`

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `tasks.list` | `GET /tasks` | query (snake_case): `status`, `member_id`, `list_id`, `due_from`, `due_to` | Confirmed, snake_case keys included. Returns `{ data: rows, meta: { total } }`; tool returned `{ tasks: rows }`. |
| `tasks.create` | `POST /tasks` | body: `title`, `notes`, `dueAt` | Confirmed. Author from the caller. 201. Provider failures are classified by the route: 409 (`NEEDS_REAUTH`, `NO_CONNECTION`, `SHARED_LIST_UNAVAILABLE`, `UNKNOWN_LIST`), 502 (`GRAPH_5XX`), 503 (`NETWORK_ERROR`) — all match the domain-code pattern and pass through unchanged. |
| `tasks.complete` | `POST /tasks/:id/complete` | body: `completed` (**required** — the REST schema has no default; the tool defaulted to `true`) | Confirmed. Always send `completed` explicitly. 404 `NOT_FOUND`. |

### feoh (12) — mounted at `/api/v1/feoh`

Every write route is wrapped in `canWrite` = `requireRole('admin','adult')` plus
the maintenance-admin quarantine on the acting principal. The tools' local
`assertCanWrite` / `assertNotMaintenanceAdmin` calls are therefore **not**
ported — see AGENTS.md, "Auth".

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `feoh.list_envelopes` | `GET /feoh/envelopes` | — | Confirmed. `{ data: envelopes }`; tool returned `{ envelopes }`. |
| `feoh.record_transaction` | `POST /feoh/transactions` | body: `date`, `payee`, `memo`, `amount`, `postings[{accountId,envelopeId,debit,credit}]` (min 2), `splits[{memberId,share}]` | Confirmed. `createdBy` is derived from the caller and is **not** an input field. The route additionally runs `assertNoneAreMaintenanceAdmin` over `splits`. Errors: 400 `UNBALANCED`, 400 `VALIDATION_ERROR` (orphan posting). 201. |
| `feoh.get_month_summary` | `GET /feoh/summary` | query: `month` (`YYYY-MM`, required) | Confirmed. |
| `feoh.list_recurring_bills` | `GET /feoh/bills` | — | Confirmed. `{ data: bills }`; tool returned `{ bills }`. |
| `feoh.import_csv` | `POST /feoh/import` | **raw text body** (`c.req.text()`), *not* JSON `{ csv }` | **Corrected request form.** The route reads the body as text and 400s on an empty one. The port must send the CSV as the raw body with a non-JSON `Content-Type` — which `src/upstream/http.ts` cannot do today (it always `JSON.stringify`s and sets `application/json`). **A5 must extend the transport.** Errors: 400 `UNKNOWN_REFERENCE`, 400 `VALIDATION_ERROR`. 201. |
| `feoh.export_ledger` | `GET /feoh/export?format=ledger` | query: `format` — **must be `ledger`**; the default is `csv` | **Corrected.** Without `format=ledger` the endpoint returns a *transaction CSV* with a 200 — a silently wrong result, not an error. The response is `text/plain`, not the JSON envelope, so the transport also needs a text-response path (same A5 extension as `import_csv`). Tool returned `{ ledger: "<text>" }`. |
| `feoh.list_occurrences` | `GET /feoh/occurrences` | query (camelCase `billId`): `from`, `to` (YYYY-MM-DD), `billId`, `status` (`planned`/`paid`/`overdue`/`skipped`/`unknown`) | Confirmed. `{ data: occurrences }`; tool returned `{ occurrences }`. |
| `feoh.link_occurrence` | `POST /feoh/occurrences/link` | body: `billId`, `dueDate`, `transactionId` | Confirmed. Returns `{ data: { ok: true } }`. Errors: 404 `NOT_FOUND`, 400 `NOT_AN_OCCURRENCE`, 409 `ALREADY_PAID`, 409 `ALREADY_SKIPPED`. |
| `feoh.skip_occurrence` | `POST /feoh/occurrences/skip` | body: `billId`, `dueDate` | Confirmed. Same error set. |
| `feoh.get_item_costs` | `GET /feoh/item-costs/:itemId` | — | Confirmed. 404 `NOT_FOUND`. |
| `feoh.link_item_cost` | `POST /feoh/item-costs` | body: `transactionId`, `itemId`, `kind` (`purchase`/`disposal`/`repair`/`maintenance`/`accessory`) | Confirmed. Errors: 404 `NOT_FOUND`, 409 `ITEM_DECOMMISSIONED`, 400 `NOT_A_COST`, 409 `DUPLICATE_LINK`. 201. |
| `feoh.account_ledger` | `GET /feoh/accounts/:id/ledger` | query: `from`, `to` (YYYY-MM-DD), `limit`, `offset` | Confirmed. **Shape differs:** the tool returned the whole ledger object (entries plus the window's opening/end balance); the route returns `ok(c, ledger.entries, ledger.meta)`, i.e. `{ data: entries, meta: { …balances } }`. The port must recombine `data` + `meta` into the tool's single object. 404 `NOT_FOUND`. |

## KithLedger upstream (`KITH_BASE_URL`) — 13 tools

Auth: a **Heorth-issued member token**, exchanged per caller (ADR 0009, task
B11) — `POST {HEORTH_BASE_URL}/api/v1/auth/satellite-token` with
`{ "audience": "kithledger" }`, authenticated by the caller's own `he_` key,
answering a 5-minute JWT that KithLedger verifies against Heorth's JWKS. So
`kith.*` acts as the **calling member**, and KithLedger's ADR 0004 per-member
enforcement applies to every row, edge and count these tools see; visibility is
never filtered here. The `kl_` service key is gone — none of KithLedger's three
credential kinds is the calling member. Routers are mounted at
`/api/v1/{people,interactions,reminders,relationships}` (`src/routes/index.ts`).

**All 13 mappings were already correct.** Field names verified against
`src/validators/*.ts`.

| Tool | REST (verified) | Params | Notes |
|---|---|---|---|
| `kith.list_people` | `GET /people` | query: `q`, `tags` (comma-separated), `birthday_month`, `sort`, `order`, `limit`, `offset` | Confirmed. `{ data: rows, meta: { total, limit, offset } }`; tool returned `{ items, total, limit, offset }`. |
| `kith.get_person` | `GET /people/:id` | — | Confirmed. 404 `NOT_FOUND`. |
| `kith.create_person` | `POST /people` | body: `name`, `email`, `phone`, `birthday`, `tags[]`, `notes`, `avatarUrl` | Confirmed. 201. |
| `kith.update_person` | `PATCH /people/:id` | body: the same fields, all optional; `id` belongs in the path only | Confirmed. The tool took `id` alongside the fields and Zod stripped it — the port must not forward it in the body. |
| `kith.get_person_graph` | `GET /people/:id/graph` | query: `depth` (1–3, default 1) | Confirmed. Declared directly in `mountRoutes`, not in `people.ts`. Meta carries `root_person_id` and `depth`; the tool returned the graph alone. |
| `kith.list_interactions` | `GET /interactions` | query: `person_id`, `type`, `from`, `to`, `limit`, `offset` | Confirmed (snake_case `person_id`). |
| `kith.log_interaction` | `POST /interactions` | body: `personId`, `occurredAt`, `type`, `channel`, `notes`, `sentiment` | Confirmed — the body is camelCase `personId` while the list query is `person_id`. 201. |
| `kith.list_relationships` | `GET /relationships` | query: `person_id`, `type`, `limit`, `offset` | Confirmed. |
| `kith.create_relationship` | `POST /relationships` | body: `fromPersonId`, `toPersonId`, `type`, `label`, `isMutual`, `notes` | Confirmed. The self-relationship refine and `RELATIONSHIP_EXISTS` → 409 are enforced by the route. 201. |
| `kith.list_reminders` | `GET /reminders` | query: `person_id`, `status`, `kind`, `statuses` (comma-separated; wins over `status`), `due_before`, `overdue` (`"true"`/`"false"` **as strings**), `limit`, `offset` | Confirmed. The tool exposed the whole query schema, `statuses`/`overdue` included — note `overdue` is a string enum, not a boolean. |
| `kith.create_reminder` | `POST /reminders` | body: `personId`, `dueAt`, `title`, `notes`, `recurrence`, `kind`, `leadDays` | Confirmed. 201. |
| `kith.complete_reminder` | `POST /reminders/:id/complete` | — (no body) | Confirmed. 404 `NOT_FOUND`. |
| `kith.snooze_reminder` | `POST /reminders/:id/snooze` | body: **`snooze_until`** (snake_case, ISO datetime) | Confirmed. The one snake_case *body* field in either upstream. |

## Tools REST cannot express today

**None.** All 50 tools are reachable over the existing REST surface as mapped
above. The A3 change to `GET /api/v1/events` closed the only real gap
(`calendar.list_upcoming`); verification found nothing else needing a new
upstream endpoint.

Three things are *expressible but not yet portable*. They are A5 work in **this**
repo, not upstream gaps:

1. **`feoh.import_csv` needs a raw-text request body.** `src/upstream/http.ts`
   unconditionally `JSON.stringify`s the body and sets
   `Content-Type: application/json`. Extend the transport with a text-body mode.
2. **`feoh.export_ledger` needs a text response.** The same transport assumes a
   JSON body and would raise `bad_response` on `text/plain`. Extend it with a
   text-response mode — and always send `format=ledger`, because the default
   (`csv`) returns different content with a 200.
3. **`calendar.list_upcoming` builds its own window** (`from = now`,
   `to = now + 90 days`, matching Heorth's `service.listUpcoming`). Write the
   90-day horizon down in the handler with a comment: it is a behavioural
   constant shared with upstream, and the two must not drift.

## What changed in this file (task A4)

Eleven of the 50 rows were wrong before verification:

- **9 wrong endpoints:** all 5 `calendar.*` tools (`/calendar` → `/events`),
  `household.get_members` (`/household` → `/members`), `household.whoami`
  (`/household/whoami` → `/auth/whoami`), `meals.list_recipes` and
  `meals.create_recipe` (`/meals` → `/recipes`).
- **2 wrong request forms:** `feoh.import_csv` (raw text body, not JSON) and
  `feoh.export_ledger` (requires `?format=ledger`; returns `text/plain`).

All 13 `kith.*` rows were correct. The remaining Heorth rows had correct paths
but unstated parameter names — now filled in from the validators, including the
snake_case/camelCase split.

## Open items before implementation

1. ~~Verify every REST mapping against the live route tables.~~ Done — this file,
   2026-08-18.
2. ~~`calendar.list_upcoming` needs `limit`/`memberId` support upstream.~~ Closed
   by Heorth `46666d7` (task A3); the query key is `member_id`.
3. **Input schemas.** Each tool's Zod input schema transfers verbatim from the
   source files; capture them as this repo's schemas so the upstream repos can
   delete theirs. Where the REST validator is *stricter* than the tool schema
   (e.g. `endAt >= startAt` on create-event), the upstream stays authoritative —
   do not weaken it, and do not duplicate it here.
4. **Transport extensions** for the two feoh text endpoints (see above).
5. ~~**`kith.*` and per-member access control** (ADR 0004) — a single service
   principal cannot express per-member visibility.~~ **Closed by task B11**
   (2026-08-19): `kith.*` calls now carry a per-caller member token exchanged at
   Heorth (ADR 0009), so read *and* write tools express the calling member.
   Three notes from the port:
   - The input schemas carry ADR 0004's `visibility` / `sharedWith` fields,
     because they are part of KithLedger's create/update validators and schemas
     transfer verbatim. Their defaults stay upstream (the `household` column
     default), and nothing here interprets them.
   - `kith.list_reminders`' `statuses` field is a Zod `.transform` that splits on
     commas, so the handler re-joins the array for the query string.
   - `kith.create_relationship` takes the raw shape without the `.refine()` the
     upstream schema wraps it in; the route enforces it, and duplicating a
     stricter upstream rule is exactly what "the upstream stays authoritative"
     forbids.
