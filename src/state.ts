/**
 * SQLite-backed state: discussions, participants, requests.
 *
 * Multiple bridge processes (one MCP server per host) coordinate through this
 * database: WAL mode + busy timeout. Executions happen in separate runner
 * processes which write results back here, so in-flight requests survive an
 * MCP-server restart.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dbPath, ensureDirs } from "./paths.ts";

export type AgentKind = "codex" | "claude" | "zcode";
export type ParticipantStatus = "idle" | "running" | "handoff";
/** running: 执行中; interrupted: 提交后无法确认后端是否完成(禁止自动重发) */
export type RequestStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface DiscussionRow {
  id: string;
  workspace: string;
  host: string;
  created_at: number;
}
export interface ParticipantRow {
  id: string;
  discussion_id: string;
  agent: AgentKind;
  workspace: string;
  native_session_id: string | null;
  status: ParticipantStatus;
  title: string | null;
  created_at: number;
  updated_at: number;
}
export interface RequestRow {
  id: string;
  participant_id: string;
  status: RequestStatus;
  error: string | null;
  answer: string | null;
  answer_file: string | null;
  native_session_id: string | null;
  runner_pid: number | null;
  backend_pid: number | null;
  started_at: number;
  finished_at: number | null;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS discussions(
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      host TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants(
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      agent TEXT NOT NULL CHECK(agent IN ('codex','claude','zcode')),
      workspace TEXT NOT NULL,
      native_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','handoff')),
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(discussion_id, agent)
    );
    CREATE TABLE IF NOT EXISTS requests(
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
      error TEXT,
      answer TEXT,
      answer_file TEXT,
      native_session_id TEXT,
      runner_pid INTEGER,
      backend_pid INTEGER,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_participant ON requests(participant_id, started_at);
  `);
  return db;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

// ---------- discussions ----------

export function createDiscussion(workspace: string, host: string): DiscussionRow {
  const d = getDb();
  const row: DiscussionRow = {
    id: newId("disc"),
    workspace,
    host,
    created_at: Date.now(),
  };
  d.prepare("INSERT INTO discussions(id, workspace, host, created_at) VALUES(?,?,?,?)").run(
    row.id, row.workspace, row.host, row.created_at,
  );
  return row;
}

export function getDiscussion(id: string): DiscussionRow | null {
  return (getDb()
    .prepare("SELECT * FROM discussions WHERE id = ?")
    .get(id) as DiscussionRow) ?? null;
}

// ---------- participants ----------

export function createParticipant(
  discussionId: string,
  agent: AgentKind,
  workspace: string,
): ParticipantRow {
  const d = getDb();
  const now = Date.now();
  const row: ParticipantRow = {
    id: newId("part"),
    discussion_id: discussionId,
    agent,
    workspace,
    native_session_id: null,
    status: "idle",
    title: null,
    created_at: now,
    updated_at: now,
  };
  d.prepare(
    `INSERT INTO participants(id, discussion_id, agent, workspace, native_session_id, status, title, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(row.id, row.discussion_id, row.agent, row.workspace, null, "idle", null, now, now);
  return row;
}

export function getParticipant(id: string): ParticipantRow | null {
  return (getDb()
    .prepare("SELECT * FROM participants WHERE id = ?")
    .get(id) as ParticipantRow) ?? null;
}

export function findParticipantByAgent(discussionId: string, agent: AgentKind): ParticipantRow | null {
  return (getDb()
    .prepare("SELECT * FROM participants WHERE discussion_id = ? AND agent = ?")
    .get(discussionId, agent) as ParticipantRow) ?? null;
}

export function updateParticipant(id: string, fields: Partial<ParticipantRow>): void {
  const cur = getParticipant(id);
  if (!cur) throw new Error(`participant ${id} not found`);
  const next = { ...cur, ...fields, updated_at: Date.now() };
  getDb()
    .prepare(
      `UPDATE participants SET native_session_id=?, status=?, title=?, updated_at=? WHERE id=?`,
    )
    .run(next.native_session_id ?? null, next.status, next.title ?? null, next.updated_at, id);
}

export function listParticipants(discussionId: string): ParticipantRow[] {
  return getDb()
    .prepare("SELECT * FROM participants WHERE discussion_id = ? ORDER BY created_at")
    .all(discussionId) as ParticipantRow[];
}

// ---------- requests ----------

export function createRequest(participantId: string): RequestRow {
  const d = getDb();
  const row: RequestRow = {
    id: newId("req"),
    participant_id: participantId,
    status: "running",
    error: null,
    answer: null,
    answer_file: null,
    native_session_id: null,
    runner_pid: null,
    backend_pid: null,
    started_at: Date.now(),
    finished_at: null,
  };
  d.prepare(
    `INSERT INTO requests(id, participant_id, status, started_at) VALUES(?,?,?,?)`,
  ).run(row.id, participantId, "running", row.started_at);
  return row;
}

export function getRequest(id: string): RequestRow | null {
  return (getDb()
    .prepare("SELECT * FROM requests WHERE id = ?")
    .get(id) as RequestRow) ?? null;
}

export function latestRequest(participantId: string): RequestRow | null {
  return (getDb()
    .prepare("SELECT * FROM requests WHERE participant_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(participantId) as RequestRow) ?? null;
}

export function setRequestPids(id: string, runnerPid: number, backendHint: number | null): void {
  getDb()
    .prepare("UPDATE requests SET runner_pid=?, backend_pid=? WHERE id=?")
    .run(runnerPid, backendHint, id);
}

/**
 * Finish a request. `expectRowVersion` guards against a concurrent cancel:
 * if the row was already moved out of 'running' (e.g. cancelled), keep that
 * terminal status and just record the native session id.
 */
export function finishRequest(
  id: string,
  status: RequestStatus,
  answer: string | null,
  answerFile: string | null,
  error: string | null,
): void {
  const d = getDb();
  const cur = getRequest(id);
  if (!cur) return;
  if (cur.status !== "running") return; // 已终止(cancelled 等)保持原状态
  d.prepare(
    `UPDATE requests SET status=?, answer=?, answer_file=?, error=?, finished_at=? WHERE id=?`,
  ).run(status, answer, answerFile, error, Date.now(), id);
}

export function recordNativeSessionId(requestId: string, sessionId: string): void {
  getDb().prepare("UPDATE requests SET native_session_id=? WHERE id=?").run(sessionId, requestId);
}

export function runningRequests(): RequestRow[] {
  return getDb()
    .prepare("SELECT * FROM requests WHERE status = 'running'")
    .all() as RequestRow[];
}

/**
 * Startup recovery for in-flight rows. A live runner process will finish the
 * row on its own; a dead runner means we cannot confirm delivery — mark
 * interrupted (never auto-resend). Returns whether backend pids need killing
 * by the caller's cancel path.
 */
export function recoverInterrupted(pidsAlive: (pid: number) => boolean): { cleaned: string[]; stillOwned: string[] } {
  const cleaned: string[] = [];
  const stillOwned: string[] = [];
  for (const r of runningRequests()) {
    const runnerAlive = r.runner_pid != null && pidsAlive(r.runner_pid);
    if (runnerAlive) {
      stillOwned.push(r.id);
      continue;
    }
    finishRequest(r.id, "interrupted", null, null,
      "bridge restarted while request was in flight; cannot confirm whether the backend completed it — not auto-resent. Cancel to release the participant.");
    const p = getParticipant(r.participant_id);
    if (p && p.status === "running") updateParticipant(p.id, { status: "idle" });
    cleaned.push(r.id);
  }
  return { cleaned, stillOwned };
}
