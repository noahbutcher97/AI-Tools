import fs from "node:fs";

// Setup creates the database once. A receiver never initializes or repairs a store.
export async function initializeReceipts(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE receipts (
      peer TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, PRIMARY KEY(peer,id)
    ) WITHOUT ROWID; PRAGMA user_version=1`);
  } finally { db.close(); }
}

export async function openReceipts(file) {
  const { DatabaseSync } = await import("node:sqlite");
  // mode=rw prohibits SQLite from silently creating a fresh file after a loss.
  const { pathToFileURL } = await import("node:url");
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  const db = new DatabaseSync(url.href);
  try {
    if (db.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("unavailable");
    db.exec("PRAGMA busy_timeout=500; PRAGMA synchronous=FULL");
    const lookup = db.prepare("SELECT digest,state FROM receipts WHERE peer=? AND id=?");
    return {
      close: () => db.close(),
      status: (peer, id) => lookup.get(peer, id)?.state ?? "missing",
      reserve(peer, id, hash, now) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const prior = lookup.get(peer, id);
          if (prior) return prior.digest === hash ? prior.state : "request_conflict";
          const time = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
          if (id[14] !== "7" || time > now + 30000 || time < now - 330000) return "request_expired";
          if (db.prepare("SELECT count(*) AS n FROM receipts").get().n >= 65536) return "receipts_full";
          db.prepare("INSERT INTO receipts VALUES(?,?,?,'unknown',?)").run(peer, id, hash, now);
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
