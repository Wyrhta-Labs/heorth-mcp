# Spec — MCP tool surface

**Status:** draft · **Source:** the MCP code currently embedded in
`Wyrhta-Labs/Heorth` (`src/household/mcp.ts`, `src/modules/*/mcp.ts`) and
`Wyrhta-Labs/KithLedger` (`src/mcp/tools/*.ts`), as of 2026-08-18.

This is the contract heorth-mcp implements. Tool names are frozen: they are what
MCP clients call. The **REST** column is the upstream endpoint the handler
translates to — relative to `/api/v1` on the respective base URL.

## Heorth upstream (`HEORTH_BASE_URL`) — 37 tools

Auth: caller's `Bearer he_...`, passed through.

### household (2)

| Tool | REST | Description |
|---|---|---|
| `household.get_members` | `GET /household` | List every member of the household with their role and profile. |
| `household.whoami` | `GET /household/whoami` | Return the member identity behind the current API key. |

### calendar (5)

| Tool | REST | Description |
|---|---|---|
| `calendar.list_events` | `GET /calendar?from=&to=` | List calendar events expanded across a date range (from/to ISO timestamps). |
| `calendar.create_event` | `POST /calendar` | Create a calendar event, optionally recurring, with attendees. |
| `calendar.update_event` | `PATCH /calendar/:id` | Update fields of an existing event. |
| `calendar.move_event` | `POST /calendar/:id/move` | Reschedule an event to a new start (and optional end) time. |
| `calendar.list_upcoming` | `GET /calendar?from=now&limit=&memberId=` | List the next N upcoming event occurrences, optionally for one member. |

> `calendar.list_upcoming` has **no dedicated REST route** — it is expressed as a
> bounded `list_events` query. Confirm the upstream honours `limit` and
> `memberId`; if it does not, add them there rather than sorting/slicing here.

### meals (6)

| Tool | REST | Description |
|---|---|---|
| `meals.list_recipes` | `GET /meals?tag=` | List recipes, optionally filtered by tag. |
| `meals.create_recipe` | `POST /meals` | Create a recipe with ingredients, steps, and tags. |
| `meals.plan_meal` | `POST /meals/plan` | Assign a recipe or free-text meal to a date + slot (upserts). |
| `meals.get_week_plan` | `GET /meals/plan?from=&to=` | Return meal plan entries between two dates (YYYY-MM-DD). |
| `meals.generate_shopping_list` | `POST /meals/shopping-list/generate` | Generate (regenerate) the shopping list from planned recipes in a date range. |
| `meals.check_off_item` | `PATCH /meals/shopping-list/:id` | Mark a shopping list item as checked or unchecked. |

### library (5)

| Tool | REST | Description |
|---|---|---|
| `library.list_items` | `GET /library/items` | List library items across the household, filtered by media type, member, provider, status, or standard list (later/favorites). |
| `library.search` | `GET /library/items/search` | Full-text search library items by title or creator. |
| `library.get_item` | `GET /library/items/:id` | Get one library item by id, including owning member and source link. |
| `library.list_connections` | `GET /library/connections` | List connected library accounts and their sync status (never returns credentials). |
| `library.sync_connection` | `POST /library/connections/:id/sync` | Trigger a manual sync of one connected account. |

### inventory (4)

| Tool | REST | Description |
|---|---|---|
| `inventory.list_items` | `GET /inventory/items` | List household inventory items (filter by status/category/search). |
| `inventory.get_item` | `GET /inventory/items/:id` | Get one inventory item by id (lifecycle fields included). |
| `inventory.record_item` | `POST /inventory/items` | Create an inventory item (name required; purchase fields optional). |
| `inventory.decommission_item` | `POST /inventory/items/:id/decommission` | Decommission an item (date, reason; optional proceeds). Inventory fields only — link a sale transaction separately via `feoh.link_item_cost`. |

### tasks (3)

| Tool | REST | Description |
|---|---|---|
| `tasks.list` | `GET /tasks` | List household tasks mirrored from Microsoft To Do, with optional filters. |
| `tasks.create` | `POST /tasks` | Create a task in the shared household To Do list. |
| `tasks.complete` | `POST /tasks/:id/complete` | Complete or uncomplete a task (writes back to Microsoft To Do). |

