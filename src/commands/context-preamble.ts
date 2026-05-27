/**
 * Universal context preamble for follow-up task continuity.
 *
 * Builds a bounded text summary of prior task context (parent → ancestor chain)
 * and prepends it to the child task's prompt. This makes follow-up continuity
 * uniform across ALL harness providers — not just those that support native
 * session resume (claude/codex).
 *
 * Token budget (CONTEXT_PREAMBLE_MAX_TOKENS, default 2000) prevents the
 * SIGTERM-143 context-saturation failure mode seen with unbounded session
 * resumes (see swarm memory sigterm-143-resumed-session-context-saturation-2026-05-13).
 */

export const CONTEXT_PREAMBLE_MAX_TOKENS = Number(
  process.env.CONTEXT_PREAMBLE_MAX_TOKENS || "2000",
);
// ~4 chars per token (conservative approximation for mixed code/prose)
export const CONTEXT_PREAMBLE_MAX_CHARS = CONTEXT_PREAMBLE_MAX_TOKENS * 4;
export const CONTEXT_PREAMBLE_MAX_ANCESTORS = 5;

export interface TaskContextForPreamble {
  id: string;
  task: string;
  output?: string;
  progress?: string;
  status?: string;
  parentTaskId?: string;
  attachments?: Array<{
    kind: string;
    name: string;
    url?: string;
    path?: string;
    pageId?: string;
    orgId?: string;
    driveId?: string;
    description?: string;
    intent?: string;
    isPrimary?: boolean;
  }>;
}

/** Fetch minimal task context for preamble generation (worker-side, via HTTP). */
export async function fetchTaskContextForPreamble(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<TaskContextForPreamble | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json()) as TaskContextForPreamble;
    return {
      id: data.id,
      task: data.task,
      output: data.output,
      progress: data.progress,
      status: data.status,
      parentTaskId: data.parentTaskId,
      attachments: data.attachments,
    };
  } catch {
    return null;
  }
}

function formatAttachmentPointer(
  att: NonNullable<TaskContextForPreamble["attachments"]>[number],
): string {
  if (att.kind === "agent-fs" && att.path) {
    const liveHost = process.env.AGENT_FS_LIVE_URL ?? "https://live.agent-fs.dev";
    if (att.orgId && att.driveId) {
      return `${liveHost}/file/~/${att.orgId}/${att.driveId}/${att.path}`;
    }
    return att.path;
  }
  if (att.kind === "url" && att.url) return att.url;
  if (att.kind === "page" && att.pageId) return `(page:${att.pageId})`;
  if (att.kind === "shared-fs" && att.path) return att.path;
  return "(no pointer)";
}

/**
 * Build a bounded context preamble for a follow-up task.
 *
 * Walks the ancestor chain (up to CONTEXT_PREAMBLE_MAX_ANCESTORS) via the API
 * and returns a formatted markdown block that is prepended to the child prompt.
 *
 * - Immediate parent: inline detail (subject + output + attachments)
 * - Older ancestors: pointer-only (taskId + one-line subject)
 *
 * Hard-capped at CONTEXT_PREAMBLE_MAX_CHARS (~CONTEXT_PREAMBLE_MAX_TOKENS
 * tokens) to prevent context saturation.
 */
export async function buildContextPreamble(
  apiUrl: string,
  apiKey: string,
  parentTaskId: string,
): Promise<string | null> {
  const ancestors: TaskContextForPreamble[] = [];
  let currentId: string | undefined = parentTaskId;
  while (currentId && ancestors.length < CONTEXT_PREAMBLE_MAX_ANCESTORS) {
    const ctx = await fetchTaskContextForPreamble(apiUrl, apiKey, currentId);
    if (!ctx) break;
    ancestors.push(ctx);
    currentId = ctx.parentTaskId;
  }
  if (ancestors.length === 0) return null;
  // ancestors[0] is guaranteed by the length check above; TypeScript needs the guard.
  const parent = ancestors[0];
  if (!parent) return null;

  const lines: string[] = [
    "\n---",
    "## Prior Conversation Context",
    "",
    "This task is a follow-up in an ongoing thread. Here is a summary of prior work to maintain continuity.",
    "",
  ];

  const subjectPreview = parent.task.slice(0, 600).replace(/\n/g, " ");
  lines.push(`### Immediate Prior Task (ID: \`${parent.id}\`)`);
  lines.push(`**Task:** ${subjectPreview}`);
  lines.push("");

  const rawResult = parent.output || parent.progress;
  if (rawResult) {
    // Reserve ~55% of budget for the output content; rest for structure + older ancestors
    const outputBudget = Math.floor(CONTEXT_PREAMBLE_MAX_CHARS * 0.55);
    const truncated =
      rawResult.length > outputBudget
        ? `${rawResult.slice(0, outputBudget)}\n\n[output truncated — full history via \`get-task-details\` with taskId \`${parent.id}\`]`
        : rawResult;
    lines.push("**Outcome:**");
    lines.push(truncated);
    lines.push("");
  } else {
    lines.push("**Outcome:** (no output recorded yet — task may still be in progress)");
    lines.push("");
  }

  const atts = parent.attachments?.filter((a) => a.name && (a.url || a.path || a.pageId));
  if (atts && atts.length > 0) {
    lines.push("**Artifacts from prior task:**");
    for (const att of atts.slice(0, 10)) {
      const pointer = formatAttachmentPointer(att);
      const note = att.description || att.intent || "";
      lines.push(`  - **${att.name}**: \`${pointer}\`${note ? ` — ${note}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    `To review the full prior conversation call \`get-task-details\` with taskId \`${parent.id}\`.`,
  );

  if (ancestors.length > 1) {
    lines.push("");
    lines.push(
      "### Older Ancestor Tasks (pointers only — call `get-task-details` for full details)",
    );
    for (const ancestor of ancestors.slice(1)) {
      const brief = ancestor.task.slice(0, 200).replace(/\n/g, " ");
      lines.push(`- \`${ancestor.id}\` — ${brief}`);
    }
  }

  lines.push("", "---", "");

  let preamble = lines.join("\n");

  if (preamble.length > CONTEXT_PREAMBLE_MAX_CHARS) {
    preamble = `${preamble.slice(0, CONTEXT_PREAMBLE_MAX_CHARS)}\n\n[context preamble truncated to ${CONTEXT_PREAMBLE_MAX_TOKENS}-token budget]\n\n---\n`;
  }

  return preamble;
}
