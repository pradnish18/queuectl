const { listJobs, close } = require("../core/storage");

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
  program
    .command("list")
    .description("List jobs")
    .option("-s, --state <state>", "Filter by state")
    .option("--json", "Output raw JSON array")
    .action((opts) => {
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
}

module.exports = { register };
