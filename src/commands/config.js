const { setConfig } = require("../config/configStore");

function register(program) {
  program
    .command("config")
    .description("Configuration management")
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key, value) => {
      try {
        setConfig(key, value);
        console.log(`Set ${key} = ${value}`);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
