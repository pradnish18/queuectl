const chalk = require("chalk");
const Table = require("cli-table3");
const { getJobCounts, close } = require("../core/storage");

const WORKERS_FILE = require("path").resolve(".workers.json");

function readWorkerPids() {
  try {
    return JSON.parse(require("fs").readFileSync(WORKERS_FILE, "utf-8")).pids ?? [];
  } catch {
    return [];
  }
}

function register(program) {
  program
    .command("status")
    .description("Show job summary and active workers")
    .action(() => {
      const counts = getJobCounts();
      const pids = readWorkerPids();

      console.log(chalk.bold.cyan("\n📊 QUEUE STATUS SUMMARY\n"));

      const stateColors = {
        pending: chalk.yellow,
        processing: chalk.blue,
        completed: chalk.green,
        failed: chalk.red,
        dead: chalk.magenta,
      };

      const table = new Table({
        head: [chalk.bold.white("Job State"), chalk.bold.white("Count")],
        style: { head: [], border: [] },
      });

      for (const [state, count] of Object.entries(counts)) {
        const color = stateColors[state] || chalk.white;
        table.push([color(state), color(String(count))]);
      }

      console.log(table.toString());
      console.log();

      if (pids.length > 0) {
        console.log(chalk.green(`Workers: ${pids.length} active`) + chalk.gray(` (PIDs: ${pids.join(", ")})`));
      } else {
        console.log(chalk.gray("Workers: none active"));
      }
      close();
    });
}

module.exports = { register };
