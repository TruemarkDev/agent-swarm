---
date: 2026-05-27T00:00:00+02:00
planner: Claude
git_commit: 5d34deaf8eb6872ea450f461007ab6cc8b7a5e02
branch: main
repository: agent-swarm
topic: "Agent reasoning/effort runtime control implementation plan"
tags: [plan, runtime-settings, harness-providers, ui, reasoning-effort]
status: draft
autonomy: critical
commit_per_phase: true
last_updated: 2026-05-27
last_updated_by: Claude
---

# Agent Reasoning/Effort Runtime Control Implementation Plan

## Overview

Add per-agent reasoning/effort runtime control to the four local harnesses (`claude`, `codex`, `pi`, `opencode`) so users can pin an agent's reasoning intensity from the dashboard, persist it like the existing `MODEL_OVERRIDE`, and translate one normalized level into the harness-specific knob each tool actually accepts.

- **Motivation**: Each harness already exposes a reasoning knob (`/effort` for Claude, `model_reasoning_effort` for Codex, `thinkingLevel` for Pi, provider-gated options for Opencode), but there is no agent-swarm-side surface to set, persist, or display it. Users want to dial up reasoning per agent without editing config files on workers.
- **Related**: `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`, `src/http/agents.ts:82` (runtime route), `src/providers/types.ts:80` (`ProviderSessionConfig`), `ui/src/components/shared/agent-runtime-settings.tsx:44` (runtime editor).

## Current State Analysis

- Runtime contract is model-only: `PATCH /api/agents/{id}/runtime` accepts `harness_provider`, `model`, `allow_custom_model` (`src/http/agents.ts:93-97`). No reasoning field anywhere in the request body, `ProviderSessionConfig` (`src/providers/types.ts:81`), or `AgentLatestModelSchema` (`src/types.ts:503-510`).
- The current runtime route requires a non-empty `model` string and always upserts — there is no way to clear `MODEL_OVERRIDE` via the API today. This is a latent gap we extend the fix for (see Phase 2 §5).
- Each adapter wires `model` into the harness-specific shape but never sees a reasoning value:
  - Claude — `--model` on `Bun.spawn` (`src/providers/claude-adapter.ts:756`).
  - Codex — SDK thread options (`src/providers/codex-adapter.ts:1205`); `show_raw_agent_reasoning: false` pinned at `src/providers/codex-adapter.ts:353`.
  - Pi — `createAgentSession` options (`src/providers/pi-mono-adapter.ts:712`).
  - Opencode — per-task `opencode.json` `model` field (`src/providers/opencode-adapter.ts:590`).
- Runner resolves model precedence (task → `MODEL_OVERRIDE` → empty) at `src/commands/runner.ts:2158` and reports latest model via `buildLatestModelReport()` (`src/commands/provider-credentials.ts:471`) — no reasoning counterpart.
- UI runtime editor (`ui/src/components/shared/agent-runtime-settings.tsx:44`) handles harness + model only; `ModelOption` in `ui/src/lib/agent-runtime-models.ts:27` ignores the `reasoning` field that already exists in `ui/src/lib/modelsdev-cache.json:12`.
- Cost telemetry already exposes `reasoningOutputTokens` / `thinkingTokens` (`src/providers/types.ts:10`, `src/types.ts:705`) — orthogonal to the requested level and reused as-is.

## Desired End State

