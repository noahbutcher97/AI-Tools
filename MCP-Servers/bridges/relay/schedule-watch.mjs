import { randomBytes, randomUUID } from "node:crypto";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { publishRunHandoff } from "./run-handoff.mjs";
import { scheduleNotice } from "./completion-protocol.mjs";

const fields = ["condition", "target", "provider", "scope", "startsAt", "intervalSeconds", "expiresAt"];
const date = s => typeof s === "string" && /^\d{4}-/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;

export function validSchedule(g) {
  return exactKeys(g, fields) && matches(UUID, g.condition) && matches(UUID, g.target) &&
    g.provider === "codex" && g.scope === "thread-schedule" && date(g.startsAt) && date(g.expiresAt) &&
    g.expiresAt > g.startsAt && Number.isSafeInteger(g.intervalSeconds) && g.intervalSeconds >= 60 && g.intervalSeconds <= 86400;
}

export function scheduleBinding(target, condition) {
  return digest(JSON.stringify(["schedule-activation-v1", target, condition]));
}

export const scheduleTable = `CREATE TABLE IF NOT EXISTS schedule_watches (
  condition TEXT PRIMARY KEY, revision TEXT NOT NULL, token_hash BLOB NOT NULL, pending TEXT, handoff_hash TEXT NOT NULL,
  state TEXT NOT NULL, cursor INTEGER, batch TEXT, handle TEXT, retry_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID`;

function slot(g, at) {
  return Math.max(-1, Math.floor((at - Date.parse(g.startsAt)) / (g.intervalSeconds * 1000)));
}

