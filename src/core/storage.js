const Database = require("better-sqlite3");
const path = require("path");
const { SCHEMA, validateJobId, validateCommand, validateMaxRetries } = require("./jobModel");
const { calculateDelay, formatSqlTimestamp } = require("./retry");

const DB_PATH = process.env.QUEUECTL_DB_PATH || path.resolve("queuectl.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(SCHEMA);

const enqueueStmt = db.prepare("INSERT INTO jobs (id, command, max_retries) VALUES (?, ?, ?);");

const claimStmt = db.prepare(`
  UPDATE jobs
  SET state = 'processing', locked_by = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = (
    SELECT id FROM jobs
    WHERE (state = 'pending' OR (state = 'failed' AND run_at <= CURRENT_TIMESTAMP))
    ORDER BY created_at ASC
    LIMIT 1
  )
  RETURNING *;
`);

const completeStmt = db.prepare("UPDATE jobs SET state = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?;");
const failStmtDead = db.prepare("UPDATE jobs SET state = 'dead', attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;");
const failStmtRetry = db.prepare("UPDATE jobs SET state = 'failed', attempts = ?, run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;");
const recoverStmt = db.prepare("UPDATE jobs SET state = 'pending', locked_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE state = 'processing' AND CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER) >= ?;");
const heartbeatStmt = db.prepare("UPDATE jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?;");
const getByIdStmt = db.prepare("SELECT * FROM jobs WHERE id = ?;");
const getMaxRetriesStmt = db.prepare("SELECT max_retries FROM jobs WHERE id = ?;");
const getStateStmt = db.prepare("SELECT state FROM jobs WHERE id = ?;");
const resetStmt = db.prepare("UPDATE jobs SET state = 'pending', attempts = 0, run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?;");
const deleteAllStmt = db.prepare("DELETE FROM jobs;");

const countStmt = db.prepare("SELECT state, COUNT(*) as count FROM jobs GROUP BY state;");
const listAllStmt = db.prepare("SELECT * FROM jobs ORDER BY created_at ASC;");
const listByStateStmt = db.prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC;");

function enqueueJob(id, command, maxRetries) {
  validateJobId(id);
  validateCommand(command);
  validateMaxRetries(maxRetries);
  enqueueStmt.run(id, command, maxRetries != null ? maxRetries : 3);
}

function claimNextJob(workerId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = claimStmt.get(workerId);
    db.exec("COMMIT");
    return row || null;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function getJobById(id) {
  return getByIdStmt.get(id) || null;
}

function completeJob(id) {
  completeStmt.run(id);
}

function updateHeartbeat(id) {
  heartbeatStmt.run(id);
}

function failJob(id, attempts, backoffBase) {
  const job = getMaxRetriesStmt.get(id);
  if (!job) throw new Error(`Job ${id} not found`);
  if (attempts >= job.max_retries) {
    failStmtDead.run(attempts, id);
  } else {
    const delay = calculateDelay(attempts, backoffBase || 2);
    const runAt = formatSqlTimestamp(new Date(Date.now() + delay * 1000));
    failStmtRetry.run(attempts, runAt, id);
  }
}

function recoverStaleJobs(timeoutSeconds) {
  const result = recoverStmt.run(timeoutSeconds != null ? timeoutSeconds : 30);
  return result.changes;
}

function listJobs(state) {
  if (state) return listByStateStmt.all(state);
  return listAllStmt.all();
}

function resetDeadJob(id) {
  const job = getStateStmt.get(id);
  if (!job) throw new Error(`Job ${id} not found`);
  if (job.state !== "dead") throw new Error(`Job ${id} is not dead (state: ${job.state})`);
  resetStmt.run(id);
}

function getJobCounts() {
  const rows = countStmt.all();
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

function close() {
  db.close();
}

function deleteAllJobs() {
  deleteAllStmt.run();
}

module.exports = {
  enqueueJob,
  claimNextJob,
  getJobById,
  completeJob,
  updateHeartbeat,
  failJob,
  recoverStaleJobs,
  listJobs,
  resetDeadJob,
  getJobCounts,
  close,
  deleteAllJobs,
};