- `PATCH /api/agents/{id}/runtime` accepts `reasoning_effort` ∈ `{ off, low, medium, high, xhigh }`. Server validates `(model, level)` against a capability table and 400s known-bad combos (e.g. `xhigh` on `gpt-5.1-codex`).
- Resolved on the worker: task → agent `swarm_config[REASONING_EFFORT_OVERRIDE]` → unset (each adapter honors its harness's native default; no fleet-wide override).
- All four adapters translate the normalized level into harness-specific shape (env var / SDK config / session option / per-task JSON).
- `agents.cred_status.latestModel.reasoningEffort` echoes the level the adapter actually applied; the UI shows configured + last-used side by side.
- UI runtime editor renders an effort segmented control next to the model picker; levels the chosen model doesn't support are greyed out with a tooltip.
- Docs (`runbooks/harness-providers.md`, `docs-site/.../guides/harness-providers.mdx`) and `openapi.json` reflect the new field.

**How to verify**: spin up the API + UI locally, pick each harness in turn, set effort to `high` in the editor, dispatch a task, and confirm in the worker logs that the adapter forwarded the correct knob (Claude env, Codex config, Pi option, Opencode JSON). For `xhigh` on `gpt-5.1-codex` (non-max), the UI should grey out and the API should 400.

## What We're NOT Doing

- **`minimal` and `max`** levels — `minimal` is rejected by Codex `*-codex` models and `max` has known persistence bugs on Claude (anthropics/claude-code#30726). Skip for v1; add later if requested.
- **Numeric budget knobs** (`MAX_THINKING_TOKENS`, Anthropic `budget_tokens`, OpenRouter `max_tokens`) — keep the qualitative-level surface only. Power users can still inject env via `additionalArgs` if needed.
- **Per-task reasoning overrides** — task body stays unchanged; effort is per-agent (mirrors how `MODEL_OVERRIDE` works today).
- **`allow_custom_effort` opt-in flag** — the closed enum is safe to expose without per-agent opt-in.
- **Devin / claude-managed harnesses** — out of scope (research focused on the four local harnesses).
- **`show_raw_agent_reasoning`, `model_reasoning_summary`, `model_verbosity`** — separate Codex knobs not in this feature's surface.

## Implementation Approach

- Single normalized `ReasoningEffort` type and one helper module (`src/providers/reasoning-effort.ts`) own both capability lookup and per-harness translation — adapters consume a discriminated union and merge ~3 lines each.
- Capability data: lift `reasoning` from `ui/src/lib/modelsdev-cache.json` (referenced on the server via a small loader) plus a static rule table for harness-level edges (`*-codex` rejects `minimal`, Opus 4.7 has no off, etc.).
- Persistence reuses the existing `swarm_config` pattern — new key `REASONING_EFFORT_OVERRIDE` upserted in the same transaction as `MODEL_OVERRIDE`; no schema migration needed.
- Telemetry reuses `agents.cred_status` JSON column — `AgentLatestModelSchema` gets an optional `reasoningEffort` field; no migration.
- UI duplicates a small capability lookup client-side (same trade-off we already accept for the harness/model registry); promote to a server endpoint later if it bites.
- Sequencing: helper first → API contract → runner plumbing → adapters → UI → docs. Each phase is independently verifiable and produces a working slice.

## Quick Verification Reference

- Backend tests: `bun test src/tests/agents-harness-provider.test.ts src/tests/credential-status-api.test.ts src/tests/model-control.test.ts`
- Adapter tests: `bun test src/tests/claude-adapter.test.ts src/tests/codex-adapter.test.ts src/tests/pi-mono-adapter.test.ts src/tests/opencode-adapter.test.ts`
- Helper tests (new): `bun test src/tests/reasoning-effort.test.ts`
- Lint + types: `bun run lint && bun run tsc:check`
- DB boundary: `bash scripts/check-db-boundary.sh`
- OpenAPI drift: `bun run docs:openapi` (commit regenerated `openapi.json` + `docs-site/content/docs/api-reference/**`)
- UI: `cd ui && pnpm lint && pnpm exec tsc -b`

---

## Phase 1: Reasoning-effort helper module

### Overview

Create `src/providers/reasoning-effort.ts` exposing a normalized `ReasoningEffort` type, a per-(harness, model) capability lookup, and a translator that returns a discriminated union telling each adapter where to write what. No behavior changes elsewhere — pure module + unit tests.

### Changes Required:

#### 1. Normalized type + capability + translator

**File**: `src/providers/reasoning-effort.ts` (new)
**Changes**:
- Export `REASONING_EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const` and `ReasoningEffort` type.
- Export `reasoningCapability(harness, model): { supported, levels, default }`. Derives `levels` from `modelsdev-cache.json` `reasoning` field plus a small static rule table for harness-level edges.
- Export `applyReasoningEffort(harness, model, level)` returning a discriminated union: `claude-env { env }`, `codex-config { config }`, `pi-session { sessionOptions }`, `opencode-options { providerId, modelId, options }`, or `noop`.
- Per-harness mapping documented inline (Claude `off` → `MAX_THINKING_TOKENS=0` env + unset effort; Codex `off` → `model_reasoning_effort: 'none'`; Pi `off` → `thinkingLevel: 'off'`; Opencode `off` → omit reasoning keys).

#### 2. Capability data + harness rules

**Files**: `src/providers/reasoning-effort.ts` + `src/providers/modelsdev-reasoning.json` (new slim snapshot) + `scripts/refresh-modelsdev-pricing.ts` (extend)
**Changes**:
- Static rule table encoding: Codex `*-codex` (non-`max`) → no `minimal`, no `xhigh`; `gpt-5.1-codex-max` adds `xhigh`; Claude Opus 4.7 → no `off` semantics (excluded from `levels`); Pi/Opencode follow underlying provider rules.
- New `src/providers/modelsdev-reasoning.json` — slim subset of `ui/src/lib/modelsdev-cache.json` containing only `{ id, reasoning }` per model. Avoids the cross-boundary import of a UI asset from `src/providers/` (no other server module reaches into `ui/`).
- Extend `scripts/refresh-modelsdev-pricing.ts` to write both `ui/src/lib/modelsdev-cache.json` and `src/providers/modelsdev-reasoning.json` from the same fetched data. Commit both snapshots together; CI drift check covers both.
- Helper loads `modelsdev-reasoning.json` lazily at module load (no DB import — runs on workers too).

#### 3. Unit tests

**File**: `src/tests/reasoning-effort.test.ts` (new)
**Changes**:
- Capability table assertions per harness × representative model.
- `applyReasoningEffort` shape assertions per harness for each level, including `off` and `xhigh` gating.
- `applyReasoningEffort` returns `noop` when `level` is `undefined`, OR when the `(harness, model)` pair has no capability data (custom-model strings, legacy stored configs predating the API validation in Phase 2). This is defense-in-depth — primary rejection lives at the API layer.
- `reasoningCapability` returns `{ supported: false, levels: [], default: null }` for unsupported pairs (used by Phase 2 for 400 responses).

### Success Criteria:

#### Automated Verification:
- [ ] Helper tests pass: `bun test src/tests/reasoning-effort.test.ts`
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] DB boundary unchanged: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Helper-only smoke script (one-off `bun run`) prints output for representative tuples: `(claude, claude-opus-4-7, high)`, `(codex, gpt-5.1-codex-max, xhigh)`, `(codex, gpt-5.1-codex, xhigh)`, `(pi, openrouter/google/gemini-3-flash-preview, medium)`, `(opencode, openrouter/qwen/qwen3-coder-flash, low)`. Confirm: shapes match the discriminated union; for the Codex `xhigh`-on-non-max case `applyReasoningEffort` returns `noop` AND `reasoningCapability` excludes `xhigh` from `levels` (so Phase 2 will 400 it at API time).

#### Manual Verification:
- [ ] Skim the rule table for accuracy against the research doc's per-harness sections.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] add reasoning-effort helper module`.

---

## Phase 2: API contract + storage

### Overview

Extend `PATCH /api/agents/{id}/runtime` to accept `reasoning_effort`, validate against `reasoningCapability()`, and upsert the agent-scoped `swarm_config` row `REASONING_EFFORT_OVERRIDE` alongside `MODEL_OVERRIDE`. Add `reasoningEffort` to `AgentLatestModelSchema`. Regenerate OpenAPI.

### Changes Required:

#### 1. Request schema + handler

**File**: `src/http/agents.ts`
**Changes**:
- Add `reasoning_effort: ReasoningEffortSchema.nullable().optional()` to the runtime body at `src/http/agents.ts:93-97` (sibling of `model`). `null` = clear; omitted = leave unchanged; non-null = set.
- Relax the existing `model` field in the same schema from `z.string().trim().min(1)` to `z.string().trim().min(1).nullable().optional()` so `model: null` clears `MODEL_OVERRIDE` symmetrically (closes the latent gap noted in Current State Analysis).
- In the handler (`src/http/agents.ts:510`), when `reasoning_effort` is a non-null string, call `reasoningCapability(harness, model)`; if the requested level isn't in `levels`, return 400 with `{ error, harness, model, level, allowed }`.
- On success with non-null value: upsert `swarm_config` row with key `REASONING_EFFORT_OVERRIDE`, scope `agent`, scopeId `agentId`. Same transaction as `HARNESS_PROVIDER` + `MODEL_OVERRIDE`.
- On `reasoning_effort: null` (or `model: null`): call the new `deleteSwarmConfigByKey` helper (see §5).
- **Note**: Until Phase 3 ships, a PATCH'd `REASONING_EFFORT_OVERRIDE` is a silent no-op on the worker side (runner doesn't read it yet). Acceptable given the contract-first phasing — call it out in the Phase 2 commit message.

