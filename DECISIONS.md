# Architectural Decisions & Design Trade-offs (`queuectl`)

## 1. Atomic Job Claiming Across Processes

**Decision:** Enforced atomic job reservation in `src/db.ts` (`claimNextJob()`) using SQLite immediate transactions (`BEGIN IMMEDIATE`) paired with an atomic `UPDATE` query:

```sql
UPDATE jobs
SET state = 'processing',
    worker_id = ?,
    updated_at = ?
WHERE id = (
    SELECT id
    FROM jobs
    WHERE state = 'pending'
      AND run_at <= ?
    ORDER BY created_at ASC
    LIMIT 1
)
RETURNING *;
```

**Trade-off & Rationale:**

**Pros:**
- SQLite WAL mode enforces single-writer file locking at the OS database file level.
- Completely eliminates race conditions where two concurrent worker processes attempt to claim the same job simultaneously.

**Cons:**
- Causes brief database file write-lock contention when scaling to a very high count of concurrent worker processes.

**Verdict:**
- Guarantees strictly at-most-once job claiming across separate OS processes without requiring external locking services such as Redis.

---

## 2. Worker Crash Recovery (SIGKILL Scenario)

**Decision:** Implemented an automatic stale job recovery function (`recoverStaleJobs()` in `src/db.ts`) executed on worker startup and during every polling cycle.

**Trade-off & Rationale:**

**Pros:**
- If a worker process receives a `SIGKILL` during execution, no cleanup handlers run and the job remains stuck in the `processing` state.
- The recovery query automatically resets jobs back to `pending` when their `updated_at` timestamp exceeds the 30-second visibility timeout.

**Cons:**
- Long-running valid jobs that exceed 30 seconds without updating their heartbeat could theoretically be reclaimed prematurely.

**Verdict:**
- Guarantees worst-case crash recovery within 30 seconds (well inside the required 60-second limit) while maintaining resilience against hard process crashes.

---

## 3. DLQ Retry Attempt Count Strategy

**Decision:** Configured `queuectl dlq retry <id>` to explicitly reset the job `attempts` counter back to `0`.

**Trade-off & Rationale:**

**Pros:**
- Moving a job to the Dead Letter Queue means all automatic retries have already failed.
- When an operator manually retries a DLQ job, it implies the underlying issue has been resolved.
- Resetting `attempts = 0` provides the job with a fresh `max_retries` budget and restores the initial exponential backoff schedule.

**Cons:**
- If the operator retries the job before fixing the root cause, the job consumes its full retry budget again before returning to the DLQ.

**Verdict:**
- Aligns with standard production queue systems by treating manually retried jobs as a fresh execution lifecycle.

---

## 4. Cross-Process Worker Management (`worker stop`)

**Decision:** Maintained active worker Process IDs (PIDs) in a `.workers.json` lockfile to facilitate cross-process signaling for `queuectl worker stop`.

**Trade-off & Rationale:**

**Pros:**
- Allows commands executed from separate terminal sessions to locate running worker processes and send `SIGTERM` signals using `process.kill(pid, 'SIGTERM')`.

**Cons:**
- Requires stale PID cleanup logic when workers crash unexpectedly (handled during startup and shutdown sweeps).

**Verdict:**
- Chosen as a simple and reliable approach over UNIX domain sockets (which have OS compatibility issues) and database polling tables (which introduce unnecessary database read contention).

---

## 5. Priority Queue Extensibility

**Decision:** Structured the job schema and claim queries so that job priority levels can be integrated with minimal architectural changes in future versions.

**Trade-off & Rationale:**

**Pros:**
- Existing job lifecycle states (`pending`, `processing`), atomic transaction locking (`BEGIN IMMEDIATE`), and worker signaling remain unchanged.
- Future support requires only extending the schema and modifying query ordering.

**Cons:**
- Requires:
  - a database migration to add a `priority` integer column,
  - a new `queuectl enqueue --priority` CLI option,
  - updating the claim query ordering from:

```sql
ORDER BY created_at ASC
```

to:

```sql
ORDER BY priority DESC, created_at ASC
```

**Verdict:**
- Minimizes breaking changes by isolating priority queue support strictly to the schema definition and claim query sorting logic.
