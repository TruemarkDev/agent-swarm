/**
 * Shared constants used across worker- and server-side code.
 */

/**
 * Default dashboard URL used when `APP_URL` is unset. Points at the public
 * production dashboard so links (Slack messages, approval URLs, etc.) are
 * always renderable. Self-hosted operators should set `APP_URL` to override.
 */
export const DEFAULT_APP_URL = "https://app.agent-swarm.dev";

/**
 * Resolve the effective app/dashboard URL from `APP_URL` (with trailing
 * slashes stripped), falling back to {@link DEFAULT_APP_URL}.
 */
export function getAppUrl(): string {
  const raw = process.env.APP_URL?.trim();
  return (raw || DEFAULT_APP_URL).replace(/\/+$/, "");
}

/**
 * Default agent-fs live host used when `AGENT_FS_LIVE_URL` is unset. Points at
 * the public production live server so any link rendered in Slack/UI is
 * always reachable. Self-hosted operators should set `AGENT_FS_LIVE_URL`.
 */
export const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

/**
 * Resolve the effective agent-fs live URL from `AGENT_FS_LIVE_URL` (with
 * trailing slashes stripped), falling back to {@link DEFAULT_AGENT_FS_LIVE_URL}.
 */
export function getAgentFsLiveUrl(): string {
  const raw = process.env.AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

/**
 * Optional fallback agent-fs `org_id` for attachments that store only `path`.
 * Strictly opt-in — when neither env var is set, the renderer keeps the
 * `agent-fs:<path>` raw-string fallback. Row-level IDs always win over the
 * env-var defaults so per-attachment overrides remain authoritative.
 */
export function getAgentFsDefaultOrgId(): string | undefined {
  const raw = process.env.AGENT_FS_DEFAULT_ORG_ID?.trim();
  return raw || undefined;
}

/**
 * Optional fallback agent-fs `drive_id`. See {@link getAgentFsDefaultOrgId}.
 */
export function getAgentFsDefaultDriveId(): string | undefined {
  const raw = process.env.AGENT_FS_DEFAULT_DRIVE_ID?.trim();
  return raw || undefined;
}

/**
 * Resolve a public agent-fs live URL for an attachment when we have enough
 * info — `path` plus (`orgId` and `driveId`, falling back to env-var
 * defaults). Returns `null` when the path is missing or no org/drive pair is
 * available; callers fall back to the raw `agent-fs:<path>` display.
 *
 * Shape:  ${liveHost}/file/~/<orgId>/<driveId>/<normalized-path>
 */
export function buildAgentFsLiveUrl(opts: {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  const orgId = opts.orgId?.trim() || getAgentFsDefaultOrgId();
  const driveId = opts.driveId?.trim() || getAgentFsDefaultDriveId();
  if (!orgId || !driveId) return null;
  const host = getAgentFsLiveUrl();
  const normalizedPath = path.replace(/^\/+/, "");
  return `${host}/file/~/${orgId}/${driveId}/${normalizedPath}`;
}
