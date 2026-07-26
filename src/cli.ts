#!/usr/bin/env node

import { Command } from "commander";
import fs from "fs";
import path from "path";
import { ChildProcess } from "child_process";
import { enqueueJob, listJobs, resetDeadJob, getJobCounts, close } from "./db";
import { loadConfig, setConfig } from "./config";
import { startWorkers } from "./worker";

const WORKERS_FILE = path.resolve(".workers.json");

function writeWorkerPids(pids: number[]): void {
  fs.writeFileSync(
    WORKERS_FILE,
    JSON.stringify({ pids, started_at: new Date().toISOString() }, null, 2) +
      "\n"
  );
}

function readWorkerPids(): number[] {
  try {
    const raw = fs.readFileSync(WORKERS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return data.pids ?? [];
  } catch {
    return [];
  }
}

function removeWorkerFile(): void {
  try {
    fs.unlinkSync(WORKERS_FILE);
  } catch {
    // ignore
  }
}

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function printJobTable(jobs: ReturnType<typeof listJobs>): void {
  const header = [
    pad("ID", 30),
    pad("State", 12),
    pad("Attempts", 8),
    pad("Command", 40),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const job of jobs) {
    console.log(
      [
        pad(job.id, 30),
        pad(job.state, 12),
        pad(String(job.attempts), 8),
        pad(job.command, 40),
      ].join("  ")
    );
  }
}

const program = new Command();

program
  .name("queuectl")
  .description("Multi-process background job queue CLI")
  .version("0.1.0");

program
  .command("enqueue <input>")
  .description("Enqueue a new job (plain command or JSON string)")
  .action((input: string) => {
    const config = loadConfig();
    let command: string;
    let maxRetries = config["max-retries"];

    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed.command === "string") {
        command = parsed.command;
        if (typeof parsed.max_retries === "number") {
          maxRetries = parsed.max_retries;
        }
      } else {
        throw new Error("JSON must contain a 'command' field");
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        command = input;
      } else {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    enqueueJob(id, command!, maxRetries);
    console.log(`Enqueued job ${id}`);
    close();
  });

const workerCmd = program
  .command("worker")
  .description("Manage worker processes");

workerCmd
  .command("start")
  .description("Start worker processes in the foreground")
  .option("-c, --count <N>", "Number of workers to start", "1")
  .action(async (opts: { count: string }) => {
    const count = parseInt(opts.count, 10);
    if (isNaN(count) || count < 1) {
      console.error("Error: --count must be a positive integer");
      process.exit(1);
    }

    const children: ChildProcess[] = startWorkers(count);
    const pids = children
      .map((c) => c.pid)
      .filter((p): p is number => p !== undefined);
    writeWorkerPids(pids);

    let shuttingDown = false;

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\nShutting down workers...");

      for (const child of children) {
        child.kill("SIGTERM");
      }

      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              child.on("exit", () => resolve());
            })
        )
      );

      removeWorkerFile();
      close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on("exit", () => resolve());
          })
        )
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
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
      } catch {
        // process already dead
      }
    }

    removeWorkerFile();
    console.log(`Sent SIGTERM to ${stopped} worker(s).`);
  });

program
  .command("list")
  .description("List jobs")
  .option("-s, --state <state>", "Filter by state")
  .option("--json", "Output raw JSON array")
  .action((opts: { state?: string; json?: boolean }) => {
    const jobs = listJobs(opts.state);

    if (opts.json) {
      process.stdout.write(JSON.stringify(jobs));
    } else {
      if (jobs.length === 0) {
        console.log("No jobs found.");
      } else {
        printJobTable(jobs);
      }
    }
    close();
  });

const dlqCmd = program
  .command("dlq")
  .description("Dead letter queue management");

dlqCmd
  .command("list")
  .description("List dead jobs")
  .action(() => {
    const jobs = listJobs("dead");
    if (jobs.length === 0) {
      console.log("No dead jobs.");
    } else {
      printJobTable(jobs);
    }
    close();
  });

dlqCmd
  .command("retry <job_id>")
  .description("Reset a dead job back to pending")
  .action((jobId: string) => {
    try {
      resetDeadJob(jobId);
      console.log(`Reset job ${jobId} to pending`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    close();
  });

program
  .command("status")
  .description("Show job summary and active workers")
  .action(() => {
    const counts = getJobCounts();
    const pids = readWorkerPids();

    console.log("Jobs:");
    console.log(`  Pending:    ${counts.pending}`);
    console.log(`  Processing: ${counts.processing}`);
    console.log(`  Completed:  ${counts.completed}`);
    console.log(`  Failed:     ${counts.failed}`);
    console.log(`  Dead:       ${counts.dead}`);
    console.log();

    if (pids.length > 0) {
      console.log(`Workers: ${pids.length} active (PIDs: ${pids.join(", ")})`);
    } else {
      console.log("Workers: none active");
    }
    close();
  });

const configCmd = program
  .command("config")
  .description("Configuration management");

configCmd
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action((key: string, value: string) => {
    try {
      setConfig(key, value);
      console.log(`Set ${key} = ${value}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