### feoh (12)

| Tool | REST | Description |
|---|---|---|
| `feoh.list_envelopes` | `GET /feoh/envelopes` | List budget envelopes with their monthly budgets. |
| `feoh.record_transaction` | `POST /feoh/transactions` | Record a balanced double-entry transaction (postings must balance). |
| `feoh.get_month_summary` | `GET /feoh/summary?month=` | Return spend per envelope vs budget for a month (YYYY-MM). |
| `feoh.list_recurring_bills` | `GET /feoh/bills` | List recurring bills with cadence and next due date. |
| `feoh.import_csv` | `POST /feoh/import` | Import transactions from CSV text (date,payee,memo,amount,envelope,account). |
| `feoh.export_ledger` | `GET /feoh/export` | Export all transactions as a readable plaintext ledger. |
| `feoh.list_occurrences` | `GET /feoh/occurrences` | List recurring-bill occurrences (planned/paid/overdue/skipped) in a date window. The "what is overdue" tool. |
| `feoh.link_occurrence` | `POST /feoh/occurrences/link` | Mark an occurrence paid by linking the settling transaction. |
| `feoh.skip_occurrence` | `POST /feoh/occurrences/skip` | Skip one occurrence of a recurring bill. |
| `feoh.get_item_costs` | `GET /feoh/item-costs/:itemId` | Return the total-cost-of-ownership breakdown (capital, tier-2 costs, recurring, proceeds) for an inventory item. |
| `feoh.link_item_cost` | `POST /feoh/item-costs` | Link a transaction to an inventory item as a cost (purchase, disposal, repair, maintenance, accessory). |
| `feoh.account_ledger` | `GET /feoh/accounts/:id/ledger` | Return an account's ledger entries with a running balance, plus opening/end balance for the window (read-only). |

## KithLedger upstream (`KITH_BASE_URL`) — 13 tools

Auth: `kl_` **service key** (`KITH_API_KEY`), not the caller's identity —
see ADR 0002 Phase A and the asymmetry note in `CLAUDE.md`.

| Tool | REST | Description |
|---|---|---|
| `kith.list_people` | `GET /people` | List people, optionally filtered by search, tags, or birthday month. |
| `kith.get_person` | `GET /people/:id` | Get a single person by id. |
| `kith.create_person` | `POST /people` | Create a new person. |
| `kith.update_person` | `PATCH /people/:id` | Update an existing person. |
| `kith.get_person_graph` | `GET /people/:id/graph` | Get the relationship graph around a person. |
| `kith.list_interactions` | `GET /interactions` | List interactions, optionally filtered by person, type, or date range. |
| `kith.log_interaction` | `POST /interactions` | Log a new interaction with a person. |
| `kith.list_relationships` | `GET /relationships` | List relationships, optionally filtered by person or type. |
| `kith.create_relationship` | `POST /relationships` | Create a relationship between two people. |
| `kith.list_reminders` | `GET /reminders` | List reminders, optionally filtered by person, status, or due date. |
| `kith.create_reminder` | `POST /reminders` | Create a new reminder for a person. |
| `kith.complete_reminder` | `POST /reminders/:id/complete` | Mark a reminder as done, generating the next occurrence if recurring. |
| `kith.snooze_reminder` | `POST /reminders/:id/snooze` | Snooze a reminder until a later date. |

## Open items before implementation

1. **Verify every REST mapping above against the live route tables.** They were
   derived by reading route files; the exact query-parameter names for the list
   tools are not yet confirmed.
2. **`calendar.list_upcoming`** — needs `limit`/`memberId` support upstream, or
   its own endpoint. Do not compensate in heorth-mcp.
3. **Input schemas.** Each tool's Zod input schema transfers verbatim from the
   source files listed at the top; capture them as this repo's schemas so the
   upstream repos can delete theirs.
4. **`kith.*` and per-member access control** (ADR 0004) — a single service
   principal cannot express per-member visibility. Decide whether `kith.*`
   write tools ship before ADR 0002 Phase B or wait.
