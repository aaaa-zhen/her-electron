const EventEmitter = require("events");
const { execFile } = require("child_process");
const os = require("os");

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, ...opts }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

function clipText(text, limit = 120) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

class EnvironmentMonitor extends EventEmitter {
  constructor({ intervalMs = 5 * 60 * 1000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.snapshot = null;
    this._collecting = false;
  }

  start() {
    if (this.timer) return;
    // First collect after 3s, then every intervalMs
    setTimeout(() => this.collect(), 3000);
    this.timer = setInterval(() => this.collect(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  async collect() {
    if (this._collecting) return;
    this._collecting = true;

    try {
      const [wifi, nowPlaying, recentFiles, activeApps] = await Promise.all([
        this._getWifi(),
        this._getNowPlaying(),
        this._getRecentFiles(),
        this._getActiveApps(),
      ]);

      const prev = this.snapshot;
      this.snapshot = {
        wifi,
        nowPlaying,
        recentFiles,
        activeApps,
        collectedAt: new Date().toISOString(),
      };

      // Emit if something meaningful changed
      if (prev && prev.wifi !== wifi && wifi) {
        this.emit("change", { kind: "wifi", value: wifi });
      }
      if (prev && nowPlaying && prev.nowPlaying !== nowPlaying) {
        this.emit("change", { kind: "nowPlaying", value: nowPlaying });
      }
    } catch (_) {
    } finally {
      this._collecting = false;
    }
  }

  async _getWifi() {
    if (process.platform !== "darwin") return "";
    // macOS 15+ uses `airport` or `networksetup`
    const raw = await execAsync(
      "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
      ["-I"]
    );
    if (raw) {
      const match = raw.match(/\bSSID:\s*(.+)/i);
      if (match) return match[1].trim();
    }
    // Fallback
    const fallback = await execAsync("networksetup", ["-getairportnetwork", "en0"]);
    const m2 = fallback.match(/Current Wi-Fi Network:\s*(.+)/i);
    return m2 ? m2[1].trim() : "";
  }

  async _getNowPlaying() {
    if (process.platform !== "darwin") return "";

    // Try Apple Music first
    const musicScript = `
      tell application "System Events"
        if not (exists process "Music") then return ""
      end tell
      tell application "Music"
        if player state is playing then
          set t to name of current track
          set a to artist of current track
          return t & " - " & a
        end if
      end tell
      return ""
    `;
    const music = await execAsync("osascript", ["-e", musicScript]);
    if (music) return clipText(music, 100);

    // Try Spotify
    const spotifyScript = `
      tell application "System Events"
        if not (exists process "Spotify") then return ""
      end tell
      tell application "Spotify"
        if player state is playing then
          set t to name of current track
          set a to artist of current track
          return t & " - " & a
        end if
      end tell
      return ""
    `;
    const spotify = await execAsync("osascript", ["-e", spotifyScript]);
    return clipText(spotify, 100);
  }

  async _getRecentFiles() {
    if (process.platform !== "darwin") return [];
    // Spotlight: files modified in last 2 hours, excluding system/cache dirs
    const raw = await execAsync("mdfind", [
      "-onlyin", os.homedir(),
      `kMDItemContentModificationDate >= $time.now(-7200) && kMDItemContentType != com.apple.folder`,
    ], { timeout: 8000 });

    if (!raw) return [];

    const home = os.homedir();
    const ignoreDirs = ["/Library/", "/node_modules/", "/.git/", "/.Trash/", "/Cache", "/cache/", "/Logs/", "/.cache/"];

    return raw.split("\n")
      .filter((line) => {
        if (!line) return false;
        const rel = line.startsWith(home) ? line.slice(home.length) : line;
        return !ignoreDirs.some((d) => rel.includes(d));
      })
      .slice(0, 15)
      .map((fullPath) => {
        const rel = fullPath.startsWith(home) ? `~${fullPath.slice(home.length)}` : fullPath;
        return clipText(rel, 100);
      });
  }

  async _getActiveApps() {
    if (process.platform !== "darwin") return [];
    const script = `
      tell application "System Events"
        set appList to ""
        repeat with p in (every process whose background only is false)
          set appList to appList & name of p & "\\n"
        end repeat
        return appList
      end tell
    `;
    const raw = await execAsync("osascript", ["-e", script], { timeout: 6000 });
    if (!raw) return [];

    const ignoreApps = new Set(["Finder", "Electron", "Her", "SystemUIServer", "Spotlight", "loginwindow", "Control Center"]);
    return raw.split("\n")
      .map((name) => name.trim())
      .filter((name) => name && !ignoreApps.has(name))
      .slice(0, 12);
  }
}

module.exports = { EnvironmentMonitor };