#### 2. Latest-model schema extension

**File**: `src/types.ts`
**Changes**:
- Extend `AgentLatestModelSchema` at `src/types.ts:503-510` with optional `reasoningEffort: ReasoningEffortSchema.optional()`.
- Add `ReasoningEffortSchema` (Zod enum mirroring the helper constant) exported from this module.
- Extend `PUT /api/agents/{id}/credential-status` body to accept `reasoning_effort` inside `latest_model` (`src/http/agents.ts:216`); merge into `cred_status` without clobbering at `src/http/agents.ts:592`.

#### 3. Route tests

**File**: `src/tests/agents-harness-provider.test.ts`
**Changes**:
- Happy path: PATCH with `reasoning_effort: 'high'` for a supported (harness, model) — assert 200, `swarm_config` row present, response echoes value.
- Validation failure: PATCH `xhigh` on `gpt-5-codex` (non-max) — assert 400 with `allowed` array.
- Clearing: PATCH with `reasoning_effort: null` — assert `swarm_config` row removed.
- Symmetric `MODEL_OVERRIDE` clearing: PATCH with `model: null` — assert `MODEL_OVERRIDE` row removed (regression coverage for the scope-expanded fix).
- Credential-status echo: PUT `latest_model.reasoning_effort` — assert merged into `cred_status`.

