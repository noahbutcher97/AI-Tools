import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { digest, matches, UUID } from "./delivery-protocol.mjs";
import { jobMac, sameMac, validExit, validJobFrame } from "./completion-protocol.mjs";
import { localStatus, sendProvedNotice } from "./local-ping.mjs";

// This database belongs to the broker. Installation supplies the protected
// directory. No CLI, SSH frame or MCP request can select a path or issue grants.
export async function initializeCompletionJobs(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, token_hash BLOB NOT NULL, recipient TEXT NOT NULL,
      provider TEXT NOT NULL, instance TEXT NOT NULL, valid_until INTEGER NOT NULL,
      state TEXT NOT NULL, code INTEGER, signal TEXT, handle TEXT
    ) WITHOUT ROWID; PRAGMA application_id=1128943426; PRAGMA user_version=1`);
  } finally { db.close(); }
}

function instanceOf(target) {
  if (!matches(UUID, target.id) || !target.addressable) throw new Error("unaddressable session");
  if (target.kind === "claude" && Number.isSafeInteger(target.pid) && target.pid > 0 &&
      Number.isSafeInteger(target.startedAt) && target.startedAt > 0) {
    return digest(JSON.stringify([target.id, target.pid, target.startedAt]));
  }
  // A Codex thread ID and writer-lock filename can recur after resume.
  // Qualify a per-writer instance witness before issuing completion grants.
  throw new Error("unknown session instance");
}

export async function openCompletionJobs(file, { now = Date.now, send = sendProvedNotice, status = localStatus,
  permits = () => false } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  const db = new DatabaseSync(url.href);
  try {
    if (db.prepare("PRAGMA application_id").get().application_id !== 1128943426 ||
        db.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("invalid job store");
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=500");
  } catch (error) { db.close(); throw error; }
  const row = db.prepare("SELECT * FROM jobs WHERE id=?");
  function active(id) {
    const job = row.get(id);
    if (!job || job.state === "revoked" || job.valid_until <= now()) return null;
    return permits(job.recipient, job.provider, job.instance) === true ? job : null;
  }
  function publicState(id) {
    const job = active(id);
    if (!job) return "unavailable";
    return job.state === "dispatching" ? "unknown" : job.state;
  }
  function authorize(id, capability) {
    const job = active(id);
    if (!job || !matches(/^[a-f0-9]{64}$/, capability) ||
        !timingSafeEqual(job.token_hash, Buffer.from(digest(capability), "hex"))) throw new Error("job denied");
    return job;
  }
  function recordOutcome(job, event, initialState) {
    if (!validExit(event)) throw new Error("invalid job outcome");
    const wrote = db.prepare("UPDATE jobs SET code=?,signal=?,state='ready' WHERE id=? AND state=? AND valid_until>?")
      .run(event.code, event.signal, job.id, initialState, now());
    if (!wrote.changes) {
      const current = active(job.id);
      if (!current || current.code !== event.code || current.signal !== event.signal) throw new Error("job outcome conflict");
    }
  }
  async function inspectProof(job) {
    const proof = await status(job.handle);
    if (!active(job.id)) return "unavailable";
    if (proof.to === job.recipient && proof.state === "delivered") {
      db.prepare("UPDATE jobs SET state='delivered' WHERE id=? AND state='observing'").run(job.id);
    } else if (proof.state !== "pending" || proof.to !== job.recipient) {
      return "proof_unavailable";
    }
    return publicState(job.id);
  }
  return {
    close: () => db.close(),
    // Broker-only. The caller of issue must already hold an owner grant to
    // notify this exact instance. Observing a live ID does not supply one.
    issue(target, validUntil) {
      if (!Number.isSafeInteger(validUntil) || validUntil <= now()) throw new Error("invalid grant expiry");
      const binding = instanceOf(target);
      if (permits(target.id, target.kind, binding) !== true) throw new Error("job denied");
      const id = randomUUID(), capability = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO jobs(id,token_hash,recipient,provider,instance,valid_until,state) VALUES(?,?,?,?,?,?,'waiting')")
        .run(id, Buffer.from(digest(capability), "hex"), target.id, target.kind, binding, validUntil);
      return { id, capability };
    },
    revoke(id) { db.prepare("UPDATE jobs SET state='revoked', handle=NULL WHERE id=?").run(id); },
    // The wrapper can report a termination once. It cannot select a recipient,
    // supply text, ask for proof, or manage the grant.
    complete(id, capability, event) {
      recordOutcome(authorize(id, capability), event, "waiting");
    },
    // Only this operation is exposed to wrappers. Authenticate before the
    // protected policy lookup. Sign acknowledgements after the durable write.
    acceptFrame(frame) {
      if (!validJobFrame(frame)) throw new Error("job denied");
      const key = row.get(frame.id)?.token_hash;
      if (!key || !sameMac(frame.mac, jobMac(key, frame, "request"))) throw new Error("job denied");
      const job = active(frame.id);
      if (!job) throw new Error("job denied");
      if (frame.op === "claim" || frame.op === "claim_run") {
        if (frame.op === "claim_run" && (job.provider !== "claude" || job.recipient !== frame.event.session)) {
          throw new Error("run grant mismatch");
        }
        const claimed = db.prepare("UPDATE jobs SET state='claimed' WHERE id=? AND state='waiting' AND valid_until>?")
          .run(frame.id, now());
        if (claimed.changes !== 1) throw new Error("job already claimed");
      } else if (frame.op === "start_failed") {
        const failed = db.prepare("UPDATE jobs SET state='start_failed' WHERE id=? AND state='claimed' AND valid_until>?")
          .run(frame.id, now());
        if (failed.changes !== 1 && active(frame.id)?.state !== "start_failed") throw new Error("job outcome conflict");
      } else {
        recordOutcome(job, frame.event, "claimed");
      }
      return { ack: jobMac(key, frame, "ack") };
    },
    async dispatch(id) {
      const job = active(id);
      if (!job) return "unavailable";
      if (job.state === "observing") return inspectProof(job);
      if (job.state !== "ready") return publicState(id);
      const won = db.prepare("UPDATE jobs SET state='dispatching' WHERE id=? AND state='ready' AND valid_until>?").run(id, now());
      if (won.changes !== 1) return publicState(id);
      const checkTarget = target => {
        if (!active(id) || target.id !== job.recipient || target.kind !== job.provider || instanceOf(target) !== job.instance) {
          throw new Error("job binding changed");
        }
      };
      const termination = job.signal ?? String(job.code);
      const message = "Job " + id + " ended with " + (job.signal ? "signal " : "exit code ") + termination + ". No reply is needed.";
      // Persist the original notice's handle before its one possible provider
      // call. Another worker or a restarted broker can only inspect that handle.
      const result = await send(job.recipient, message, { allowDelegate: job.provider === "claude", checkTarget, deferProof: true,
        onHandle(handle, target) {
          checkTarget(target);
          const saved = db.prepare("UPDATE jobs SET handle=?,state='observing' WHERE id=? AND state='dispatching' AND valid_until>?")
            .run(handle, id, now());
          if (saved.changes !== 1) throw new Error("job grant unavailable");
        },
      });
      if (result.state === "dispatch_failed") {
        db.prepare("UPDATE jobs SET state='ready' WHERE id=? AND state='dispatching'").run(id);
      }
      const current = active(id);
      if (current?.state === "observing") return inspectProof(current);
      return publicState(id);
    },
  };
}
