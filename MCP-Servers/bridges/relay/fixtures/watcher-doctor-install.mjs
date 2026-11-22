import os from "node:os";
import path from "node:path";
export * from "../fleet.mjs";
export function installationRoot() { return path.join(os.homedir(), "installation"); }
export async function inventory() { return { partial: false, targets: [] }; }
export function loadDirectory() {
  return { local: "fixture", hosts: [{ host: "fixture", endpoint: "fixture", user: "fixture", port: 22 }] };
}
export async function runProvider() { return { code: 1, stdout: "", stderr: "" }; }
