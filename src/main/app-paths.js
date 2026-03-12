const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { app } = require("electron");

/**
 * Electron GUI apps don't inherit the user's shell PATH.
 * Resolve the real PATH so CLI tools (ffmpeg, yt-dlp, etc.) are available.
 */
function fixPath() {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const shellPath = execSync(`${shell} -ilc 'echo -n $PATH'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    if (shellPath) {
      process.env.PATH = shellPath;
    }
  } catch (_) {
    // Fallback: append common tool locations
    const extras = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      path.join(process.env.HOME || "", ".local/bin"),
    ];
    const current = process.env.PATH || "";
    const missing = extras.filter((p) => !current.includes(p));
    if (missing.length) {
      process.env.PATH = current + ":" + missing.join(":");
    }
  }
}

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

  fixPath();

  return { dataDir, sharedDir, envFile };
}

module.exports = { ensureAppPaths };