#### 4. OpenAPI regeneration

**File**: `openapi.json` + `docs-site/content/docs/api-reference/agents.mdx`
**Changes**: Run `bun run docs:openapi` and commit regenerated files.

#### 5. New `deleteSwarmConfigByKey` helper

**File**: `src/be/db.ts`
**Changes**:
- Add `deleteSwarmConfigByKey(scope: ConfigScope, scopeId: string, key: string): void` near `upsertSwarmConfig()` (around `src/be/db.ts:5329`). The existing `deleteSwarmConfig(id)` takes a row id, which the runtime handler doesn't have — this is the gap.
- Used by the runtime handler for both `model: null` and `reasoning_effort: null`. The fix scope-expands to cover `MODEL_OVERRIDE` clearing, which was previously impossible via the API.
- Unit-test the helper directly in `src/tests/agents-harness-provider.test.ts` (no-op on missing row, removes existing row).

### Success Criteria:

#### Automated Verification:
- [ ] Route tests pass: `bun test src/tests/agents-harness-provider.test.ts src/tests/credential-status-api.test.ts`
- [ ] Type check + lint: `bun run tsc:check && bun run lint`
- [ ] OpenAPI is up to date (no diff after regen): `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`

#### Automated QA:
- [ ] Curl walkthrough script: `PATCH /api/agents/{id}/runtime` with each level (off/low/medium/high/xhigh) against a Claude agent → assert 200 and `GET /api/config/resolved?agentId=...` includes `REASONING_EFFORT_OVERRIDE` row with expected value. Repeat one negative case (`xhigh` on non-`max` Codex) → expect 400.

#### Manual Verification:
- [ ] Review the validation 400 error shape (field names, error message) — confirm the UI can render it cleanly.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] runtime API accepts reasoning_effort`.

---

## Phase 3: Runner resolution + ProviderSessionConfig wiring

### Overview

Plumb `reasoningEffort` through `ProviderSessionConfig`, the runner's config resolution path, and the latest-model telemetry report — without touching adapter behavior yet. After this phase the wire carries the value end-to-end; adapters can read but they still ignore it.

### Changes Required:

#### 1. ProviderSessionConfig

**File**: `src/providers/types.ts`
**Changes**: Add `reasoningEffort?: ReasoningEffort` to `ProviderSessionConfig` at line 81.

#### 2. Runner resolution + live reconciliation

**File**: `src/commands/runner.ts`
**Changes**:
- After `MODEL_OVERRIDE` resolution at `src/commands/runner.ts:2158`, resolve `REASONING_EFFORT_OVERRIDE` from the same resolved-config blob.
- Precedence: task field (if introduced later — currently always undefined) → `REASONING_EFFORT_OVERRIDE` → undefined. Pass into `ProviderSessionConfig.reasoningEffort` at `src/commands/runner.ts:2198`.
- **Add `'REASONING_EFFORT_OVERRIDE'` to the `RELOADABLE_ENV_KEYS` set at `src/commands/runner.ts:327-330`.** Without this, hot reconciliation won't pick up effort changes — workers would need a restart between PATCH and the next session. Mirrors how `MODEL_OVERRIDE` is treated.

#### 3. Latest-model telemetry

**File**: `src/commands/provider-credentials.ts`
**Changes**:
- Extend `buildLatestModelReport()` at line 471 to accept an optional `reasoningEffort` and include it in the payload.
- Extend `reportLatestModel()` at line 448 to forward the field.
- Runner calls at `src/commands/runner.ts:2259` and `src/commands/runner.ts:2504` pass the resolved level (initial report) and the adapter-applied level (post-result).

#### 4. Tests

**File**: `src/tests/model-control.test.ts`
**Changes**:
- Resolution precedence test: agent `REASONING_EFFORT_OVERRIDE=high` with no task field → `ProviderSessionConfig.reasoningEffort === 'high'`.
- Unset case: no override anywhere → `reasoningEffort === undefined`.

### Success Criteria:

#### Automated Verification:
- [ ] Resolution tests pass: `bun test src/tests/model-control.test.ts`
- [ ] Type check + lint: `bun run tsc:check && bun run lint`
- [ ] Worker code does not import DB modules: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Local E2E (per swarm-local-e2e skill): start API + lead + worker, PATCH an agent with `reasoning_effort: 'high'`, dispatch a no-op task, grep worker logs for `reasoningEffort` in the initial latest-model report payload → expect `"reasoningEffort":"high"`.

#### Manual Verification:
- [ ] Confirm `ProviderSessionConfig.reasoningEffort` is set in worker logs even though no adapter consumes it yet (sanity check the wire).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] runner resolves and reports reasoning_effort`.

