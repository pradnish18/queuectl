const { exec } = require("child_process");

function execCommand(command) {
  return new Promise((resolve, reject) => {
    const child = exec(command);
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => reject(err));
  });
}

module.exports = { execCommand };