// All destinations, times and disclosure scopes come from the separate policy
// authority. The database holds cursors and references to that authority.
export function scheduleWatches(db, transaction, { policy, now, root, send, status }) {
  const lookup = db.prepare("SELECT * FROM schedule_watches WHERE condition=?");
  function current() {
    const grants = policy();
    if (!Array.isArray(grants) || grants.length > 32 || !grants.every(validSchedule) ||
        new Set(grants.map(g => g.condition)).size !== grants.length) throw new Error("invalid schedule authority");
    return grants.filter(g => Date.parse(g.expiresAt) > now());
  }
  const revision = g => digest(JSON.stringify(fields.map(key => g[key])));
  function authorized(g) {
    const row = lookup.get(g.condition);
    return row?.revision === revision(g) ? row : undefined;
  }
  function provision() {
    for (const g of current()) {
      const binding = scheduleBinding(g.target, g.condition);
      const row = transaction(() => {
        const existing = lookup.get(g.condition);
        if (existing) return authorized(g);
        const capability = randomBytes(32).toString("hex");
        const pending = JSON.stringify({ v: 1, session: g.target, instance: binding, validUntil: Date.parse(g.expiresAt),
          grants: [{ id: g.condition, capability }] });
        db.prepare("INSERT INTO schedule_watches(condition,revision,token_hash,pending,handoff_hash,state) VALUES(?,?,?,?,?,'issued')")
          .run(g.condition, revision(g), Buffer.from(digest(capability), "hex"), pending, digest(pending));
        return lookup.get(g.condition);
      });
      if (!row) throw new Error("changed schedule requires a new condition ID");
      if (!current().some(fresh => revision(fresh) === row.revision)) throw new Error("schedule authority changed");
      publishRunHandoff(root, binding, row.handoff_hash, row.pending);
      if (row.pending !== null) db.prepare("UPDATE schedule_watches SET pending=NULL WHERE condition=?").run(g.condition);
    }
  }
  function activate(frame, authenticate) {
    const key = lookup.get(frame.id)?.token_hash;
    if (!key || !authenticate(key)) throw new Error("schedule activation denied");
    return transaction(() => {
      const g = current().find(g => g.condition === frame.id && g.target === frame.event.session);
      const row = g && authorized(g);
      if (!row || !Buffer.from(row.token_hash).equals(key)) throw new Error("schedule activation denied");
      if (row.state === "issued") db.prepare("UPDATE schedule_watches SET state='waiting',cursor=? WHERE condition=?")
        .run(slot(g, now()), g.condition);
      return row.token_hash;
    });
  }
  function subscriptions(grants) {
    return grants.filter(g => Date.parse(g.expiresAt) > now()).flatMap(g => {
      const row = authorized(g);
      if (!row || row.state === "issued") return [];
      return [{ id: g.condition, target: g.target, condition: "schedule", state: row.state === "dispatching" ? "unknown" : row.state }];
    });
  }
  function reserve() {
    const stamp = now();
    const candidates = current().map(g => ({ g, row: authorized(g) })).filter(({ row }) => row && row.state !== "issued");
    // Only one unresolved notice per destination. A later activation or new
    // tick cannot trigger another wake while the first outcome is unknown.
    const outstanding = new Set(candidates.filter(x => ["dispatching", "observing"].includes(x.row.state)).map(x => x.g.target));
    const due = candidates.filter(({ g, row }) => row.retry_at <= stamp && (row.state === "observing" ||
      (!outstanding.has(g.target) && row.state === "waiting" && slot(g, stamp) > row.cursor)));
    if (!due.length) return null;
    due.sort((a,b) => a.row.retry_at - b.row.retry_at || a.g.condition.localeCompare(b.g.condition));
    const { g, row } = due[0];
    const proving = row.state === "observing";
    const batch = proving ? row.batch : randomUUID();
    const members = due.filter(x => x.g.target === g.target && x.row.state === row.state && (!proving || x.row.batch === batch));
    for (const m of members) {
      db.prepare("UPDATE schedule_watches SET state=?,batch=?,retry_at=? WHERE condition=?")
        .run(proving ? "observing" : "dispatching", batch, stamp + 10000, m.g.condition);
    }
    return { target: g.target, batch, members, proving, handle: row.handle, observedAt: stamp };
  }
  async function dispatchDue(signal) {
    if (signal?.aborted) return false;
    const work = transaction(reserve);
    if (!work) return false;
    const { target, batch, members, proving, handle } = work;
    function recheck(state) {
      signal?.throwIfAborted();
      const grants = current();
      for (const { g } of members) {
        const fresh = grants.find(x => x.condition === g.condition && revision(x) === revision(g));
        const row = fresh && authorized(fresh);
        if (row?.batch !== batch || row.state !== state) throw new Error("schedule authority changed");
      }
    }
    if (proving) {
      recheck("observing");
      const proof = await status(handle, { signal });
      if (proof.state === "delivered" && proof.to === target) transaction(() => {
        recheck("observing");
        for (const { g } of members) db.prepare("UPDATE schedule_watches SET state='waiting',cursor=max(cursor,?),batch=NULL,handle=NULL WHERE condition=?")
          .run(slot(g, now()), g.condition);
      });
      return true;
    }
    function checkTarget(t) {
      if (t.id !== target || t.kind !== "codex" || t.addressable !== true || t.pid !== null || t.startedAt !== null) throw new Error("schedule target changed");
      recheck("dispatching");
    }
    const result = await send(target, scheduleNotice, { allowDelegate: false, deferProof: true, signal, checkTarget,
      onHandle(h, t) {
        transaction(() => {
          checkTarget(t);
          if (!matches(/^local-proof\.[A-Za-z0-9_-]{39,8180}$/, h)) throw new Error("invalid schedule proof");
          for (const { g } of members) db.prepare("UPDATE schedule_watches SET state='observing',handle=?,cursor=max(cursor,?) WHERE condition=?")
            .run(h, slot(g, work.observedAt), g.condition);
        });
      },
    });
    if (result.state === "dispatch_failed") db.prepare("UPDATE schedule_watches SET state='waiting',batch=NULL WHERE batch=? AND state='dispatching'").run(batch);
    return true;
  }
  return { provision, activate, subscriptions, dispatchDue };
}
