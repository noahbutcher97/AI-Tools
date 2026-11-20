import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { initializeCompletionJobs } from "../../MCP-Servers/bridges/relay/completion-jobs.mjs";

// These modules form the broker and desktop worker's installed import closure.
// The setup snapshot includes only named inputs; provider profiles stay private.
const modules = [
  "client", "completion-broker", "completion-jobs", "completion-protocol", "completion-session",
  "completion-worker", "delivery-protocol", "fleet", "identity", "local-ping", "proof",
  "provider-process", "run-handoff", "schedule-watch", "watcher-health", "file-watch", "branch-observation",
];
const bridge = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/", import.meta.url));
const sources = [...modules.map(name => name + ".mjs"), "completion-acl.ps1", "CompletionChannel.cs", "FileObservation.cs"];
const observationImage = "relay/FileObservation.exe";
const fileAdditions = [observationImage, "relay/FileObservation.cs", "relay/file-watch.mjs"];
const branchModule = "relay/branch-observation.mjs";
const branchChanges = [branchModule, "relay/completion-acl.ps1"];
export const packageFiles = Object.freeze([
  ...sources.map(name => "relay/" + name),
  "CompletionChannel.exe", observationImage, "runtime/node.exe", "provider/codex.exe", "provider/claude.exe", "initial/jobs.sqlite",
].sort());
const scheduleMembers = ["client","completion-broker","completion-jobs","completion-protocol","completion-session",
  "run-handoff","schedule-watch","watcher-health"].map(name => "relay/" + name + ".mjs");
const addedMember = "relay/schedule-watch.mjs";
const fileUpdates = ["completion-broker","completion-jobs","completion-protocol","completion-session","schedule-watch","watcher-health"]
  .map(name => "relay/" + name + ".mjs");

