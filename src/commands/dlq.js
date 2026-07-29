const { listJobs, resetDeadJob, close } = require("../core/storage");

function pad(str, len) {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function printJobTable(jobs) {
  const header = [pad("ID", 30), pad("State", 12), pad("Attempts", 8), pad("Command", 40)].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const job of jobs) {
    console.log([pad(job.id, 30), pad(job.state, 12), pad(String(job.attempts), 8), pad(job.command, 40)].join("  "));
  }
}

function register(program) {
  const dlqCmd = program.command("dlq").description("Dead letter queue management");

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
    .action((jobId) => {
      try {
        resetDeadJob(jobId);
        console.log(`Reset job ${jobId} to pending`);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      close();
    });
}

module.exports = { register };
