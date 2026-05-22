---
date: 2026-05-21T00:00:00Z
author: taras
topic: "Trim and clean up the Agent Swarm UI sidebar"
tags: [brainstorm, ui, navigation, sidebar, ia]
status: ready-for-plan
exploration_type: workflow
last_updated: 2026-05-22
last_updated_by: taras
---

# Trim and clean up the Agent Swarm UI sidebar — Brainstorm

## Context

The Agent Swarm dashboard sidebar (`ui/src/components/layout/app-sidebar.tsx`) currently
has **21 nav items across 5 groups**:

- **Core** (6): Home, Dashboard, Agents, Sessions, Tasks, People
- **AI** (3): Skills, MCP Servers, Memory
- **Operations** (5): Schedules, Workflows, Pages, Usage, Budgets
- **Configuration** (4): Integrations, Templates, Approvals, Repos
- **System** (3): Config, API Keys, Debug

Each group is a `CollapsibleSection` (defaults open). Some items are feature-gated by API
version (Sessions 1.76, Pages 1.79, People 1.80). Footer has just the collapse trigger.

Taras wants to trim/clean it up and align the structure with **future plans** for the
product. Recent product direction (from `thoughts/taras/brainstorms/`):
- Humans as first-class users + People page redesign (just merged, #500)
- UI chat / session experience overhaul (2026-05-08)
- DB-backed Pages, client-side MCP, RBAC for swarm, agent reusable scripts

This is a workflow / information-architecture exploration: the goal is the right *shape*
for navigation, not just deleting items.

## Exploration

### Q: What bothers you most about the current sidebar?
**All four:** too many items, wrong grouping/IA, low-value items present, and it
doesn't fit the future direction.

**Insights:** This is a full IA rethink, not a delete-a-few-items pass. The fix has
to (a) reduce visible count, (b) re-cut the groups around how the product is *used*,
(c) demote low-value destinations, and (d) anchor the structure to where the product
is heading. The 5 grew-organically groups (Core/AI/Operations/Configuration/System)
are themselves a symptom.

### Q: Who is the primary user the sidebar should be optimized for?
RBAC is on the horizon, so there should be an **admin view** and an **end-user view**
of the sidebar.

**Insights:** The sidebar isn't one design — it's two role-scoped projections of one
nav model. End-user view = lean (do work: chat, tasks, results). Admin view = full
(also run the swarm: config, integrations, keys, debug, budgets). This means: define
the full nav model once, tag each item with a min-role, and render the subset. It also
means the *trim* for end users can be aggressive (hide whole groups) without deleting
anything for admins. Until RBAC ships, the admin view is the default; the end-user
view is the design target the structure must support.

### Q: How should the 8 settings/admin items be handled?
Move them into the **user menu** (top-right avatar) — out of the sidebar entirely.
The sidebar becomes purely "work" destinations.

**Insights:** The avatar menu becomes the entry to a Settings area. Clear wins for
**Config, API Keys, Integrations, Repos, Debug** — unambiguous admin/settings. But
three of the listed items aren't really "settings": **Templates** is an agent
resource (like Skills), **Usage / Budgets** are cost observability. Those need a
separate home — see next question. Net effect so far: ~5 items leave the sidebar.

### Q: Where should Templates / Usage / Budgets live?
Templates → Settings/menu. **Usage + Budgets merge into one sidebar "Usage"
destination** with tabs (cost + budgets together).

**Insights:** Running tally — sidebar count drops from 21 → ~14. Items leaving for
the user menu / Settings area: Config, API Keys, Integrations, Repos, Debug,
Templates (6). Usage+Budgets collapse to 1. Remaining: Home, Dashboard, Agents,
Sessions, Tasks, People, Skills, MCP Servers, Memory, Schedules, Workflows, Pages,
Approvals, Usage. Two open structural problems left: (1) Home vs Dashboard look
redundant, (2) the remaining 14 still need a coherent grouping.

### Q: How to resolve the Home vs Dashboard redundancy?
**Unify into a single page.** Move the current implementations aside to
`/old-home` and `/old-dashboard` (preserved, not deleted). The new unified page is
deliberately minimal: an `<h1>` welcome + user name (when available) + the agent
diagram (`AgentCanvas`) at full available size. Nothing else — Taras will iterate
on it later.

**Insights:** One "Home" nav item, full-bleed agent canvas as the product's face.
The onboarding setup-checklist content from old Home and the action-items
`InboxPanel` from old Dashboard both lose their home — the checklist can resurface
contextually (banner/dismissible), and the inbox content maps onto the **Approvals**
destination, which now carries more weight. Implementation note: keep `/old-*`
routes out of the sidebar entirely (reachable by URL only). Sidebar count → ~13.

### Remaining sidebar items after trimming
Home · Agents · Sessions · Tasks · People · Skills · MCP Servers · Memory ·
Schedules · Workflows · Pages · Approvals · Usage (= 13).

### Q: How should the remaining items be grouped?
Taras reconsidered Usage: **move Usage down with the settings-style items** and
render it as a **tabbed section** (Usage tab + Budgets tab) inside the account/
Settings area — not in the main work-sidebar.

**Insights:** Agreed — Usage/Budgets are read-mostly *observability*, admin-leaning;
end users rarely need them. This is consistent with the RBAC end-user/admin split.
The "user menu" target is really an **account/admin area** with its own tabbed
sub-nav, now holding: Config, API Keys, Integrations, Repos, Debug, Templates,
Usage+Budgets. Worth a caveat: Usage isn't *config* — when that area gets designed
it likely wants a top-level split (Settings vs. Usage vs. Resources-like-Templates)
rather than one flat tab strip. Out of scope here; flagged for the Settings redesign.
**Sidebar is now 12 items**: Home · Tasks · Sessions · Approvals · Agents · People ·
Workflows · Schedules · Skills · MCP Servers · Memory · Pages.

### Q: How should the 12 items be grouped?
**3 groups by intent:**
- **WORK**: Home, Tasks, Sessions, Approvals
- **SWARM**: Agents, People, Workflows, Schedules
- **RESOURCES**: Skills, MCP Servers, Memory, Pages

**Insights:** Down from 5 groups to 3, each with a clear intent. The old "AI" label
disappears into "RESOURCES". 3 collapsible sections is light enough that collapsing
matters less — could even render as static labels.

### Q: How does the /chat route fit?
**Disregard it** — `/chat` is backward-compat / legacy. Not a future surface to
design around. Sidebar stays 12 items; Sessions is the conversational surface.

### Q: URL backward compatibility (Taras note)
Old URLs must **not 404**. Every route that moves needs a redirect; in some cases
the redirect carries a `?tab=` query param.

**Insights:** Concrete redirect map implied by the trim:
- `/dashboard` → `/` (Home unified). Old impls live at `/old-home`, `/old-dashboard`
  (URL-only, not redirected — kept for reference).
- `/budgets` → `/usage?tab=budgets` (Usage+Budgets merged into tabs).
- `/config`, `/keys`, `/integrations`, `/repos`, `/debug`, `/templates`, `/usage`
  → `/settings?tab=<name>` once the account/Settings area exists.
- Deep links like `/integrations/slack` must still resolve — redirect should
  preserve the trailing segment or map it to a tab + sub-state.
Cleanest implementation: a small `<Navigate>`/redirect table in the router
(`ui/src/app/*.tsx`) keyed by old path → new path+query. Add a redirect whenever a
route moves; never just delete a route.

### Q: Which items should an end user NOT see (RBAC view split)?
**Decide later.** Don't pin the role mapping now — design the nav model to be
role-taggable, defer the actual end-user/admin item mapping until RBAC is built.

**Insights:** The nav model gets a per-item `minRole` (or similar) field from the
start, but every item ships visible-to-all until RBAC lands. No behavior change now;
just don't bake in a structure that can't express the split later.

### Q: How should the account area be structured, and where does Templates land?
**Settings + Usage split.** The avatar menu gets **two** entries:
- **Settings** — Config, API Keys, Integrations, Repos, Debug
- **Usage** — cost + budgets (tabbed)

**Templates moves back to the RESOURCES sidebar group** (next to Skills/MCP/Memory).

**Insights:** This resolves the "flat tab strip is wrong" objection — settings-proper
and observability are separated rather than crammed together. Templates is correctly
treated as an agent resource, not config. **Sidebar count rises 12 → 13.**

### Q: Where does the onboarding setup-checklist go?
**Keep it on `/old-home` only.** Don't re-home it. It survives at the preserved
`/old-home` route; onboarding gets its own effort later.

**Insights:** Zero extra work for the trim — the checklist isn't lost, just not on
the new minimal Home. New Home stays purely the agent canvas.

### Q: How should the 3 group headers render?
**Collapsible**, and **persist each group's open/closed state to localStorage.**

**Insights:** Current `CollapsibleSection` only has `defaultOpen` — no persistence.
Need to add localStorage-backed state keyed per group so a user's folded groups
stay folded across reloads.

## Synthesis

### Target sidebar (13 items, 3 groups)

```
WORK
  Home          unified landing — welcome + user name + full-bleed AgentCanvas
  Tasks
  Sessions
  Approvals     absorbs the old Dashboard action-items InboxPanel
SWARM
  Agents
  People
  Workflows
  Schedules
RESOURCES
  Skills
  MCP Servers
  Memory
  Pages
  Templates
```

Group headers are collapsible; open/closed state persists per-group in localStorage.

Account area — two entries in the top-right avatar menu:
- **Settings** (`/settings`, sub-nav): Config · API Keys · Integrations · Repos · Debug
- **Usage** (`/usage`, tabbed): Usage · Budgets

### Key Decisions
- **21 → 13 sidebar items**; **5 → 3 groups** (WORK / SWARM / RESOURCES).
- **Home + Dashboard unified** into one minimal page: `<h1>` welcome + user name +
  `AgentCanvas` at full size. Old impls preserved at `/old-home`, `/old-dashboard`.
- **5 items leave the sidebar** for the account area: Config, API Keys,
  Integrations, Repos, Debug.
- **Account area splits into two avatar-menu entries**: Settings (Config, Keys,
  Integrations, Repos, Debug) and Usage (Usage + Budgets, tabbed).
- **Templates stays in the sidebar**, in the RESOURCES group — it's an agent
  resource, not config.
- **Usage + Budgets merged** into one tabbed surface under the Usage menu entry.
- **Group headers stay collapsible**, with per-group open/closed state persisted to
  localStorage (new — current `CollapsibleSection` has no persistence).
- **Nav model becomes role-taggable** (per-item `minRole`) for a future RBAC
  end-user vs admin view — but all items stay visible until RBAC ships.
- **Onboarding setup-checklist stays on `/old-home`** — not re-homed.
- `/chat` route is legacy/backward-compat — excluded from nav, left as-is.

### Open Questions
- *All exploration-level open questions resolved.* Remaining items are
  implementation details for the plan phase:
  - Settings sub-nav style (left rail vs tabs) — pick during implementation.
  - Whether `AgentCanvas` needs layout changes to render truly full-bleed on Home.
  - Which items map to end-user vs admin role — deferred to the RBAC effort.

### Constraints Identified
- **No 404s on old URLs.** Every moved route needs a redirect; some carry `?tab=`.
  Redirect map:
  - `/dashboard` → `/`
  - `/budgets` → `/usage?tab=budgets` (Usage stays at `/usage`, Budgets becomes a tab)
  - `/config`, `/keys`, `/integrations`, `/repos`, `/debug` → `/settings?tab=<name>`
  - `/templates` — unchanged (stays a sidebar route)
  - Deep links (`/integrations/slack`) must still resolve — preserve trailing segment.
- `/old-home` + `/old-dashboard` kept reachable by URL (not in nav, not redirected).
  The onboarding setup-checklist lives on `/old-home`.
- Feature-gated items (Sessions 1.76, Pages 1.79, People 1.80) keep their version
  gates — the trim doesn't change gating logic.
- `AppSidebar` is the single source — `navGroups` array drives everything; redirects
  live in the router (`ui/src/app/*.tsx`).

### Core Requirements
1. Rewrite `navGroups` in `app-sidebar.tsx` to the 13-item / 3-group structure above
   (WORK / SWARM / RESOURCES); remove Config, API Keys, Integrations, Repos, Debug.
2. New unified Home page at `/` (h1 + welcome + user name + full-size `AgentCanvas`);
   move current Home/Dashboard impls to `/old-home`, `/old-dashboard`.
3. Add a router redirect table: old paths → new paths (+`?tab=`), no 404s.
4. Merge Usage + Budgets into one tabbed page at `/usage`.
5. Add a two-entry account menu to the top-right avatar — **Settings** (`/settings`
   with sub-nav: Config, API Keys, Integrations, Repos, Debug) and **Usage**.
6. Persist each sidebar group's collapsed state to localStorage (extend
   `CollapsibleSection` or wrap it).
7. Add a role-tag field to the `NavItem` type (unused until RBAC) so the model can
   express the future end-user/admin split.

## Next Steps

- Iron-out questions resolved 2026-05-22. Ready for handoff to `/desplega:create-plan`
  with this brainstorm as input context.
