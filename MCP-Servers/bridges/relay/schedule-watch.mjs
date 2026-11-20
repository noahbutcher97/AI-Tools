import { randomBytes, randomUUID } from "node:crypto";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { publishRunHandoff } from "./run-handoff.mjs";
import { changeNotice, scheduleNotice } from "./completion-protocol.mjs";
import { validBranchResource } from "./branch-observation.mjs";

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

const fileFields = ["condition", "target", "provider", "scope", "volume", "directory", "rootId", "file", "expiresAt"];
const fileScope = g => g.scope === "thread-file-change";
const branchScope = g => g.scope === "thread-branch-change";
const isChange = g => fileScope(g) || branchScope(g);
const branchFields = ["condition","target","provider","scope","endpoint","ref","credential","expiresAt"];
export function validBranchWatch(g) {
  return exactKeys(g, branchFields) && matches(UUID, g.condition) && matches(UUID, g.target) &&
    g.provider === "codex" && branchScope(g) && g.credential === null &&
    validBranchResource(g.endpoint, g.ref) && date(g.expiresAt);
}
function relativeName(name) {
  if (typeof name !== "string" || !name.length || name.length > 1024) return false;
  const parts = name.split("/");
  return parts.length <= 32 && parts.every(p => p.length && p.length <= 255 && !/[. ]$/.test(p) &&
    !/[<>:"\\|?*\u0000-\u001f]/.test(p));
}
export function validFileWatch(g) {
  return exactKeys(g, fileFields) && matches(UUID, g.condition) && matches(UUID, g.target) &&
    g.provider === "codex" && fileScope(g) && matches(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, g.volume) &&
    matches(/^[a-f0-9]{48}$/, g.rootId) && relativeName(g.directory) && relativeName(g.file) && date(g.expiresAt);
}
export function fileBinding(target, condition) {
  return digest(JSON.stringify(["file-change-activation-v1", target, condition]));
}
export function branchBinding(target, condition) {
  return digest(JSON.stringify(["branch-change-activation-v1", target, condition]));
}

export const scheduleTable = `CREATE TABLE IF NOT EXISTS schedule_watches (
  condition TEXT PRIMARY KEY, revision TEXT NOT NULL, token_hash BLOB NOT NULL, pending TEXT, handoff_hash TEXT NOT NULL,
  state TEXT NOT NULL, cursor INTEGER, batch TEXT, handle TEXT, retry_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS file_samples (
  condition TEXT PRIMARY KEY, baseline TEXT, next_poll INTEGER NOT NULL
) WITHOUT ROWID`;

function slot(g, at) {
  return Math.max(-1, Math.floor((at - Date.parse(g.startsAt)) / (g.intervalSeconds * 1000)));
}

// All destinations, times and disclosure scopes come from the separate policy
// authority. The database holds cursors and references to that authority.
export function scheduleWatches(db, transaction, { policy, now, root, send, status, sampleFile, sampleBranch }) {
  const lookup = db.prepare("SELECT * FROM schedule_watches WHERE condition=?");
  function current() {
    const grants = policy();
    if (!Array.isArray(grants) || grants.length > 32 || !grants.every(g => validSchedule(g) || validFileWatch(g) || validBranchWatch(g)) ||
        new Set(grants.map(g => g.condition)).size !== grants.length) throw new Error("invalid schedule authority");
    return grants.filter(g => Date.parse(g.expiresAt) > now());
  }
  const revision = g => digest(JSON.stringify((branchScope(g) ? branchFields : fileScope(g) ? fileFields : fields).map(key => g[key])));
  function authorized(g) {
    const row = lookup.get(g.condition);
    return row?.revision === revision(g) ? row : undefined;
  }
  function provision() {
    for (const g of current()) {
      const binding = (branchScope(g) ? branchBinding : fileScope(g) ? fileBinding : scheduleBinding)(g.target, g.condition);
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
      const g = current().find(g => g.condition === frame.id && g.target === frame.event.session &&
        frame.op === (branchScope(g) ? "activate_branch" : fileScope(g) ? "activate_file" : "activate_schedule"));
      const row = g && authorized(g);
      if (!row || !Buffer.from(row.token_hash).equals(key)) throw new Error("schedule activation denied");
      if (row.state === "issued") {
        if (isChange(g)) db.prepare("INSERT INTO file_samples(condition,next_poll) VALUES(?,0)").run(g.condition);
        db.prepare("UPDATE schedule_watches SET state='waiting',cursor=? WHERE condition=?")
          .run(isChange(g) ? -1 : slot(g, now()), g.condition);
      }
      return row.token_hash;
    });
  }
  function subscriptions(grants) {
    return grants.filter(g => Date.parse(g.expiresAt) > now()).flatMap(g => {
      const row = authorized(g);
      if (!row || ["issued","delivered"].includes(row.state)) return [];
      return [{ id: g.condition, target: g.target, condition: branchScope(g) ? "branch" : fileScope(g) ? "file" : "schedule",
        state: row.state === "dispatching" ? "unknown" : row.state }];
    });
  }
  function reserve() {
    const stamp = now();
    const candidates = current().map(g => ({ g, row: authorized(g) })).filter(({ row }) => row && row.state !== "issued");
    // Only one unresolved notice per destination. A later activation or new
    // tick cannot trigger another wake while the first outcome is unknown.
    const outstanding = new Set(candidates.filter(x => ["dispatching", "observing"].includes(x.row.state)).map(x => x.g.target));
    const due = candidates.filter(({ g, row }) => row.retry_at <= stamp && (row.state === "observing" ||
      (!outstanding.has(g.target) && (isChange(g) ? row.state === "ready" :
        row.state === "waiting" && slot(g, stamp) > row.cursor))));
    if (!due.length) return null;
    due.sort((a,b) => a.row.retry_at - b.row.retry_at || a.g.condition.localeCompare(b.g.condition));
    const { g, row } = due[0];
    const proving = row.state === "observing";
    const batch = proving ? row.batch : randomUUID();
    const members = due.filter(x => x.g.target === g.target && isChange(x.g) === isChange(g) &&
      x.row.state === row.state && (!proving || x.row.batch === batch));
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
        for (const { g } of members) db.prepare("UPDATE schedule_watches SET state=?,cursor=max(cursor,?),batch=NULL,handle=NULL WHERE condition=?")
          .run(isChange(g) ? "delivered" : "waiting", isChange(g) ? 0 : slot(g, now()), g.condition);
      });
      return true;
    }
    function checkTarget(t) {
      if (t.id !== target || t.kind !== "codex" || t.addressable !== true || t.pid !== null || t.startedAt !== null) throw new Error("schedule target changed");
      recheck("dispatching");
    }
    const change = isChange(members[0].g);
    const result = await send(target, change ? changeNotice : scheduleNotice, { allowDelegate: false, deferProof: true, signal, checkTarget,
      onHandle(h, t) {
        transaction(() => {
          checkTarget(t);
          if (!matches(/^local-proof\.[A-Za-z0-9_-]{39,8180}$/, h)) throw new Error("invalid schedule proof");
          for (const { g } of members) db.prepare("UPDATE schedule_watches SET state='observing',handle=?,cursor=max(cursor,?) WHERE condition=?")
            .run(h, change ? 0 : slot(g, work.observedAt), g.condition);
        });
      },
    });
    if (result.state === "dispatch_failed") db.prepare("UPDATE schedule_watches SET state=?,batch=NULL WHERE batch=? AND state='dispatching'")
      .run(change ? "ready" : "waiting", batch);
    return true;
  }
  async function pollChanges(signal) {
    if ((!sampleFile && !sampleBranch) || signal?.aborted) return;
    const read = db.prepare("SELECT baseline,next_poll FROM file_samples WHERE condition=?");
    for (const g of current().filter(isChange)) {
      const branch = branchScope(g);
      const observe = branch ? sampleBranch : sampleFile;
      if (!observe) continue;
      function canObserve() {
        signal?.throwIfAborted();
        return current().some(fresh => fresh.condition === g.condition && revision(fresh) === revision(g)) &&
          authorized(g)?.state === "waiting";
      }
      if (!canObserve()) continue;
      const row = read.get(g.condition);
      if (!row || row.next_poll > now()) continue;
      const deadline = now() + (branch ? 60000 : 10000);
      if (!db.prepare("UPDATE file_samples SET next_poll=? WHERE condition=? AND next_poll=?")
        .run(deadline, g.condition, row.next_poll).changes) continue;
      if (!canObserve()) continue;
      let sample;
      try { sample = await observe(g, signal, canObserve); } catch { continue; }
      if (branch ? !matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, sample) :
        sample !== "absent" && !matches(/^[a-f0-9]{48}:[a-f0-9]{16}:[a-f0-9]{16}$/, sample)) continue;
      transaction(() => {
        if (!canObserve() || read.get(g.condition)?.next_poll !== deadline) return;
        const hash = digest(sample);
        if (row.baseline === null) db.prepare("UPDATE file_samples SET baseline=? WHERE condition=?").run(hash, g.condition);
        else if (row.baseline !== hash) db.prepare("UPDATE schedule_watches SET state='ready' WHERE condition=?").run(g.condition);
      });
    }
  }
  return { provision, activate, subscriptions, dispatchDue, pollChanges };
}
