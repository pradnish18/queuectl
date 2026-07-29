const { execCommand } = require("./executor");
const {
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  updateHeartbeat,
  close,
} = require("./storage");
const { loadConfig } = require("../config/configStore");

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 10000;

let isShuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLoop(workerId) {
  workerId = workerId || WORKER_ID;
  const config = loadConfig();
  console.log(`[${workerId}] Worker started`);

  while (true) {
    recoverStaleJobs(30);

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
        failJob(job.id, newAttempts, config["backoff-base"]);
        console.log(`[${workerId}] Job ${job.id} failed (exit code ${code}, attempt ${newAttempts})`);
      }
    } catch (err) {
      clearInterval(heartbeat);
      const newAttempts = job.attempts + 1;
      failJob(job.id, newAttempts, config["backoff-base"]);
      console.log(`[${workerId}] Job ${job.id} failed (error: ${err}, attempt ${newAttempts})`);
    }

    if (isShuttingDown) {
      close();
      process.exit(0);
    }
  }
}

function handleSignal(signal) {
  console.log(`[${WORKER_ID}] Received ${signal}, shutting down...`);
  isShuttingDown = true;
}

if (process.env.QUEUECTL_WORKER === "true") {
  // Suppress EPIPE errors when parent closes stdout during shutdown
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  runWorkerLoop().catch((err) => {
    console.error(`[${WORKER_ID}] Worker crashed:`, err);
    close();
    process.exit(1);
  });
}
