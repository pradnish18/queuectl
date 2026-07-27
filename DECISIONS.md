# Architectural Decisions & Design Trade-offs (`queuectl`)

## 1. Storage Engine: SQLite (`better-sqlite3`)
* **Decision:** Used SQLite as an embedded relational database via `better-sqlite3` operating in WAL (Write-Ahead Logging) mode.
* **Trade-off & Rationale:**
  * *Pros:* Requires zero external services/daemons (unlike Redis or PostgreSQL). Operating in WAL mode improves concurrent write performance and prevents readers/writers from blocking each other.
  * *Cons:* Not designed for multi-machine scaling.
  * *Verdict:* Perfect fit for a self-contained CLI job queue application that must run out of the box on any developer machine.

## 2. Concurrency Control & Job Claiming
* **Decision:** Enforced atomic job reservation using SQLite immediate transactions (`BEGIN IMMEDIATE`) paired with `WHERE state = 'pending'` check and explicit row locking using worker ID and timestamps.
* **Trade-off & Rationale:**
  * *Pros:* Eliminates race conditions where two workers attempt to claim the same job simultaneously.
  * *Cons:* Brief database-level lock contention under high worker counts.
  * *Verdict:* Guarantees strictly at-most-once execution assignment per claim tick.

## 3. Configuration Storage (`.queuectlrc`)
* **Decision:** Stored runtime configurations (`max-retries`, `backoff-base`) in a local `.queuectlrc` JSON file in the working directory.
* **Trade-off & Rationale:**
  * *Pros:* Decouples configuration reads/writes from the database engine. Easy for developers and CI scripts to inspect or edit directly.
  * *Cons:* Requires file system permission checks in restricted environments.

## 4. Cross-Process Worker Management
* **Decision:** Maintained active worker Process IDs (PIDs) in a `.workers.json` lockfile to facilitate cross-process signaling for `queuectl worker stop`.
* **Trade-off & Rationale:**
  * *Pros:* Allows commands executed in a completely separate terminal session to locate active worker processes and send `SIGTERM` signals.
  * *Cons:* Requires file cleanup on unexpected worker crashes (handled during startup/shutdown sweeps).

## 5. Graceful Shutdown Contract
* **Decision:** Implemented custom signal listeners (`SIGINT`, `SIGTERM`) on worker processes.
* **Trade-off & Rationale:**
  * *Pros:* When a termination signal is received, the worker flags `isShuttingDown = true` and waits for active `child_process.exec` instances to finish recording their final status (`completed` or `failed`) before exiting with status `0`.
  * *Cons:* Worker shutdown can take up to the length of the currently executing job.
  * *Verdict:* Ensures no job is left in a corrupted or orphaned state due to standard SIGINT interrupts.