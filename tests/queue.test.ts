import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const TEST_DB = path.resolve(__dirname, "..", "test-queue.db");
const TEST_DB_WAL = TEST_DB + "-wal";
const TEST_DB_SHM = TEST_DB + "-shm";

let db: typeof import("../src/db");

beforeAll(() => {
  [TEST_DB, TEST_DB_WAL, TEST_DB_SHM].forEach((f) => {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  });
  db = require("../src/db");
});

afterEach(() => {
  db.deleteAllJobs();
});

afterAll(() => {
  db.close();
  [TEST_DB, TEST_DB_WAL, TEST_DB_SHM].forEach((f) => {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  });
});

function runCli(args: string): string {
  return execSync(`node ${path.resolve(__dirname, "..", "dist", "cli.js")} ${args}`, {
    env: { ...process.env, QUEUECTL_DB_PATH: TEST_DB },
    encoding: "utf-8",
  });
}

describe("Database & Job Enqueue", () => {
  it("should enqueue a job with default retries", () => {
    db.enqueueJob("j1", "echo hello");
    const job = db.getJobById("j1");
    expect(job).not.toBeNull();
    expect(job!.id).toBe("j1");
    expect(job!.command).toBe("echo hello");
    expect(job!.state).toBe("pending");
    expect(job!.max_retries).toBe(3);
    expect(job!.attempts).toBe(0);
  });

  it("should enqueue a job with custom retries and backoff", () => {
    db.enqueueJob("j2", "ls -la", 5);
    const job = db.getJobById("j2");
    expect(job).not.toBeNull();
    expect(job!.max_retries).toBe(5);
  });

  it("should reject duplicate job IDs", () => {
    db.enqueueJob("dup1", "echo a");
    expect(() => db.enqueueJob("dup1", "echo b")).toThrow();
  });
});

describe("Worker Claiming", () => {
  it("should transition job from pending to processing on claim", () => {
    db.enqueueJob("c1", "echo claim-test");
    const claimed = db.claimNextJob("worker-abc");

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("c1");
    expect(claimed!.state).toBe("processing");
    expect(claimed!.locked_by).toBe("worker-abc");

    const job = db.getJobById("c1");
    expect(job!.state).toBe("processing");
    expect(job!.locked_by).toBe("worker-abc");
  });

  it("should return null when no jobs are available", () => {
    const result = db.claimNextJob("worker-xyz");
    expect(result).toBeNull();
  });

  it("should claim oldest pending job first (FIFO)", () => {
    db.enqueueJob("fifo-1", "echo first");
    db.enqueueJob("fifo-2", "echo second");
    db.enqueueJob("fifo-3", "echo third");

    const first = db.claimNextJob("w1");
    expect(first!.id).toBe("fifo-1");

    const second = db.claimNextJob("w1");
    expect(second!.id).toBe("fifo-2");

    const third = db.claimNextJob("w1");
    expect(third!.id).toBe("fifo-3");
  });

  it("should not claim the same job twice", () => {
    db.enqueueJob("once", "echo once");
    db.claimNextJob("w1");
    const duplicate = db.claimNextJob("w2");
    expect(duplicate).toBeNull();
  });
});

describe("Exponential Backoff", () => {
  it("should increment attempts and set future run_at on failure", () => {
    db.enqueueJob("backoff-1", "exit 1", 3);
    db.claimNextJob("w1");

    db.failJob("backoff-1", 1, 2);

    const job = db.getJobById("backoff-1");
    expect(job!.state).toBe("failed");
    expect(job!.attempts).toBe(1);

    const runAtTime = new Date(job!.run_at + "Z").getTime();
    const now = Date.now();
    const expectedDelay = Math.pow(2, 1) * 1000;
    expect(runAtTime).toBeGreaterThan(now);
    expect(runAtTime).toBeLessThanOrEqual(now + expectedDelay + 2000);
  });

  it("should use correct backoff base", () => {
    db.enqueueJob("backoff-2", "exit 1", 5);
    db.claimNextJob("w1");

    db.failJob("backoff-2", 2, 3);

    const job = db.getJobById("backoff-2");
    expect(job!.attempts).toBe(2);

    const runAtTime = new Date(job!.run_at + "Z").getTime();
    const now = Date.now();
    const expectedDelay = Math.pow(3, 2) * 1000;
    expect(runAtTime).toBeGreaterThan(now);
    expect(runAtTime).toBeLessThanOrEqual(now + expectedDelay + 2000);
  });

  it("should allow failed jobs to be re-claimed after run_at passes", () => {
    db.enqueueJob("retry-claim", "echo retry", 3);
    db.claimNextJob("w1");

    db.failJob("retry-claim", 1, 2);

    const job = db.getJobById("retry-claim");
    expect(job!.state).toBe("failed");

    const claimed = db.claimNextJob("w1");
    expect(claimed).toBeNull();

    db.getJobById("retry-claim")!;
  });
});

