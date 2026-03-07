const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function ensureAppPaths() {
  const dataDir = path.join(app.getPath("userData"), "data");
  const sharedDir = path.join(app.getPath("userData"), "shared");
  const envFile = path.join(app.getPath("userData"), ".env");

  [dataDir, sharedDir].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, `# Her Desktop Configuration
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=
PORT=13900
`);
  }

  process.env.HER_DATA_DIR = dataDir;
  process.env.HER_SHARED_DIR = sharedDir;
  process.env.HER_ENV_FILE = envFile;
  process.env.HER_IS_ELECTRON = "1";

  require("dotenv").config({ path: envFile });

  return { dataDir, sharedDir, envFile };
}

module.exports = { ensureAppPaths };
