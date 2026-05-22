---
date: 2026-05-21T00:00:00Z
researcher: Claude
git_commit: e988b0936017d969b2cbe406132697d6e5b059f6
branch: main
repository: desplega-ai/agent-swarm
topic: "Client-side end-user MCP (DES-444) — codebase grounding"
tags: [research, mcp, users, tokens, budget, identity]
status: complete
last_updated: 2026-05-22
last_updated_by: Claude
review_round: 1 (file-review, 2026-05-22 — 5 comments resolved; 7 plan decisions ironed out)
related:
  - thoughts/taras/brainstorms/2026-05-15-client-side-mcp.md
  - thoughts/taras/brainstorms/2026-05-18-humans-as-first-class-users.md
  - thoughts/taras/plans/2026-05-18-users-first-class-refactor/
  - thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md
---

# Client-side end-user MCP (DES-444) — codebase grounding

## Research Question

Ground the DES-444 client-side MCP plan against the live codebase, post-PR #500 ("Humans as
first-class users"). Four focus areas:

1. The **tool-fn refactor shape** — how `src/tools/*.ts` are structured and what a `(ctx, args) → result`
   handler + registry-binding split would actually entail.
2. How the **owner MCP route** is wired in `src/server.ts` + `src/http.ts`, so a second `/mcp/user`
   route can be added.
3. The existing **per-agent daily cost budget** infra, to wire `users.dailyBudgetUsd` enforcement.
4. Current state of `src/be/users.ts` token helpers and `src/http/users.ts` operator endpoints.

## Summary

PR #500 landed **the entire data layer** DES-444 depends on. The migration is done, the token DB
helpers are done and unit-tested, the `aswt_` scrubber rule is live, the People page exists. DES-444
is **purely additive** at the DB layer — zero new tables.

But three of the four focus areas surfaced scope that is **larger than the brainstorm assumed**:

