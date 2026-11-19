import { spawn } from "node:child_process";
import path from "node:path";

export function runProvider(command, args, { stdin, cwd, env, timeoutMs = 35000, maxBytes = 128 * 1024 } = {}) {
  const windows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, detached: !windows,
      env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let size = 0, aborted = false;
    function abort() {
      if (aborted) return;
      aborted = true;
      if (!child.pid || child.exitCode !== null) return;
      if (windows) {
        const kill = spawn(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        kill.once("error", () => child.kill());
        kill.once("close", code => { if (code && child.exitCode === null) child.kill(); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
      }
    }
    const timer = setTimeout(abort, timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) abort();
        else chunks.push(chunk);
      });
    }
    child.stdin.on("error", () => {});
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("close", code => {
      clearTimeout(timer);
      if (aborted) return reject(new Error("provider outcome unknown"));
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(stdin);
  });
}
