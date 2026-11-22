import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// Windows temp directories can grant other accounts modify rights. Place
// disposable recovery fixtures under the profile, away from live relay state.
export function recoveryFixture() {
  const base = process.platform === "win32" ? os.homedir() : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, "relay-private-test-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