---

## Phase 4: Adapter integrations (all four harnesses)

### Overview

Each adapter calls `applyReasoningEffort()` and merges the returned shape into its harness-specific transport. After this phase, dispatching a task with `reasoning_effort` set actually changes the harness's behavior on all four local harnesses.

### Changes Required:

#### 1. Claude adapter

**File**: `src/providers/claude-adapter.ts`
**Changes**:
- Near `Bun.spawn` env construction (around line 382), call `applyReasoningEffort('claude', config.model, config.reasoningEffort)`; if `claude-env`, merge `app.env` into the spawn env (sets `CLAUDE_CODE_EFFORT_LEVEL` and optionally `MAX_THINKING_TOKENS=0` for `off` on legacy models).
- No CLI flag changes — env-only path per research findings (`--effort` is buggy in `-p` mode).
- **additionalArgs precedence**: `additionalArgs` is appended verbatim to the Claude CLI args at `src/providers/claude-adapter.ts:402-403`. If an operator puts `--effort high` in `additionalArgs` while also setting `reasoning_effort=low` in the runtime UI, the CLI flag wins over our `CLAUDE_CODE_EFFORT_LEVEL` env (Claude CLI's documented precedence). This matches the project's existing "additionalArgs is an escape hatch" philosophy; documented in Phase 6 runbook updates rather than enforced in code.

#### 2. Codex adapter

**File**: `src/providers/codex-adapter.ts`
**Changes**:
- Where SDK `config` is built (around the `show_raw_agent_reasoning` pin at line 353, and thread options at line 1205), call `applyReasoningEffort('codex', ...)`; if `codex-config`, spread `app.config` into the SDK config map (sets `model_reasoning_effort`).
- **Reasoning-trace visibility note**: `show_raw_agent_reasoning` stays pinned `false`. Operators setting `reasoning_effort=high` get the cost of reasoning tokens but no visible trace in the UI (only the `reasoning_output_tokens` count surfaces in cost telemetry). Flag in the Phase 6 docs. Surfacing the raw trace is a separate follow-up runtime field, out of scope here.

#### 3. Pi adapter

**File**: `src/providers/pi-mono-adapter.ts`
**Changes**:
- Before `createAgentSession` call at line 712, call `applyReasoningEffort('pi', ...)`; if `pi-session`, merge `app.sessionOptions` into the session options (sets `thinkingLevel`).
- `thinkingLevel` is top-level on `createAgentSession` options per `node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts` (`thinkingLevel?: ThinkingLevel`) and `core/agent-session.d.ts` — no nesting under `sessionConfig` needed. (Reviewer-verified; previously a research open question.)

#### 4. Opencode adapter

**File**: `src/providers/opencode-adapter.ts`
**Changes**:
- Where per-task `opencode.json` is built (around `model: config.model` at line 590), call `applyReasoningEffort('opencode', ...)`; if `opencode-options`, splice `app.options` into `provider[app.providerId].models[app.modelId].options`.
- Helper handles provider parsing (`anthropic/...` → `thinking`, `openai/...` → `reasoningEffort`, `openrouter/...` → `reasoning`).

#### 5. Adapter telemetry — applied-level feedback

**File**: `src/providers/types.ts` + each adapter
**Changes**:
- Extend `ProviderResult` (the adapter return type, not `ProviderSessionConfig`) with `appliedReasoningEffort?: ReasoningEffort | null`. Mutating the input config to return data is an anti-pattern; the pattern mirrors how `event.cost.model` flows back at `src/commands/runner.ts:2504`.
- Each adapter, when `applyReasoningEffort` returned a non-noop application, sets `appliedReasoningEffort` to the value it actually used on its session/spawn. `noop` cases set `null` (signals "didn't apply, capability rejected or no input").
- Runner reads `result.appliedReasoningEffort` and passes it into `reportLatestModel()` at `src/commands/runner.ts:2504` (post-result report). Initial report at `src/commands/runner.ts:2259` uses the resolved value from `ProviderSessionConfig.reasoningEffort`.

#### 6. Adapter tests

**File**: `src/tests/claude-adapter.test.ts`, `src/tests/codex-adapter.test.ts`, `src/tests/pi-mono-adapter.test.ts`, `src/tests/opencode-adapter.test.ts`
**Changes**:
- Each: assert the harness-specific transport carries the expected shape for `reasoningEffort: 'high'` on a representative model.
- Each: assert `undefined` produces unchanged transport.
- Codex: `xhigh` on `gpt-5.1-codex` (non-max) results in `noop` and the SDK config does NOT include `model_reasoning_effort`.

### Success Criteria:

#### Automated Verification:
- [ ] All four adapter test files pass: `bun test src/tests/claude-adapter.test.ts src/tests/codex-adapter.test.ts src/tests/pi-mono-adapter.test.ts src/tests/opencode-adapter.test.ts`
- [ ] Type check + lint: `bun run tsc:check && bun run lint`

#### Automated QA:
- [ ] Local E2E per harness: for each of `claude`, `codex`, `pi`, `opencode`, set `reasoning_effort: 'high'` on an agent, dispatch a task, and verify the spawn carries the right knob:
  - Claude: child process env includes `CLAUDE_CODE_EFFORT_LEVEL=high`.
  - Codex: SDK config map contains `model_reasoning_effort: 'high'` (intercept via logging).
  - Pi: `createAgentSession` options include `thinkingLevel: 'high'`.
  - Opencode: written `opencode.json` contains the matching provider-keyed reasoning options.

#### Manual Verification:
- [ ] For at least one harness (recommend Claude — fastest), run a task that benefits from reasoning at `low` then `high` and eyeball that the output reflects the difference. Subjective, but confirms the wire actually reaches the model.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] adapters honor reasoning_effort`.

---

## Phase 5: UI runtime editor + grey-out

### Overview

Add an effort selector to `AgentRuntimeSettings` next to the model picker, with per-model level gating. Save flow extends `useUpdateAgentRuntime` to send `reasoning_effort`. Configured + last-used values are displayed.

### Changes Required:

#### 1. ModelOption extension

**File**: `ui/src/lib/agent-runtime-models.ts`
**Changes**:
- Extend `ModelOption` (around line 27) with `reasoningLevels?: ReadonlyArray<'off'|'low'|'medium'|'high'|'xhigh'>`.
- When mapping from `modelsdev-cache.json`, fill `reasoningLevels` from the `reasoning` field (only models that support reasoning get non-empty arrays).
- Direct registry entries (Claude/Codex) and snapshot-backed groups (Pi/Opencode) both populated. Apply harness-level rules client-side (mirror the server-side table to keep grey-out accurate).

#### 2. Effort selector component

**File**: `ui/src/components/shared/agent-runtime-settings.tsx`
**Changes**:
- Add `effort` to the editor state alongside `harness`/`model`/`customMode` (around line 84).
- Render a 5-segment toggle (off / low / medium / high / xhigh) between the model picker and the save button. Greys out segments not in the selected model's `reasoningLevels` with a tooltip explaining why (e.g. "Claude Opus 4.7 doesn't support 'off' — use 'low' instead").
- When the selected model changes and the current effort isn't in its `reasoningLevels`, clear the effort field (don't auto-coerce silently).
- Display the configured + last-used effort below the picker (mirror the existing model display at line 183).

#### 3. Mutation payload

**File**: `ui/src/api/client.ts` + `ui/src/api/hooks/use-agents.ts`
**Changes**:
- Extend the runtime route body in `ui/src/api/client.ts:215` with `reasoning_effort`.
- `useUpdateAgentRuntime` (`ui/src/components/shared/agent-runtime-settings.tsx:92`) passes the new field.
- React Query cache invalidations in `ui/src/api/hooks/use-agents.ts:64` already cover `agents`/`agent`/`configs` — no change needed.

### Success Criteria:

#### Automated Verification:
- [ ] UI lint + types: `cd ui && pnpm lint && pnpm exec tsc -b`
- [ ] Backend tests still pass: `bun test`

#### Automated QA:
- [ ] qa-use session per swarm-local-e2e skill: open `/agents/<id>`, change harness to each of the four, set effort to each valid level, save, reload, confirm value persists. For Codex with model `gpt-5.1-codex`, confirm `xhigh` is greyed out with the documented tooltip. Capture screenshots per harness × level matrix into `thoughts/taras/qa/` (see QA Spec).

#### Manual Verification:
- [ ] Eyeball the segmented control in light + dark mode; confirm the grey-out tooltip is readable and the last-used value updates after a real task.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] UI runtime editor surfaces reasoning_effort`.

