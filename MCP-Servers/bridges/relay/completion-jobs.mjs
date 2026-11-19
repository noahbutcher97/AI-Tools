import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { digest, matches, UUID } from "./delivery-protocol.mjs";
import { jobMac, sameMac, validExit, validJobFrame } from "./completion-protocol.mjs";
import { localStatus, sendProvedNotice } from "./local-ping.mjs";

const COOLDOWN_MS = 10000;

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
      state TEXT NOT NULL, code INTEGER, signal TEXT, handle TEXT,
      next_check INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_notice INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX jobs_due ON jobs(state,next_check,id);
    CREATE INDEX jobs_last_notice ON jobs(recipient,provider,instance,last_notice) WHERE last_notice IS NOT NULL;
    PRAGMA application_id=1128943426; PRAGMA user_version=2`);
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
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=500; BEGIN IMMEDIATE");
    if (db.prepare("PRAGMA application_id").get().application_id !== 1128943426) throw new Error("invalid job store");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === 1) {
      db.exec(`ALTER TABLE jobs ADD COLUMN next_check INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN last_notice INTEGER;
        CREATE INDEX jobs_due ON jobs(state,next_check,id);
        CREATE INDEX jobs_last_notice ON jobs(recipient,provider,instance,last_notice) WHERE last_notice IS NOT NULL;
        PRAGMA user_version=2`);
    } else if (version !== 2) throw new Error("invalid job store");
    db.exec("COMMIT");
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
    const stamp = now();
    const wrote = db.prepare(`UPDATE jobs SET code=?,signal=?,state='ready',next_check=max(?,(
      SELECT coalesce(max(last_notice)+?,0) FROM jobs WHERE recipient=? AND provider=? AND instance=? AND last_notice IS NOT NULL
    )) WHERE id=? AND state=? AND valid_until>?`)
      .run(event.code, event.signal, stamp + 750, COOLDOWN_MS, job.recipient, job.provider, job.instance, job.id, initialState, stamp);
    if (!wrote.changes) {
      const current = active(job.id);
      if (!current || current.code !== event.code || current.signal !== event.signal) throw new Error("job outcome conflict");
    }
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function currentJobs(ids, state) {
    return ids.map(active).filter(job => job?.state === state);
  }
  async function inspectProof(jobs, signal) {
    const first = jobs[0];
    const proof = await status(first.handle, { signal });
    if (proof.to !== first.recipient || !["pending", "delivered"].includes(proof.state)) return "proof_unavailable";
    if (proof.state === "delivered") {
      transaction(() => {
        for (const job of jobs) {
          if (active(job.id)) db.prepare("UPDATE jobs SET state='delivered' WHERE id=? AND state='observing' AND handle=?").run(job.id, first.handle);
        }
      });
    }
    return publicState(first.id);
  }
  async function dispatchJobs(ids, signal) {
    if (signal?.aborted) return "stopped";
    const observing = currentJobs(ids, "observing");
    if (observing.length) return inspectProof(observing, signal);
    const jobs = transaction(() => {
      const ready = currentJobs(ids, "ready");
      for (const job of ready) db.prepare("UPDATE jobs SET state='dispatching' WHERE id=?").run(job.id);
      return ready;
    });
    if (!jobs.length) return publicState(ids[0]);
    const first = jobs[0];
    const checkTarget = target => {
      if (signal?.aborted || target.id !== first.recipient || target.kind !== first.provider ||
          instanceOf(target) !== first.instance || jobs.some(job => active(job.id)?.state !== "dispatching")) {
        throw new Error("job binding changed");
      }
    };
    const message = jobs.map(job => "Job " + job.id + " ended with " +
      (job.signal ? "signal " + job.signal : "exit code " + job.code) + ".").join("\n") + " No reply is needed.";
    const result = await send(first.recipient, message, { allowDelegate: first.provider === "claude", checkTarget,
      deferProof: true, signal, onHandle(handle, target) {
        transaction(() => {
          checkTarget(target);
          const stamp = now();
          for (const job of jobs) db.prepare("UPDATE jobs SET handle=?,state='observing',last_notice=? WHERE id=?").run(handle, stamp, job.id);
          db.prepare(`UPDATE jobs SET next_check=max(next_check,?) WHERE state='ready' AND recipient=? AND provider=? AND instance=?`)
            .run(stamp + COOLDOWN_MS, first.recipient, first.provider, first.instance);
        });
      },
    });
    if (result.state === "dispatch_failed") {
      transaction(() => {
        for (const job of jobs) db.prepare("UPDATE jobs SET state='ready' WHERE id=? AND state='dispatching'").run(job.id);
      });
    }
    const saved = currentJobs(jobs.map(job => job.id), "observing");
    if (saved.length && !signal?.aborted) return inspectProof(saved, signal);
    return publicState(first.id);
  }

  // Reserve a finite retry interval before any asynchronous work. After a
  // crash the state determines whether a send or only a proof check is legal.
  function dueBatch() {
    return transaction(() => {
      const stamp = now();
      const due = db.prepare(`SELECT * FROM jobs WHERE state IN ('ready','observing') AND valid_until>? AND next_check<=?
        ORDER BY next_check,id LIMIT 1`).get(stamp, stamp);
      if (!due) return [];
      const related = db.prepare(`SELECT id,attempts FROM jobs WHERE id<>? AND recipient=? AND provider=? AND instance=?
        AND state=? AND handle IS ? AND valid_until>? AND (next_check<=? OR (state='ready' AND attempts=0))
        ORDER BY next_check,id LIMIT 7`).all(due.id, due.recipient, due.provider, due.instance, due.state, due.handle, stamp, stamp);
      const jobs = [due, ...related];
      for (const job of jobs) {
        const backoff = Math.min(60000, 2000 * 2 ** Math.min(5, job.attempts));
        db.prepare("UPDATE jobs SET next_check=?, attempts=min(attempts+1,6) WHERE id=?").run(stamp + backoff, job.id);
      }
      return jobs.map(job => job.id);
    });
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
    dispatch: id => dispatchJobs([id]),
    async dispatchDue(signal) {
      if (signal?.aborted) return false;
      const ids = dueBatch();
      if (!ids.length) return false;
      await dispatchJobs(ids, signal);
      return true;
    },
  };
}
