const { exec } = require("child_process");

function execAsync(command, options = {}) {
  let childProcess;
  const promise = new Promise((resolve) => {
    childProcess = exec(command, {
      encoding: "utf-8",
      timeout: options.timeout || 120000,
      cwd: options.cwd,
      maxBuffer: 5 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve((stdout || "") + (stderr || error.message || "Command failed"));
        return;
      }
      resolve(stdout || stderr || "");
    });
  });
  promise.child = childProcess;
  return promise;
}

module.exports = { execAsync };
