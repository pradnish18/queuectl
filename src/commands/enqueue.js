const { enqueueJob, close } = require("../core/storage");
const { loadConfig } = require("../config/configStore");

function register(program) {
  program
    .command("enqueue <input>")
    .description("Enqueue a new job (plain command or JSON string)")
    .action((input) => {
      const config = loadConfig();
      let command;
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
          console.error(`Error: ${e.message}`);
          process.exit(1);
        }
      }

      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      enqueueJob(id, command, maxRetries);
      console.log(`Enqueued job ${id}`);
      close();
    });
}

module.exports = { register };