async function fileHash(file, dest) {
  const handle = await fs.promises.open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw Error("Expected an ordinary package input");
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    if (dest) {
      const hashing = new Transform({ transform(bytes, _encoding, done) {
        hash.update(bytes);
        done(null, bytes);
      } });
      await pipeline(stream, hashing, fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }));
    } else {
      for await (const bytes of stream) hash.update(bytes);
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw Error("A package input changed while being read");
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function canonicalFile(root, member) {
  const file = path.join(root, member);
  if (path.relative(file, fs.realpathSync.native(file)) !== "" || !fs.lstatSync(file).isFile()) {
    throw Error("Unexpected package member");
  }
  return file;
}

function manifest(entries) {
  const body = JSON.stringify({ v: 1, files: entries });
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

// An expected digest comes from the reviewed plan, never from the bundle.
// Recheck each file again in the protected destination before executing it.
export async function verifyWatcherPackage(root, expected, { allowLegacy = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Error("Invalid package digest");
  const members = packageFiles.filter(m => !(allowLegacy &&
    ((!fs.existsSync(path.join(root, addedMember)) && m === addedMember) ||
     (!fs.existsSync(path.join(root, branchModule)) && m === branchModule) ||
     (!fs.existsSync(path.join(root, observationImage)) && fileAdditions.includes(m)))));
  for (const dir of ["", "relay", "runtime", "provider", "initial"]) {
    const prefix = dir ? dir + "/" : "";
    const allowed = new Set([...members, "package.json"].filter(member => member.startsWith(prefix))
      .map(member => member.slice(prefix.length).split("/")[0]));
    const directory = path.join(root, dir);
    if (path.relative(directory, fs.realpathSync.native(directory)) !== "") throw Error("Unexpected package directory");
    for await (const entry of await fs.promises.opendir(directory)) {
      if (!allowed.delete(entry.name)) throw Error("Unexpected package member");
    }
    if (allowed.size) throw Error("Incomplete package");
  }
  const metadata = canonicalFile(root, "package.json");
  if (fs.statSync(metadata).size > 8192) throw Error("Invalid package manifest");
  const entries = [];
  for (const member of members) entries.push([member, await fileHash(canonicalFile(root, member))]);
  const checked = manifest(entries);
  if (checked.digest !== expected || fs.readFileSync(metadata, "utf8") !== checked.body) throw Error("Package verification failed");
  return checked.digest;
}

// Create a new directory exclusively. On failure remove only files created in
// this invocation, preserving anything unexpected in the staging directory.
function compileHelper(out, member = "CompletionChannel.exe") {
  if (process.platform !== "win32") throw Error("The installed worker helper requires Windows");
  const framework = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
  const assemblies = ["mscorlib", "System", "System.Core", "System.Web.Extensions", "Microsoft.CSharp"];
  const refs = assemblies.map(name => "/reference:" + path.join(framework, name + ".dll"));
  execFileSync(path.join(framework, "csc.exe"), ["/noconfig", "/nostdlib+", "/nologo", "/target:winexe", ...refs,
    "/out:" + path.join(out, member), path.join(out, "relay", path.basename(member, ".exe") + ".cs")],
  { cwd: out, windowsHide: true, timeout: 30000, stdio: "pipe",
    env: { SystemRoot: process.env.SystemRoot, TEMP: out, TMP: out, PATH: path.join(process.env.SystemRoot, "System32") } });
}

export async function buildWatcherPackage(out, { node, codex, claude, compile = compileHelper, base, baseDigest,
  changedMember = "relay/completion-broker.mjs" }) {
  if (!path.isAbsolute(out)) throw Error("Expected an absolute package destination");
  const inputs = new Map(sources.map(name => ["relay/" + name, path.join(bridge, name)]));
  const fileMigration = changedMember === "files" || changedMember === "schedules";
  const changed = new Set(changedMember === "schedules" ? [...scheduleMembers, ...fileAdditions, ...branchChanges] :
    changedMember === "files" ? [...fileUpdates, ...fileAdditions, ...branchChanges] :
    changedMember === "branches" ? [...fileUpdates, ...branchChanges] : [changedMember]);
  let priorEntries;
  if (base !== undefined) {
    if (!["relay/completion-broker.mjs","relay/completion-jobs.mjs","relay/completion-acl.ps1","schedules","files","branches"].includes(changedMember)) throw Error("Unsupported broker package member");
    if (!path.isAbsolute(base)) throw Error("Expected an absolute base package");
    await verifyWatcherPackage(base, baseDigest, { allowLegacy: fileMigration || changedMember === "branches" });
    const bytes = fs.readFileSync(canonicalFile(base, "package.json"));
    if (createHash("sha256").update(bytes).digest("hex") !== baseDigest) throw Error("Base manifest changed");
    priorEntries = new Map(JSON.parse(bytes).files);
    if (changedMember === "files" && (!priorEntries.has(addedMember) || priorEntries.has(observationImage))) {
      throw Error("Expected a schedule-only base package");
    }
    if (changedMember === "branches" && (!priorEntries.has(observationImage) || priorEntries.has(branchModule))) {
      throw Error("Expected a file-watch base package");
    }
    for (const member of packageFiles) {
      if (!changed.has(member)) inputs.set(member, canonicalFile(base, member));
    }
  } else {
    for (const [member, file] of [["runtime/node.exe", node], ["provider/codex.exe", codex], ["provider/claude.exe", claude]]) {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw Error("Missing installed executable");
      inputs.set(member, file);
    }
  }
  const parent = path.dirname(out);
  if (path.relative(parent, fs.realpathSync.native(parent)) !== "") throw Error("Redirected staging parent");
  fs.mkdirSync(out, { mode: 0o700 });
  const created = [], directories = [out];
  try {
    for (const name of ["relay", "runtime", "provider", "initial"]) {
      const dir = path.join(out, name);
      fs.mkdirSync(dir, { mode: 0o700 });
      directories.push(dir);
    }
    const entries = [];
    for (const member of packageFiles) {
      const file = path.join(out, member);
      if (fs.existsSync(file)) throw Error("Package member already exists");
      if (!base && member === "CompletionChannel.exe") continue;
      if (member === observationImage && (!base || fileMigration)) continue;
      if (!base && member === "initial/jobs.sqlite") {
        await initializeCompletionJobs(file);
        created.push(file);
        entries.push([member, await fileHash(file)]);
      } else {
        const hash = await fileHash(inputs.get(member), file);
        created.push(file);
        if (priorEntries && !changed.has(member) && priorEntries.get(member) !== hash) throw Error("Base member changed");
        entries.push([member, hash]);
      }
    }
    for (const member of (!base ? ["CompletionChannel.exe", observationImage] : fileMigration ? [observationImage] : [])) {
      compile(out, member);
      const helper = canonicalFile(out, member);
      created.push(helper);
      entries.push([member, await fileHash(helper)]);
    }
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const output = manifest(entries);
    const metadata = path.join(out, "package.json");
    fs.writeFileSync(metadata, output.body, { flag: "wx", mode: 0o600 });
    created.push(metadata);
    await verifyWatcherPackage(out, output.digest);
    return output.digest;
  } catch (error) {
    for (const file of created.reverse()) fs.unlinkSync(file);
    for (const dir of directories.reverse()) {
      try { fs.rmdirSync(dir); } catch { /* Preserve unexpected or partial files for inspection. */ }
    }
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, out, ...rest] = process.argv.slice(2);
    if (mode === "build" && rest.length === 2) {
      console.log(await buildWatcherPackage(out, { node: process.execPath, codex: rest[0], claude: rest[1] }));
    } else if (["stage-broker","stage-jobs","stage-schedules","stage-files","stage-branches","stage-acl"].includes(mode) && rest.length === 2) {
      const changedMember = { "stage-broker": "relay/completion-broker.mjs", "stage-jobs": "relay/completion-jobs.mjs",
        "stage-schedules": "schedules", "stage-files": "files", "stage-branches": "branches", "stage-acl": "relay/completion-acl.ps1" }[mode];
      console.log(await buildWatcherPackage(out, { base: rest[0], baseDigest: rest[1], changedMember }));
    } else if (mode === "verify" && rest.length === 1) {
      console.log(await verifyWatcherPackage(out, rest[0]));
    } else throw Error("Expected build, stage-broker <new-directory> <base-directory> <base-digest>, or verify");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