- **Tool-fn refactor (Core Req #4):** The `(ctx, args) → result` split *does not exist today*. Tools
  are registered with business logic inlined in the registrar callback, and caller identity is read
  *inside each handler* from the `X-Agent-ID` header. There is no ctx object, no separate handler
  function, and `createServer()` builds the **full** tool set per session — there is no per-route
  tool-subset mechanism. This is a genuine refactor of every task tool, not a light rebinding.
- **`send-task` + `requestedByUserId`:** The MCP `send-task` tool **never sets `requestedByUserId`
  today**. Only integration handlers (Slack/GitHub/Linear/…) and `POST /api/tasks` do. The user-MCP
  variant must add this write path.
- **Budget enforcement (Core Req #10) is NOT a free wire-up.** The per-agent budget system shipped,
  but it is keyed strictly on `agentId` (`BudgetScope = ['global','agent']` — no `user` scope), and
  `session_costs` has **no `userId` column**. Enforcing `users.dailyBudgetUsd` requires a new `user`
  budget scope, a per-user daily-spend query (join `session_costs.taskId → agent_tasks.requestedByUserId`),
  and a new gate site. `users.dailyBudgetUsd` is a stored, operator-editable column today that
  **nothing reads for enforcement**.

What is genuinely done and reusable: `mintToken` / `revokeToken` / `resolveUserByToken` /
`listUserTokens` / `recordIdentityEvent` in `src/be/users.ts`; the `user_tokens` /
`user_identity_events` schema; the `aswt_` secret-scrubber rule; the operator-auth fingerprint
middleware; and the People-page detail view (which has **no Tokens tab** — omitted on purpose).

## Detailed Findings

### 1. Tool definition structure & the `(ctx, args) → result` refactor

**The registry helper.** Every tool file exports `registerXTool(server: McpServer)`, which calls
`createToolRegistrar(server)(name, config, callback)`.

- `createToolRegistrar` — `src/tools/utils.ts:129-179`. Curried; wraps `server.registerTool(...)`
  from `@modelcontextprotocol/sdk/server/mcp.js`. Branches on whether `inputSchema` is set
  (`utils.ts:140-158` no-input, `:160-177` with-input). Wraps every call in an OpenTelemetry span.
- `ToolConfig` — `src/tools/utils.ts:101-111`: `{ title?, description?, inputSchema?, outputSchema?,
  annotations?, _meta? }`. Schemas are **Zod** objects passed inline.

**Handler signature.** `ToolCallbackWithInfo` — `src/tools/utils.ts:92-99`:
```
(args: InferInput<InputSchema>, requestInfo: RequestInfo, meta: Meta) => CallToolResult | Promise<...>
```
- Handlers do **not** receive a db handle — they import db functions directly from `@/be/db` at
  module scope. The MCP server is in-process with the API server (`src/server.ts:155` `initDb`).
- `meta` is the raw MCP `RequestHandlerExtra` (gives `sendNotification`, `sessionId`, headers).

**How identity is obtained today.** `getRequestInfo(meta)` — `src/tools/utils.ts:26-49` — reads
`meta.requestInfo.headers["x-agent-id"]` and `["x-source-task-id"]`. `RequestInfo` (`utils.ts:20-24`)
= `{ sessionId, agentId, sourceTaskId }`, all `string | undefined`. Pure header extraction — **no
DB lookup, no API-key resolution, no user object**. Each handler null-checks `requestInfo.agentId`
itself and returns an error envelope telling the client to set the header.

**Coupling.** Handler logic is **tightly coupled** to registration glue — `registerXTool` inlines
`createToolRegistrar(server)(name, config, async (...) => { ...business logic... })`. There is no
separately-exported handler function. (Some *schemas* are exported for tests, e.g.
`resolveUserInputSchema` at `src/tools/resolve-user.ts:19`, but not handlers.)

**Implication for Core Req #4:** the brainstorm's `(ctx, args) → result` shape is greenfield. To
support a `UserCtx`, each task tool must be split so the business logic becomes a ctx-parameterised
function, and identity must move from "read `X-Agent-ID` inside the handler" to "passed in via ctx".

**Per-tool current behaviour** (the v1 user-MCP surface — `send-task`, `get-tasks`,
`get-task-details`, `cancel-task`, `task-action`):

| Tool | File | Scoping today |
|---|---|---|
| `send-task` | `src/tools/send-task.ts` | **Never sets `requestedByUserId`.** `createTaskExtended` calls at `:226-240`, `:276-291`, `:301-316` omit it. |
| `get-tasks` | `src/tools/get-tasks.ts:23-146` | No auto-scoping — returns *all* tasks. Agent-scope is opt-in: `mineOnly` → `agentId` filter (`:90`), `offeredToMe` → `offeredTo` filter (`:92`). No user filter exists. |
| `get-task-details` | `src/tools/get-task-details.ts:7-68` | **No permission check** — any caller can fetch any task (`getTaskById`, `:32`). It *resolves* `requestedByUserId` for a display-only `requestedBy: {name,email}` block (`:48-53`) but does not filter on it. |
| `cancel-task` | `src/tools/cancel-task.ts:14-113` | Permission by **agent**: `canCancel = callerAgent.isLead || existingTask.creatorAgentId === agentId` (`:69`). |
| `task-action` | `src/tools/task-action.ts:40-436` | Per-action **agent** scoping (`release` → `agentId===task.agentId` `:216`; `accept`/`reject` → `offeredTo===agentId`). Budget gate `canClaim(agentId,…)` at `:262`. |

`requestedByUserId` is a real column — `agent_tasks.requestedByUserId TEXT REFERENCES users(id)`,
added in `src/be/migrations/031_user_registry.sql:27-28`. `createTaskExtended` accepts it as an
option (`src/be/db.ts:2250`), inserts it (`:2350`/`:2390`), and **inherits it from the parent task**
when `parentTaskId` is set and no explicit value given (`:2319-2321`). Today only integration
handlers + `POST /api/tasks` (`src/http/tasks.ts:82`, `:317-354`) set it.

### 2. Owner MCP route & adding a second `/mcp/user` route

**Server/registry construction.** `createServer()` — `src/server.ts:152-343` — builds one
`McpServer` and registers every tool by calling each `registerXTool(server)` in sequence
(`:176-340`). Registration is gated by the **global `CAPABILITIES` env** (default
`core,task-pool,profiles,services,scheduling,memory,workflows,pages,kv` — `:138-139`) via
`hasCapability(cap)` (`:144-146`). Core tools (`join-swarm`, `poll-task`, `get-swarm`, `get-tasks`,
`send-task`, `get-task-details`, `store-progress`, `my-agent-info`, `cancel-task`) are always
registered (`:176-184`). `createServer()` is called **fresh per MCP session**.

**Route mounting.** `handleMcp` — `src/http/mcp.ts:7-77` — hardcoded to `req.url === "/mcp"`
(`:14-16`), placed last in the handler chain at `src/http.ts:205`. Transport is **Streamable HTTP**
(`StreamableHTTPServerTransport`, official `@modelcontextprotocol/sdk`). Sessions keyed by
`mcp-session-id` header in a `transports` map persisted via `globalThis.__transports`
(`src/http.ts:77-90`). New session → fresh `createServer()` + `server.connect(transport)`
(`mcp.ts:46-47`).

**Auth.** No MCP-specific auth in `handleMcp`. `handleCore` (`src/http/core.ts:195-435`) runs first
and does the **swarm-API-key bearer check** at `core.ts:241-253` for all non-public routes. `/mcp`
is not public, so a valid `Authorization: Bearer <apiKey>` is required to reach `handleMcp`.
`X-Agent-ID` is **not** validated at the transport layer — it is read per-tool-call inside
`getRequestInfo`.

> **Review note (f0796cbc) — "could the API-key-validation layer produce a caller ctx (owner vs
> user vs global), the same way we get the agent id?"** Yes, and it is *not* a large refactor of the
> auth layer itself. Today the bearer check (`core.ts:241-253`) is binary: `bearer === swarmApiKey`
> → pass/fail. A caller-ctx model would replace that with: inspect the bearer — if it equals the
> swarm key → `{ kind: 'owner' }`; if it is `aswt_…` → `resolveUserByToken()` → `{ kind: 'user',
> userId }`; else 401. That branch is ~20 lines and `resolveUserByToken` already exists. The cost is
> **not** in the auth branch — it is in **threading that ctx to the tool handlers**, which is
> exactly the tool-fn refactor (Finding 1 / Core Req #4). So the auth-ctx idea does not *add* work;
> rather it **subsumes the "two routes / two registries" design** — one `/mcp` route, one auth
> middleware that resolves a caller ctx, and each tool branches on `ctx.kind` (or is registered into
> a subset per kind). This is a genuine design alternative to the brainstorm's two-route model and
> is captured as a decision below (Open Question #6).

**`route()` vs raw mounting.** Two parallel systems. `route()` (`src/http/route-def.ts:85-143`) is
the REST factory (feeds OpenAPI + `isPublicRoute`). The MCP endpoint is **raw-mounted** — `handleMcp`
is a plain handler in the `src/http.ts` array, not in `routeRegistry`, not in the OpenAPI spec.

**Extension points for a second route** (described as-is — not a design):
1. A sibling of `handleMcp` with its own path string + its own transport map.
2. Added to the handler array in `src/http.ts:165-206` (first-match-wins; `handleMcp` already
   returns `false` for non-matching URLs so ordering is safe).
3. Its own transport map (session-ID keyspace is per-map); `shutdown()` (`http.ts:262-266`) iterates
   one map today.
4. `createServer()` is the *single* tool-set construction path — controlled only by global
   `CAPABILITIES`, with no per-endpoint subset parameter. A different tool subset needs a
   construction path other than the single `createServer()`.
5. Auth: `handleCore`'s bearer check (`core.ts:241-253`) applies the same swarm key uniformly to all
   non-public paths — there is no per-route key/scope concept today.

### 3. Per-agent daily cost budget infra & `users.dailyBudgetUsd`

**Headline:** the per-agent budget feature **shipped** (migration `046_budgets_and_pricing.sql`,
built as Phases 1-6). The `users.dailyBudgetUsd` column (migration 067) is a **separate, later,
unenforced** column.

**Schema** — `src/be/migrations/046_budgets_and_pricing.sql`:
- `budgets` (`:30-39`): PK `(scope, scope_id)`, `daily_budget_usd REAL`, `CHECK (scope IN
  ('global','agent'))`. Global = `scope_id = ''`. **No `user` scope.**
- `pricing` (`:41-52`): append-only price book.
- `budget_refusal_notifications` (`:57-70`): per-`(task_id, date)` dedup.
- No budget column on `agents` or `agent_tasks` — per-agent budgets are `budgets` rows.

**Admission predicate** — `canClaim(agentId, nowUtc)` in `src/be/budget-admission.ts:68`. Pure, no
mutation. Order: kill-switch `BUDGET_ADMISSION_DISABLED` → global gate → per-agent gate. Refusal
returns a cause (`global` | `agent`).

**Daily-spend computation** — `src/be/db.ts`:
- `getDailySpendForAgent(agentId, dateUtc)` (`:9464`): `SUM(totalCostUsd) FROM session_costs WHERE
  agentId = ? AND substr(createdAt,1,10) = ?`.
- `getDailySpendGlobal(dateUtc)` (`:9485`): same without the agent filter.
- `session_costs` (`src/be/migrations/001_initial.sql:179-196`) has `agentId`, `taskId`,
  `totalCostUsd`, `createdAt` — **no `userId` column.**

**Enforcement gate sites** (all server-side, claim-time refusal — *nothing is killed*):
- `src/http/poll.ts` `handlePoll` — `canClaim` at `:183` (pre-assigned) and `:306` (pool).
- `src/tools/task-action.ts` — `canClaim` at `:262` (the `accept` action).
- `poll-task` tool is explicitly **not** gated (`src/tools/poll-task.ts:70-76`).
- Refused task stays `pending`; a `budget_refused` trigger envelope goes back to the worker, which
  backs off exponentially (`src/commands/runner.ts:3912-3930`, `src/utils/budget-backoff.ts`).
- Lead is notified once per `(task_id, day)` via `emitBudgetRefusalSideEffects`
  (`src/be/budget-refusal-notify.ts`).

**Keys off the AGENT, not the user.** `canClaim` takes only `agentId`. `BudgetScope` enum
(`src/types.ts:1537`) = `["global","agent"]`. `agent_tasks.requestedByUserId` *is* resolved in
`src/http/poll.ts:247-249` — but only to enrich the `task_assigned` trigger payload, never fed to
`canClaim`.

**`users.dailyBudgetUsd` is unenforced.** Added `src/be/migrations/067_users_first_class.sql:55`.
Full CRUD plumbing exists — `UserSchema.dailyBudgetUsd` (`types.ts:233`), create/update in
`src/be/db.ts` + `src/http/users.ts` (emits `budget_changed`), MCP `manage-user` tool. But a
repo-wide search confirms **no code reads `users.dailyBudgetUsd` for enforcement** — every reference
is schema/row-mapping/CRUD-write.

**Therefore Core Req #10 requires:** a `user` budget scope (or parallel mechanism), a per-user
daily-spend query (needs `session_costs.taskId → agent_tasks.requestedByUserId` join, or a new
`session_costs.userId` column), and a new gate site. The brainstorm's "reuse per-agent infra — get
it for free" is optimistic.

### 4. `src/be/users.ts` token helpers & `src/http/users.ts` — confirmed state

**`src/be/users.ts` — all token helpers exist and are unit-tested:**
- `mintToken(userId, label, actor): { tokenId, plaintext }` (`:431-453`) — generates
  `aswt_` + 24 base62 chars (~143 bits), sha256 hash, `tokenPreview` = last 4 chars; INSERTs
  `user_tokens`; emits `token_minted`. Plaintext returned **once**.
- `revokeToken(tokenId, actor): void` (`:459-482`) — sets `revokedAt = now`; emits `token_revoked`;
  **throws** `Token not found` if absent.
- `resolveUserByToken(plaintext): User | null` (`:490-514`) — sha256 lookup; returns `null` if no
  row or `revokedAt` set; fire-and-forget `lastUsedAt` update; emits **no** event.
- `listUserTokens(userId): UserTokenSummary[]` (`:245-254`) — never exposes `tokenHash`.
- `recordIdentityEvent` (`:266-298`), `findOrCreateUserByEmail` (`:314-353`), `linkIdentity` /
  `unlinkIdentity` (`:366-401`), `findUserByExternalId` / `findUserByEmail` / `getUserIdentities`.
- `fingerprintApiKey(rawKey): string` (`:529-531`) → `op:<sha256(rawKey)[:16]>`.
- `IdentityActor` = `{ kind: "system" | "operator" | "user"; id: string }` (`:36-39`).

**`src/http/users.ts` — token endpoints ABSENT.** All endpoints use `route()` with
`auth: { apiKey: true }`. Present: `GET/POST /api/users`, `GET /api/users/unmapped`, the unmapped
`resolve` POST, `GET /api/users/{id}/events`, `POST /api/users/{id}/identities`, `DELETE
.../identities/{kind}/{externalId}`, `POST /api/users/{id}/merge`, `GET /api/users/{id}`,
`PATCH /api/users/{id}`. **`POST /users/:id/mcp-tokens` and `DELETE /users/:id/mcp-tokens/:tokenId`
do not exist** — the file header explicitly defers them. `mintToken`/`revokeToken` are *not even
imported* in `src/http/users.ts`.

**Operator-auth middleware** — `getOperatorActor(req, res)` in `src/http/operator-actor.ts:42-59`.
Extracts bearer, compares to `getApiKey()`, returns `{ kind:"operator", id: fingerprintApiKey(rawKey) }`
or writes 401 + returns `null`. Called by every mutation handler in `src/http/users.ts`.

**Schema confirmed** (migrations 067 + 068; note file headers say `064`/`065` — a comment mismatch):
`user_tokens(id, userId FK CASCADE, label, tokenHash UNIQUE, tokenPreview NOT NULL, createdAt,
lastUsedAt, revokedAt)`; `user_identity_events` (11-value `eventType` CHECK after 068 adds
`profile_changed`); `users.metadata TEXT`, `users.dailyBudgetUsd REAL`, `users.status` (CHECK
`invited|active|suspended`).

**`src/types.ts`** — `UserSchema` (`:221-238`), `IdentityEventTypeSchema` (11-value enum,
`:247-259`), kept in lockstep with the migration CHECK.

**UI — People page at `ui/src/pages/people/`.** `page.tsx` (list, people/unmapped tabs),
`[id]/page.tsx` (`PersonDetailPage` — tabs: **Profile / Identities / Events only**, `:612-619`).
**No Tokens tab, no mint/revoke dialog, no token mutation hook** (`use-users.ts` has none).
DES-444 adds a **new "Tokens" tab** to `[id]/page.tsx` (operator confirmed) — the mint dialog +
token-list panel live there. The wire
type `UserToken` exists (`ui/src/api/types.ts:276-284`) and `composeUser` already returns a
`tokens[]` array, but nothing renders it. Budget field copy already reads *"Soft cap, enforced once
MCP user-tokens ship"* (`[id]/page.tsx:398`).

## Code References

- `src/tools/utils.ts:26-49,92-99,101-111,129-179` — `getRequestInfo`, `ToolCallbackWithInfo`, `createToolRegistrar`
- `src/tools/send-task.ts`, `get-tasks.ts`, `get-task-details.ts`, `cancel-task.ts`, `task-action.ts` — v1 user-MCP tool surface
- `src/server.ts:138-146,152-343` — `createServer`, capability gating
- `src/http.ts:77-90,165-206,262-266` — handler chain, `transports` map, shutdown
- `src/http/mcp.ts:7-77` — the `/mcp` Streamable-HTTP handler
- `src/http/core.ts:241-253` — swarm-API-key bearer auth
- `src/http/route-def.ts:70-81,85-143` — `route()` factory, `isPublicRoute`
- `src/be/db.ts:2250,2319-2321,2350,2390` — `createTaskExtended` + `requestedByUserId` inheritance
- `src/be/budget-admission.ts:68` — `canClaim`
- `src/be/db.ts:9464,9485` — `getDailySpendForAgent` / `getDailySpendGlobal`
- `src/be/migrations/046_budgets_and_pricing.sql` — budgets/pricing/refusals schema
- `src/be/migrations/067_users_first_class.sql`, `068_profile_changed_event_type.sql` — users/tokens/events schema
- `src/be/users.ts:36-39,245-254,266-298,431-453,459-482,490-514,529-531` — `IdentityActor`, token + event helpers
- `src/http/users.ts` — operator endpoints (token endpoints absent)
- `src/http/operator-actor.ts:42-59` — `getOperatorActor`
- `src/types.ts:206,221-260,1537` — `requestedByUserId`, `UserSchema`, `IdentityEventTypeSchema`, `BudgetScopeSchema`
- `ui/src/pages/people/page.tsx`, `ui/src/pages/people/[id]/page.tsx`, `ui/src/api/types.ts:276-284` — People page (no token UI)

## What the brainstorms / refactor plan say (historical context)

**Done & merged by PR #500 (DES-444 starts from this baseline):** the co-landed migration
(`user_tokens`, `user_identity_events`, `users.dailyBudgetUsd/status/metadata`); `src/be/users.ts`
helpers incl. `mintToken`/`revokeToken`/`resolveUserByToken`; the `aswt_[A-Za-z0-9]{20,}` →
`[REDACTED-MCP-TOKEN]` scrubber rule; the People page.

**Explicitly deferred to "the MCP plan" (i.e. DES-444):**
- `root.md` "What We're NOT Doing": *token-mint UI dialog + `POST/DELETE /users/:id/mcp-tokens`
  endpoints*; *token-bearer middleware on `/mcp/user`*; *end-user auth (OAuth/magic-link)*.
- `step-1.md`: `POST /users/:id/mcp-tokens` endpoint deferred (helper `mintToken` ready to wire).
- `step-8.md`: full `/api/users` surface built "except `POST/DELETE /users/:id/mcp-tokens`".
- `step-9.md`: *"No token-mint dialog … Recommend omission"* — so the People detail view has **no
  Tokens section at all today**; DES-444 adds it fresh.

**MCP-relevant decisions from the humans brainstorm:**
- Endpoint path is **`/mcp/user`** (the only path-name signal in the docs).
- Token-mint dialog: the brainstorm specced **three** client snippets (Claude Desktop JSON, Claude
  Code CLI `claude mcp add` / `~/.claude.json`, generic `curl`), Cursor excluded.
  **Operator review (e6902175): ship the full common set, not just three** — see the dedicated
  "Client config snippets" research section below for the surveyed standard set and recommended
  shortlist. The UI sub-component stays data-driven so clients are config, not code.
- `tokenPreview` = last-4-char **suffix**; display `aswt_…<last4>`; plaintext shown once at mint.
- Actor model (for `user_identity_events.actor`): `system` / `op:<sha256(API_KEY)[:16]>` /
  `<users.id>`. No `user`-kind actor is emitted by any code path yet.
  **Clarification (87ddbce0):** this is narrowly about the *identity-event audit log* — it does
  **not** mean we can't attribute work to a user. **Task attribution already works** via
  `agent_tasks.requestedByUserId` (a real column, resolved e.g. at `src/http/poll.ts:247-249`). The
  `user`-kind `IdentityActor` gap only matters for *self-service identity mutations* (e.g. a user
  minting their own token over `/mcp/user`). For DES-444 v1 the operator mints tokens, so every
  token event is `operator`-kind; the `user`-kind actor is only needed if/when self-service lands.
- Budget UI already shipped honestly labelled *"enforced once MCP user-tokens ship"* — DES-444 owns
  the enforcement wiring; operators may already be setting values it must start respecting.

## Client config snippets (web research, per comment e6902175)

Survey of how hosted-MCP providers (Linear, Sentry, GitHub, Notion, Stripe, Atlassian, Supabase,
Cloudflare) present "connect your client" onboarding. **Decision: ship the common set, not three.**

**The market has converged on a Tier-1 set:** Claude Code, Claude Desktop, Cursor, VS Code (Copilot)
— every surveyed provider ships snippets for these. Windsurf/Zed are Tier-2 (almost always via the
`mcp-remote` bridge). Goose/Cline/JetBrains are long-tail.

**Snippets are cheap to ship — they're one template rendered N ways.** For a remote streamable-HTTP
server with bearer auth, every Tier-1 native config is the *same JSON object*; only two things vary:
the root key (`mcpServers` vs `servers`) and the `type` field. So "ship the common ones" is one
template, not N integrations.

**v1 recommended bundle — 5 copy-paste entries + 2 deep-link buttons, all from one template:**

| # | Client | Form | Notes for the plan |
|---|---|---|---|
| 1 | Claude Code CLI | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` | Native HTTP + headers. (Already specced.) |
| 2 | Cursor | `mcpServers` JSON, `url` + `headers`, supports `${env:VAR}` | Native remote + headers. |
| 3 | VS Code / Copilot | `servers` JSON, **`type: "http"`** + `headers`, `${input:…}` secrets | Gotcha: root key is `servers` not `mcpServers`, and `type` is required. |
| 4 | Claude Desktop | **`mcp-remote` bridge** (`npx -y mcp-remote <url> --header …`) | **Caveat:** Claude Desktop's native remote-connector flow expects OAuth. A bearer-only server is second-class — a plain `mcpServers` URL entry will *not* carry the header. Ship the bridge form and label it. |
| 5 | Generic `mcp-remote` | `npx -y mcp-remote <url> --header "Authorization: Bearer …"` | One entry covering Windsurf, Zed, Cline, Goose, JetBrains. **Zed cannot do native bearer headers at all** — the bridge is the only path. |
| + | curl | `curl -H "Authorization: Bearer …" -H "Accept: application/json, text/event-stream" …` | Debugging. (Already specced.) |

**Worth the small effort:** generate Cursor (`cursor://anysphere.cursor-deeplink/mcp/install?…`) and
VS Code (`vscode://mcp/install?…`) **one-click deep-link buttons** from the same config object
(Base64/URL-encode) — biggest UX win, ~20 lines.

**Do NOT hand-write** separate Windsurf/Zed/Goose/Cline snippets — the `mcp-remote` bridge covers
the whole long tail. Keep the dialog's snippet sub-component **data-driven** so new clients are
config, not code.

> Caveat from the researcher: WebFetch was blocked in that run, so the exact per-client config
> syntax was synthesized from search-result summaries of official docs — **spot-check the syntax
> against the linked docs at plan time**, especially the Claude Desktop remote-bearer behaviour.
> Sources: Linear/Sentry/GitHub/Notion/Stripe/Atlassian/Supabase/Cloudflare MCP docs, VS Code &
> Cursor MCP config references, `mcpbundles.com` "state of MCP clients (May 2026)".

## Open Questions / Decisions for the Plan

These are factual gaps a plan author must resolve. Resolutions agreed with Taras (2026-05-22) are
recorded inline as **→ Decision:**.

1. **Tool-fn refactor blast radius.** Splitting the 5 task tools into ctx-parameterised handlers
   touches `getRequestInfo`-based identity in each. The plan must decide the `ctx` shape that
   unifies `OwnerCtx` (agent-id-based) and `UserCtx` (user-id-based), and whether non-task tools are
   left untouched.
   **→ Decision:** the 5 task tools split into pure `(ctx, args) → result` handlers reused by both
   registries; non-task tools stay owner-only and untouched.
2. **Second-registry construction.** `createServer()` has no tool-subset parameter. The plan must
   decide whether to parameterise `createServer()`, add a second builder, or filter post-registration.
   **→ Decision:** the `/mcp-user` route gets its own registry (see #6). The plan picks the exact
   construction mechanism, but the user registry registers *only* the 5 task tools.
3. **Budget enforcement mechanism.**
   **→ Decision: add a `user` budget scope.** Extend `BudgetScopeSchema` + the `budgets` table
   `CHECK` + `canClaim` with a `user` scope; resolve `task.requestedByUserId` at claim time and sum
   per-user daily spend via a `session_costs.taskId → agent_tasks.requestedByUserId` join (no new
   `session_costs.userId` column). Reuses the existing claim-time refusal + backoff machinery.
   `users.dailyBudgetUsd` becomes the source value for the `user`-scope `budgets` row (the plan
   decides whether it is mirrored into `budgets` or read directly).
4. **`send-task` requestedByUserId write.** The user-MCP `send-task` must set
   `requestedByUserId = ctx.userId`; today the MCP tool sets nothing.
5. **Ownership-gating return code.**
   **→ Decision: return 403** (explicit "not yours") for non-owned tasks on
   `get-task-details`/`cancel-task`/`task-action` — *not* 404. **RBAC note:** leave a comment that a
   future admin/role tier may be allowed to see all tasks, so the ownership check should be a
   single chokepoint that an RBAC predicate can later widen. Today `get-task-details` has *no*
   check at all — DES-444 adds one.
6. **Route & auth topology.**
   **→ Decision: two routes, two registries.** The end-user route is **`/mcp-user`** (note: a
   sibling path, *not* `/mcp/user` — the brainstorm's `/mcp/user` is superseded). Owner `/mcp`
   untouched. `/mcp-user` is declared public so it bypasses `handleCore`'s swarm-key check, and runs
   its own `aswt_`-token middleware that calls `resolveUserByToken`. It needs its own transport map
   and a `shutdown()` entry. (The caller-ctx single-route alternative from f0796cbc was considered
   and not chosen — two routes give cleaner isolation.)
7. **`users.status = 'invited'`.**
   **→ Decision: not used in v1.** The operator creates the user as `active` and mints a token
   immediately. `invited` stays dormant until self-serve onboarding (v1.5).
