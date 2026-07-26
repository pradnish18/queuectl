import { exec as cpExec, fork, ChildProcess } from "child_process";
import path from "path";
import {
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  updateHeartbeat,
  close,
} from "./db";

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 10000;

let isShuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCommand(command: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = cpExec(command);
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => reject(err));
  });
}

export async function runWorkerLoop(workerId: string = WORKER_ID): Promise<void> {
  console.log(`[${workerId}] Worker started`);

  while (true) {
    recoverStaleJobs(60);

    const job = claimNextJob(workerId);

    if (!job) {
      if (isShuttingDown) {
        close();
        process.exit(0);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(`[${workerId}] Executing job ${job.id}: ${job.command}`);

    const heartbeat = setInterval(() => {
      updateHeartbeat(job.id);
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const code = await execCommand(job.command);
      clearInterval(heartbeat);

      if (code === 0) {
        completeJob(job.id);
        console.log(`[${workerId}] Job ${job.id} completed`);
      } else {
        const newAttempts = job.attempts + 1;
        failJob(job.id, newAttempts, 2);
        console.log(
          `[${workerId}] Job ${job.id} failed (exit code ${code}, attempt ${newAttempts})`
        );
      }
    } catch (err) {
      clearInterval(heartbeat);
      const newAttempts = job.attempts + 1;
      failJob(job.id, newAttempts, 2);
      console.log(
        `[${workerId}] Job ${job.id} failed (error: ${err}, attempt ${newAttempts})`
      );
    }

    if (isShuttingDown) {
      close();
      process.exit(0);
    }
  }
}

function handleSignal(signal: string): void {
  console.log(`[${WORKER_ID}] Received ${signal}, shutting down...`);
  isShuttingDown = true;
}

if (process.env.QUEUECTL_WORKER === "true") {
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  runWorkerLoop().catch((err) => {
    console.error(`[${WORKER_ID}] Worker crashed:`, err);
    close();
    process.exit(1);
  });
}

export function startWorkers(count: number): ChildProcess[] {
  const children: ChildProcess[] = [];
  for (let i = 0; i < count; i++) {
    const child = fork(__filename, {
      env: { ...process.env, QUEUECTL_WORKER: "true" },
    });
    children.push(child);
    console.log(`Spawned worker with PID ${child.pid}`);
  }
  console.log(`Started ${count} worker(s)`);
  return children;
}