### QA Spec (optional):

Cross-cutting visual evidence across all four harnesses + multiple models warrants a separate QA doc.

**QA Doc**: `thoughts/taras/qa/2026-05-27-reasoning-effort-runtime-control.md` (generate via `desplega:qa`; scenarios live in the doc, not here).

---

## Phase 6: Agent list display + docs + memory

### Overview

Surface last-used effort in the agent list (or its tooltip), update runbooks/docs, regenerate OpenAPI one more time after any final tweaks, and update the runtime-model-control memory entry with the new persistence key.

### Changes Required:

#### 1. Agent list / harness cell

**File**: `ui/src/pages/agents/page.tsx` + `ui/src/components/shared/harness-cell.tsx`
**Changes**:
- Extend the `Model` column tooltip (or add a small badge) to include `latestModel.reasoningEffort` when present. Reuse `findKnownModel` lookup for label rendering.
- `HarnessCell` tooltip (`ui/src/components/shared/harness-cell.tsx:60`) gains a "Effort" line below the existing model/source rows.

#### 2. Docs

**File**: `runbooks/harness-providers.md` + `docs-site/content/docs/(documentation)/guides/harness-providers.mdx` + `docs-site/content/docs/(documentation)/guides/harness-configuration.mdx`
**Changes**:
- Add a "Reasoning / effort" subsection per harness with: the agent-swarm normalized levels, what each harness does under the hood, gating notes (Claude Opus 4.7 no `off`, Codex `*-codex` no `minimal`/`xhigh`).
- **Claude section**: explicit precedence note — `--effort` in `additionalArgs` overrides `CLAUDE_CODE_EFFORT_LEVEL`. The runtime UI value loses to additionalArgs.
- **Codex section**: explicit note — `show_raw_agent_reasoning` stays `false`; high effort costs reasoning tokens but produces no visible trace in the dashboard. Reasoning-token count still appears in cost telemetry.
- Cross-link to the research doc.

