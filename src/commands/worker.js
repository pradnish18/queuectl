const path = require("path");
const { fork } = require("child_process");
const { close } = require("../core/storage");
const { loadConfig } = require("../config/configStore");

const WORKERS_FILE = path.resolve(".workers.json");

function writeWorkerPids(pids) {
  require("fs").writeFileSync(
    WORKERS_FILE,
    JSON.stringify({ pids, started_at: new Date().toISOString() }, null, 2) + "\n"
  );
}

function readWorkerPids() {
  try {
    const raw = require("fs").readFileSync(WORKERS_FILE, "utf-8");
    return JSON.parse(raw).pids ?? [];
  } catch {
    return [];
  }
}

function removeWorkerFile() {
  try { require("fs").unlinkSync(WORKERS_FILE); } catch { /* ignore */ }
}

function startWorkers(count) {
  const children = [];
  for (let i = 0; i < count; i++) {
    const child = fork(path.join(__dirname, "..", "core", "worker.js"), {
      env: { ...process.env, QUEUECTL_WORKER: "true" },
    });
    children.push(child);
    console.log(`Spawned worker with PID ${child.pid}`);
  }
  console.log(`Started ${count} worker(s)`);
  return children;
}

function register(program) {
  const workerCmd = program.command("worker").description("Manage worker processes");

  workerCmd
    .command("start")
    .description("Start worker processes in the foreground")
    .option("-c, --count <N>", "Number of workers to start", "1")
    .action(async (opts) => {
      const count = parseInt(opts.count, 10);
      if (isNaN(count) || count < 1) {
        console.error("Error: --count must be a positive integer");
        process.exit(1);
      }

      const children = startWorkers(count);
      const pids = children.map((c) => c.pid).filter((p) => p !== undefined);
      writeWorkerPids(pids);

      let shuttingDown = false;

      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\nShutting down workers...");
        for (const child of children) child.kill("SIGTERM");
        await Promise.all(
          children.map((child) => new Promise((resolve) => child.on("exit", () => resolve())))
        );
        removeWorkerFile();
        close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await Promise.all(
        children.map((child) => new Promise((resolve) => child.on("exit", () => resolve())))
      );

      removeWorkerFile();
      close();
    });

  workerCmd
    .command("stop")
    .description("Stop all active workers by sending SIGTERM")
    .action(() => {
      const pids = readWorkerPids();
      if (pids.length === 0) {
        console.log("No active workers found.");
        return;
      }
      let stopped = 0;
      for (const pid of pids) {
        try { process.kill(pid, "SIGTERM"); stopped++; } catch { /* ignore */ }
      }
      removeWorkerFile();
      console.log(`Sent SIGTERM to ${stopped} worker(s).`);
    });
}

module.exports = { register, startWorkers };
