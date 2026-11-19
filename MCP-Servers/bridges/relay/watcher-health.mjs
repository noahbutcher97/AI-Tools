import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exactKeys, matches, UUID } from "./delivery-protocol.mjs";

const states = ["waiting","claimed","ready","unknown","observing"];
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validBeat(b) {
  return exactKeys(b, ["v","pid","startedAt","heartbeat","mode","policyRevision","partial","subscriptions"]) && b.v === 1 &&
    Number.isSafeInteger(b.pid) && b.pid > 0 && date(b.startedAt) && date(b.heartbeat) && b.startedAt <= b.heartbeat &&
    ["watching","reports_only","stopped"].includes(b.mode) && (b.policyRevision === null || matches(/^[a-f0-9]{64}$/, b.policyRevision)) &&
    typeof b.partial === "boolean" && Array.isArray(b.subscriptions) && b.subscriptions.length <= 32 &&
    b.subscriptions.every(s => exactKeys(s, ["id","target","condition","state"]) && matches(UUID,s.id) &&
      matches(UUID,s.target) && ["job_exit","schedule","file"].includes(s.condition) && states.includes(s.state));
}

function healthDir(root) {
  const dir = path.join(root, "completion-health");
  if (path.relative(dir, fs.realpathSync.native(dir)) !== "") throw new Error("invalid watcher health directory");
  return dir;
}

export function writeHeartbeat(root, beat) {
  if (!validBeat(beat)) throw new Error("invalid watcher heartbeat");
  const dir = healthDir(root);
  const temp = path.join(dir, randomUUID() + ".tmp");
  const fd = fs.openSync(temp, "wx", 0o640);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(beat)); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, path.join(dir, "watcher.json"));
  } finally { fs.rmSync(temp, { force: true }); }
}

function freshness(beat, now) {
  const age = now - Date.parse(beat.heartbeat);
  if (age < 0 || age > 15000) return "stale";
  return beat.mode;
}

export function validWatcherObservation(o, now) {
  return exactKeys(o, ["state","record"]) && (o.record === null ? o.state === "unavailable" :
    validBeat(o.record) && o.state === freshness(o.record, now));
}

export function readWatcher(root, now = Date.now()) {
  try {
    const file = path.join(healthDir(root), "watcher.json");
    if (path.relative(file, fs.realpathSync.native(file)) !== "") throw new Error();
    const fd = fs.openSync(file, "r");
    let record;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8192) throw new Error();
      const buf = Buffer.alloc(8193);
      const n = fs.readSync(fd, buf);
      if (n !== stat.size) throw new Error();
      record = JSON.parse(buf.subarray(0,n).toString("utf8"));
    } finally { fs.closeSync(fd); }
    if (!validBeat(record)) throw new Error();
    return { state: freshness(record, now), record };
  } catch { return { state: "unavailable", record: null }; }
}