#### 3. Memory

**File**: `/Users/taras/.claude/projects/-Users-taras-Documents-code-agent-swarm/memory/`
**Changes**:
- Update the existing runtime model-control memory entry (or add a sibling) noting: `REASONING_EFFORT_OVERRIDE` is the persistence key (in `RELOADABLE_ENV_KEYS` for hot reconciliation); closed enum is `off|low|medium|high|xhigh`; capability gating lives in `src/providers/reasoning-effort.ts`; last-used effort is in `cred_status.latestModel.reasoningEffort`; `deleteSwarmConfigByKey` is the new general-purpose clearing helper.

#### 4. OpenAPI no-drift check

**File**: `openapi.json` + `docs-site/content/docs/api-reference/agents.mdx`
**Changes**: Phases 3-5 don't touch routes, so no regen is expected. Run `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/` and confirm clean. If there is drift, investigate before merging.

### Success Criteria:

#### Automated Verification:
- [ ] UI lint + types: `cd ui && pnpm lint && pnpm exec tsc -b`
- [ ] No drift: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`
- [ ] Markdown lint where applicable (docs-site build): `cd docs-site && pnpm build` (or whatever the docs-site command is)

#### Automated QA:
- [ ] qa-use: navigate `/agents`, hover the harness cell of an agent that ran with `reasoning_effort: 'high'`, screenshot confirming the tooltip shows the effort line.
- [ ] Read the runbook + guide additions back to confirm they accurately describe each harness's behavior (cross-check with the research doc).

#### Manual Verification:
- [ ] Skim the docs in browser preview; confirm code samples use the four normalized levels consistently.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] surface and document reasoning_effort`.

---

## Appendix

