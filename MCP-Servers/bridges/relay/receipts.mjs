import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Setup creates the database once. A receiver never initializes or repairs a store.
export async function initializeReceipts(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE receipts (
      peer TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, binding TEXT, PRIMARY KEY(peer,id)
    ) WITHOUT ROWID;
    CREATE TABLE proofs (peer TEXT NOT NULL, id TEXT NOT NULL, cursor TEXT NOT NULL, expected TEXT NOT NULL,
      PRIMARY KEY(peer,id)) WITHOUT ROWID; PRAGMA user_version=3`);
  } finally { db.close(); }
}

async function existingDatabase(file) {
  const { DatabaseSync } = await import("node:sqlite");
  // mode=rw prohibits SQLite from silently creating a fresh file after a loss.
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  return new DatabaseSync(url.href);
}

// Only machine setup may upgrade a protected store. Keep every legacy row
// and leave its unknown binding null. Never reconstruct a binding from input.
export async function migrateReceipts(file) {
  const db = await existingDatabase(file);
  try {
    db.exec("PRAGMA busy_timeout=500; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 2 && version !== 3) throw new Error("unavailable");
    db.prepare("SELECT peer,id,digest,state,created FROM receipts LIMIT 0").all();
    db.prepare("SELECT peer,id,cursor,expected FROM proofs LIMIT 0").all();
    if (version === 2) db.exec("ALTER TABLE receipts ADD COLUMN binding TEXT; PRAGMA user_version=3");
    db.prepare("SELECT binding FROM receipts LIMIT 0").all();
    db.exec("COMMIT");
  } finally { db.close(); }
}

export async function openReceipts(file) {
  const db = await existingDatabase(file);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 2 && version !== 3) throw new Error("unavailable");
    db.exec("PRAGMA busy_timeout=500; PRAGMA synchronous=FULL");
    const lookup = db.prepare(`SELECT digest,state,${version === 3 ? "binding" : "NULL AS binding"} FROM receipts
      WHERE peer=? AND id=? AND (SELECT user_version FROM pragma_user_version)=${version}`);
    return {
      supportsBindings: version === 3,
      close: () => db.close(),
      record: (peer, id) => lookup.get(peer, id),
      status: (peer, id) => lookup.get(peer, id)?.state ?? "missing",
      saveProof(peer, id, cursor, expected) {
        db.prepare("INSERT INTO proofs VALUES(?,?,?,?)").run(peer, id, JSON.stringify(cursor), expected);
      },
      proof(peer, id) {
        const row = db.prepare("SELECT cursor,expected FROM proofs WHERE peer=? AND id=?").get(peer, id);
        return row && { cursor: JSON.parse(row.cursor), expected: row.expected };
      },
      reserve(peer, id, hash, now, binding = null) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (db.prepare("PRAGMA user_version").get().user_version !== version) return "unavailable";
          const prior = lookup.get(peer, id);
          if (prior) return prior.digest === hash && prior.binding === binding ? prior.state : "request_conflict";
          if (binding !== null && version !== 3) return "unavailable";
          const time = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
          if (id[14] !== "7" || time > now + 30000 || time < now - 330000) return "request_expired";
          if (db.prepare("SELECT count(*) AS n FROM receipts").get().n >= 65536) return "receipts_full";
          if (version === 3) {
            db.prepare("INSERT INTO receipts(peer,id,digest,state,created,binding) VALUES(?,?,?,'unknown',?,?)")
              .run(peer, id, hash, now, binding);
          } else {
            db.prepare("INSERT INTO receipts(peer,id,digest,state,created) VALUES(?,?,?,'unknown',?)").run(peer, id, hash, now);
          }
          db.exec("COMMIT");
          return "reserved";
        } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
      },
      finish(peer, id, hash, state) {
        const result = db.prepare("UPDATE receipts SET state=? WHERE peer=? AND id=? AND digest=? AND state='unknown'")
          .run(state, peer, id, hash);
        if (result.changes !== 1) throw new Error("reservation unavailable");
      },
    };
  } catch (error) { db.close(); throw error; }
}
