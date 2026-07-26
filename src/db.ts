import Database from "better-sqlite3";
import path from "path";

export interface Job {
  id: string;
  command: string;
  state: "pending" | "processing" | "completed" | "failed" | "dead";
  attempts: number;
  max_retries: number;
  locked_by: string | null;
  run_at: string;
  created_at: string;
  updated_at: string;
}

const DB_PATH = process.env.QUEUECTL_DB_PATH || path.resolve("queuectl.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    state TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    locked_by TEXT DEFAULT NULL,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'dead'))
  );
`);

const enqueueStmt = db.prepare(`
  INSERT INTO jobs (id, command, max_retries)
  VALUES (?, ?, ?);
`);

const claimStmt = db.prepare(`
  SELECT * FROM jobs
  WHERE (state = 'pending' OR (state = 'failed' AND run_at <= CURRENT_TIMESTAMP))
  ORDER BY created_at ASC
  LIMIT 1;
`);

const claimUpdateStmt = db.prepare(`
  UPDATE jobs
  SET state = 'processing',
      locked_by = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
`);

const completeStmt = db.prepare(`
  UPDATE jobs
  SET state = 'completed',
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
`);

const failStmtDead = db.prepare(`
  UPDATE jobs
  SET state = 'dead',
      attempts = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
`);

const failStmtRetry = db.prepare(`
  UPDATE jobs
  SET state = 'failed',
      attempts = ?,
      run_at = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
`);

const recoverStmt = db.prepare(`
  UPDATE jobs
  SET state = 'pending',
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE state = 'processing'
    AND updated_at < datetime('now', '-' || ? || ' seconds');
`);

export function enqueueJob(
  id: string,
  command: string,
  maxRetries: number = 3
): void {
  enqueueStmt.run(id, command, maxRetries);
}

export function claimNextJob(workerId: string): Job | null {
  const claimTransaction = db.transaction(() => {
    const row = claimStmt.get() as Job | undefined;
    if (!row) return null;
    claimUpdateStmt.run(workerId, row.id);
    return { ...row, state: "processing" as const, locked_by: workerId };
  });
  return claimTransaction();
}

export function getJobById(id: string): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  return row ?? null;
}

export function completeJob(id: string): void {
  completeStmt.run(id);
}

const heartbeatStmt = db.prepare(`
  UPDATE jobs
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
`);

export function updateHeartbeat(id: string): void {
  heartbeatStmt.run(id);
}

function formatSqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function failJob(
  id: string,
  attempts: number,
  backoffBase: number = 2
): void {
  const job = db.prepare("SELECT max_retries FROM jobs WHERE id = ?").get(id) as
    | { max_retries: number }
    | undefined;

  if (!job) throw new Error(`Job ${id} not found`);

  if (attempts >= job.max_retries) {
    failStmtDead.run(attempts, id);
  } else {
    const delay = Math.pow(backoffBase, attempts);
    const runAt = formatSqlTimestamp(new Date(Date.now() + delay * 1000));
    failStmtRetry.run(attempts, runAt, id);
  }
}

export function recoverStaleJobs(timeoutSeconds: number = 60): number {
  const result = recoverStmt.run(timeoutSeconds);
  return result.changes;
}

export function listJobs(state?: string): Job[] {
  if (state) {
    return db
      .prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC")
      .all(state) as Job[];
  }
  return db
    .prepare("SELECT * FROM jobs ORDER BY created_at ASC")
    .all() as Job[];
}

export function resetDeadJob(id: string): void {
  const job = db
    .prepare("SELECT state FROM jobs WHERE id = ?")
    .get(id) as { state: string } | undefined;
  if (!job) throw new Error(`Job ${id} not found`);
  if (job.state !== "dead")
    throw new Error(`Job ${id} is not dead (state: ${job.state})`);
  db.prepare(
    "UPDATE jobs SET state = 'pending', attempts = 0, run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
}

export function getJobCounts(): Record<string, number> {
  const rows = db
    .prepare("SELECT state, COUNT(*) as count FROM jobs GROUP BY state")
    .all() as { state: string; count: number }[];
  const counts: Record<string, number> = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    dead: 0,
  };
  for (const row of rows) {
    counts[row.state] = row.count;
  }
  return counts;
}

export function close(): void {
  db.close();
}

export function deleteAllJobs(): void {
  db.prepare("DELETE FROM jobs").run();
}
// export function deleteAllJobs(): void {
//   db.exec("DELETE FROM jobs");
// }