- **Follow-up plans**: none planned — feature ships in one plan. If `minimal` / `max` / numeric budgets become needed, they're additive surface extensions to the helper module and editor.
- **Derail notes**:
  - Consider promoting the UI capability lookup to a `/api/runtime/reasoning-capabilities` endpoint if the duplicated table goes stale frequently. Not v1.
  - `show_raw_agent_reasoning` is currently pinned `false` for Codex — surfacing it as a separate per-agent runtime field is a candidate follow-up but unrelated to effort.
  - Surfacing `MAX_THINKING_TOKENS` as an advanced numeric escape hatch in the UI (alongside the qualitative selector) — would let power users dial Claude budgets on legacy Sonnet/Opus 4.6 models. Out of scope but easy follow-up.
  - The Critical #1 fix scope-expanded to also patch the latent `MODEL_OVERRIDE` clear gap (PATCH `model: null` now clears the row via the same new helper). This was the recommended choice during review and removes a long-standing UX paper-cut.
- **References**:
  - Research: `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`
  - Prior memory entry: runtime model-control rollout (durable boundary: `swarm_config` desired settings + `cred_status` worker-reported truth).
  - Anthropic effort docs: `platform.claude.com/docs/en/build-with-claude/effort`
  - Codex config reference: `developers.openai.com/codex/config-reference`
  - pi-mono SDK: `github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md`
  - Opencode config: `opencode.ai/docs/config/`

---

## Review Errata

_Reviewed: 2026-05-27 by Claude (gap analysis via `desplega:reviewing`, Auto-apply mode)_

### Applied

- [x] **Critical #1**: Corrected the false "MODEL_OVERRIDE clears on null today" claim — it doesn't (existing schema requires non-empty `model`). Added new `deleteSwarmConfigByKey` helper sub-step to Phase 2 §5; scope-expanded to also fix the latent `MODEL_OVERRIDE` clear gap. Per user choice (recommended).
- [x] **Critical #2**: Added `'REASONING_EFFORT_OVERRIDE'` to `RELOADABLE_ENV_KEYS` (Phase 3 §2) so workers hot-reconcile effort changes without restart. Mirrors `MODEL_OVERRIDE` treatment.
- [x] **Critical #3**: Documented `additionalArgs` precedence over `CLAUDE_CODE_EFFORT_LEVEL` (Phase 4 §1, Phase 6 docs). Per user choice (recommended): no behavior change, just clear docs.
- [x] **Critical #4**: Reconciled `noop` vs 400 contradiction. `noop` is defense-in-depth for legacy/custom configs; primary rejection is API-time 400 (Phase 2). Phase 1 §3 and smoke-script criteria updated accordingly.
- [x] **Important #1**: Updated drifted file:line refs (`src/types.ts:499` → `:503-510`, `src/providers/types.ts:80` → `:81`, runtime schema `src/http/agents.ts:82` → `:93-97`).
- [x] **Important #2**: Moved capability data source to a new server-side snapshot `src/providers/modelsdev-reasoning.json` (refreshed by extending `scripts/refresh-modelsdev-pricing.ts`). Eliminates the unusual cross-boundary import from `src/providers/` into `ui/src/lib/`.
- [x] **Important #3**: Added Codex `show_raw_agent_reasoning` interaction note (Phase 4 §2, Phase 6 docs) — high effort costs reasoning tokens but produces no visible trace in the dashboard.
- [x] **Important #4**: Replaced the redundant Phase 6 §4 OpenAPI regen with a no-drift check (phases 3-5 don't touch routes).
- [x] **Important #5**: Closed the Pi `thinkingLevel` placement open question — reviewer verified it's top-level on `createAgentSession` options per the installed `.d.ts`. Phase 4 §3 and Appendix updated.
- [x] **Important #6**: Reframed Phase 4 §5 telemetry feedback path. Adapter return type (`ProviderResult.appliedReasoningEffort`) carries the applied level rather than mutating the input config — mirrors the existing `event.cost.model` flow at `src/commands/runner.ts:2504`.
- [x] **Important #7**: Added a Phase 2 §1 note that PATCH'd `REASONING_EFFORT_OVERRIDE` is a silent no-op until Phase 3 ships (runner doesn't read it yet). Acceptable per contract-first phasing; flagged for the commit message.
- [x] **Minor**: Standardized the Pi model example to `openrouter/google/gemini-3-flash-preview` (matches the research doc default). Removed the inconsistent `openrouter/anthropic/claude-sonnet-4-6` example.

### Scope expansion note

Critical #1 fix scope-expanded: the new `deleteSwarmConfigByKey` helper plus the `model: nullable()` schema change also fix the latent `MODEL_OVERRIDE` clear gap (today you can set it but not unset it via the API). Adds one extra test case to Phase 2 §3 but no extra phases. Documented in the Appendix derail notes.