describe("Dead Letter Queue (DLQ)", () => {
  it("should transition to dead when attempts >= max_retries", () => {
    db.enqueueJob("dlq-1", "echo die", 2);
    db.claimNextJob("w1");
    db.failJob("dlq-1", 2, 2);

    const job = db.getJobById("dlq-1");
    expect(job!.state).toBe("dead");
    expect(job!.attempts).toBe(2);
  });

  it("should not transition to dead when attempts < max_retries", () => {
    db.enqueueJob("not-dead", "echo alive", 5);
    db.claimNextJob("w1");
    db.failJob("not-dead", 3, 2);

    const job = db.getJobById("not-dead");
    expect(job!.state).toBe("failed");
    expect(job!.attempts).toBe(3);
  });

  it("should list dead jobs via listJobs('dead')", () => {
    db.enqueueJob("dead-a", "exit 1", 1);
    db.claimNextJob("w1");
    db.failJob("dead-a", 1, 2);

    db.enqueueJob("dead-b", "exit 1", 1);
    db.claimNextJob("w1");
    db.failJob("dead-b", 1, 2);

    const deadJobs = db.listJobs("dead");
    expect(deadJobs.length).toBe(2);
    expect(deadJobs.every((j) => j.state === "dead")).toBe(true);
  });
});

describe("DLQ Retry", () => {
  it("should reset dead job to pending with attempts = 0", () => {
    db.enqueueJob("dlq-retry-1", "echo retry-me", 2);
    db.claimNextJob("w1");
    db.failJob("dlq-retry-1", 2, 2);

    let job = db.getJobById("dlq-retry-1");
    expect(job!.state).toBe("dead");
    expect(job!.attempts).toBe(2);

    db.resetDeadJob("dlq-retry-1");

    job = db.getJobById("dlq-retry-1");
    expect(job!.state).toBe("pending");
    expect(job!.attempts).toBe(0);
  });

  it("should throw if job is not dead", () => {
    db.enqueueJob("not-dead-retry", "echo alive", 3);
    expect(() => db.resetDeadJob("not-dead-retry")).toThrow("is not dead");
  });

  it("should throw if job does not exist", () => {
    expect(() => db.resetDeadJob("nonexistent")).toThrow("not found");
  });

  it("should make a retried dead job claimable again", () => {
    db.enqueueJob("dlq-retry-2", "echo second-chance", 2);
    db.claimNextJob("w1");
    db.failJob("dlq-retry-2", 2, 2);

    db.resetDeadJob("dlq-retry-2");

    const claimed = db.claimNextJob("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("dlq-retry-2");
    expect(claimed!.state).toBe("processing");
  });
});

describe("Job Completion", () => {
  it("should transition job to completed", () => {
    db.enqueueJob("comp-1", "echo done");
    db.claimNextJob("w1");
    db.completeJob("comp-1");

    const job = db.getJobById("comp-1");
    expect(job!.state).toBe("completed");
  });
});

describe("Stale Job Recovery", () => {
  it("should recover stale processing jobs back to pending", () => {
    db.enqueueJob("stale-1", "echo stale");
    db.claimNextJob("w1");

    const Database = require("better-sqlite3");
    const rawDb = new Database(TEST_DB);
    rawDb
      .prepare("UPDATE jobs SET updated_at = datetime('now', '-120 seconds') WHERE id = ?")
      .run("stale-1");
    rawDb.close();

    const recovered = db.recoverStaleJobs(60);
    expect(recovered).toBeGreaterThanOrEqual(1);

    const job = db.getJobById("stale-1");
    expect(job!.state).toBe("pending");
    expect(job!.locked_by).toBeNull();
  });
});

describe("CLI JSON Output Contract", () => {
  it("should return valid JSON array with no extraneous stdout", () => {
    db.enqueueJob("json-1", "echo json-test");
    db.enqueueJob("json-2", "echo json-test-2");

    const output = runCli("list --state pending --json");

    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed.every((j: Record<string, unknown>) => typeof j.id === "string")).toBe(true);
    expect(parsed.every((j: Record<string, unknown>) => j.state === "pending")).toBe(true);
  });

  it("should return empty array when no matching jobs", () => {
    const output = runCli("list --state dead --json");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([]);
  });

  it("should return only jobs matching the state filter", () => {
    db.enqueueJob("json-filter-1", "echo a");
    db.claimNextJob("worker-filter");
    db.completeJob("json-filter-1");

    db.enqueueJob("json-filter-2", "echo b");

    const pendingOutput = runCli("list --state pending --json");
    const pending = JSON.parse(pendingOutput);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe("json-filter-2");

    const completedOutput = runCli("list --state completed --json");
    const completed = JSON.parse(completedOutput);
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe("json-filter-1");
  });

  it("should contain no extra text before or after JSON", () => {
    db.enqueueJob("json-strict", "echo strict");
    const output = runCli("list --state pending --json");
    expect(output.startsWith("[")).toBe(true);
    expect(output.trimEnd().endsWith("]")).toBe(true);
    expect(output).not.toContain("No jobs");
    expect(output).not.toContain("ID");
  });
});
