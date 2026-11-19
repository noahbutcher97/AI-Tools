import { execFile } from "node:child_process";
import path from "node:path";
import { validFileWatch } from "./schedule-watch.mjs";

// Only the broker supplies the protected installation and reauthorized grant.
// The helper requests attributes, emits one bounded fingerprint and exits.
export function sampleInstalledFile(root, grant, signal) {
  if (process.platform !== "win32" || !path.isAbsolute(root) || !validFileWatch(grant)) throw Error("file observation unavailable");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(path.join(root, "relay", "FileObservation.exe"), [], {
      cwd: root, env: { SystemRoot: process.env.SystemRoot }, shell: false, windowsHide: true,
      timeout: 3000, maxBuffer: 256, signal, encoding: "utf8",
    }, (error, out) => {
      if (error || (out !== "absent" && (out.length !== 82 || !/^[a-f0-9]{48}:[a-f0-9]{16}:[a-f0-9]{16}$/.test(out)))) {
        reject(Error("file observation unavailable"));
      } else resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end([grant.volume, grant.directory, grant.rootId, grant.file].join("\n"));
  });
}
