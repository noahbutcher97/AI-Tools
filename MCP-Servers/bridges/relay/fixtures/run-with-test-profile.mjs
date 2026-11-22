import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const usage = "Usage: node run-with-test-profile.mjs -- <program> [arguments...]\n" +
  "Runs the program with a disposable home and temp directory. Cleanup covers only this run.";

function privateRoot() {
  const home = fs.realpathSync.native(os.userInfo().homedir);
  const root = path.join(home, ".ai-tools-test-runs");
  if (process.platform === "win32") {
    // Reuse the relay's qualified owner-only ACL creation and verification.
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const helper = fileURLToPath(new URL("../private-spool.ps1", import.meta.url));
    const checked = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
      input: path.join(root, ".private"), timeout: 10000, windowsHide: true,
    });
    if (checked.status !== 0) throw new Error("Could not prepare a private test root.");
  } else {
    try { fs.mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error("Test root must be an owner-only directory.");
    }
  }
  return root;
}

function directoryIdentity(dir) {
  const stat = fs.lstatSync(dir, { bigint: true });
  if (!stat.isDirectory() || !stat.ino || path.relative(dir, fs.realpathSync.native(dir)) !== "") {
    throw new Error("Test directory identity is unavailable or redirected.");
  }
  return [stat.dev, stat.ino].join("/");
}

function run([separator, command, ...args]) {
  if (separator === "--help" || separator === "-h") { console.log(usage); return 0; }
  if (separator !== "--" || !command) { console.error(usage); return 2; }
  const root = privateRoot();
  const rootId = directoryIdentity(root);
  const profile = fs.mkdtempSync(path.join(root, "run-"));
  console.error("Disposable test profile:", profile);
  const profileId = directoryIdentity(profile);
  try {
    const temp = path.join(profile, "tmp");
    fs.mkdirSync(temp, { mode: 0o700 });
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, TMPDIR: temp, TMP: temp, TEMP: temp };
    for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      env[key] = path.join(profile, key.toLowerCase());
      fs.mkdirSync(env[key], { mode: 0o700 });
    }
    const child = spawnSync(command === "node" ? process.execPath : command, args, { env, stdio: "inherit", shell: false });
    if (child.error) throw child.error;
    return child.status ?? (128 + (os.constants.signals[child.signal] ?? 0));
  } finally {
    if (path.dirname(profile) !== root || directoryIdentity(root) !== rootId || directoryIdentity(profile) !== profileId) {
      throw new Error("Cleanup refused because the original test directory changed.");
    }
    fs.rmSync(profile, { recursive: true, maxRetries: 3 });
  }
}

try { process.exitCode = run(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
