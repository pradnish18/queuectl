# Architectural Decisions & Design Trade-offs (`queuectl`)

## 1. Storage Engine: SQLite (`better-sqlite3`)
* **Decision:** Used SQLite as an embedded relational database via `better-sqlite3` operating in WAL (Write-Ahead Logging) mode.
* **Trade-off & Rationale:**
  * *Pros:* Requires zero external services/daemons (unlike Redis or PostgreSQL). Operating in WAL mode improves concurrent write performance and prevents readers/writers from blocking each other.
  * *Cons:* Not designed for multi-machine scaling.
  * *Verdict:* Perfect fit for a self-contained CLI job queue application that must run out of the box on any developer machine.

## 2. Atomic Job Claiming Across Processes
* **Decision:** Enforced atomic job reservation in `src/db.ts` (`claimNextJob()`) using SQLite default deferred transactions wrapping a two-statement pattern: a `SELECT` to find the oldest eligible job, followed by an `UPDATE` to transition state and lock it:
  ```sql
  SELECT * FROM jobs
  WHERE (state = 'pending' OR (state = 'failed' AND run_at <= CURRENT_TIMESTAMP))
  ORDER BY created_at ASC LIMIT 1;

  UPDATE jobs
  SET state = 'processing', locked_by = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?;
  ```
  The column used for worker identity is `locked_by` (not `worker_id`).
* **Trade-off & Rationale:**
  * *Pros:* SQLite WAL mode enforces single-writer file locking at the OS database file level. This completely eliminates race conditions where two concurrent worker processes attempt to claim the same job simultaneously.
  * *Cons:* Causes brief database file write-lock contention when scaling to a very high count of concurrent worker processes.
  * *Verdict:* Guarantees strictly at-most-once job claiming across separate OS processes without needing external locking services like Redis.

## 3. Worker Crash Recovery (SIGKILL Scenario)
* **Decision:** Implemented an automatic stale job recovery function (`recoverStaleJobs()` in `src/db.ts`) executed on worker startup and on every polling cycle with a default 60-second visibility timeout threshold.
* **Trade-off & Rationale:**
  * *Pros:* If a worker process receives a SIGKILL mid-execution, no cleanup handlers run and the job remains stuck in processing. The recovery query automatically resets jobs back to pending if their `updated_at` timestamp exceeds the 60-second visibility timeout threshold.
  * *Cons:* Long-running valid jobs that exceed 60 seconds without updating their heartbeat could theoretically be reclaimed prematurely.
  * *Verdict:* Guarantees worst-case crash recovery in 60 seconds while maintaining full system resilience against hard process crashes.

## 4. DLQ Retry Attempt Count Strategy
* **Decision:** Configured `queuectl dlq retry <id>` to explicitly reset the job attempts counter back to 0.
* **Trade-off & Rationale:**
  * *Pros:* Moving a job to dead means all automatic retries failed. When an operator manually triggers a DLQ retry, it implies the underlying external issue (e.g., system outage, invalid config) has been resolved. Resetting `attempts = 0` provides the job with a fresh budget of `max_retries` and initial exponential backoff delays.
  * *Cons:* If the operator retries a job before fixing the underlying root cause, the job will consume its full retry quota all over again before returning to DLQ.
  * *Verdict:* Aligns with standard production queue design by giving manually retried jobs a clean execution lifecycle.

## 5. Cross-Process Worker Management (worker stop)
* **Decision:** Maintained active worker Process IDs (PIDs) in a `.workers.json` lockfile to facilitate cross-process signaling for `queuectl worker stop`.
* **Trade-off & Rationale:**
  * *Pros:* Allows commands executed in a completely separate terminal session to locate live worker processes and send SIGTERM signals via `process.kill(pid, 'SIGTERM')`.
  * *Cons:* Requires stale PID file cleanup logic when workers crash unexpectedly (handled during startup/shutdown sweeps).
  * *Verdict:* Simple and reliable approach chosen over UNIX domain sockets (which have OS compatibility edge cases) and DB polling tables (which add unnecessary database read contention during execution).

## 6. Graceful Shutdown Contract
* **Decision:** Implemented custom signal listeners (`SIGINT`, `SIGTERM`) on worker processes.
* **Trade-off & Rationale:**
  * *Pros:* When a termination signal is received, the worker flags `isShuttingDown = true` and waits for active `child_process.exec` instances to finish recording their final status (`completed` or `failed`) before exiting with status `0`.
  * *Cons:* Worker shutdown can take up to the length of the currently executing job.
  * *Verdict:* Ensures no job is left in a corrupted or orphaned state due to standard SIGINT interrupts.

## 7. Configuration Storage (`.queuectlrc`)
* **Decision:** Stored runtime configurations (`max-retries`, `backoff-base`) in a local `.queuectlrc` JSON file in the working directory.
* **Trade-off & Rationale:**
  * *Pros:* Decouples configuration reads/writes from the database engine. Easy for developers and CI scripts to inspect or edit directly.
  * *Cons:* Requires file system permission checks in restricted environments.
  * *Verdict:* Keeps config management simple and independent from the database lifecycle.

## 8. Priority Queue Extensibility
* **Decision:** Structured job schema and claim queries to ensure straightforward integration of job priority levels in future iterations.
* **Trade-off & Rationale:**
  * *Pros:* Core job lifecycle states (`pending`, `processing`), atomic transaction locks, and signaling mechanisms survive completely unchanged.
  * *Cons:* Requires a database schema migration to add a priority integer column, an updated `queuectl enqueue --priority` CLI option, and modifying the claim query ordering from `ORDER BY created_at ASC` to `ORDER BY priority DESC, created_at ASC`.
  * *Verdict:* Minimizes breaking changes by isolating future priority queue updates strictly to the schema definition and claim query sorting clause.
