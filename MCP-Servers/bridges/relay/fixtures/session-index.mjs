import path from "node:path";

export function addIndexedSession(DatabaseSync, home, id, cwd, source = "user") {
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, thread_source TEXT)");
    db.prepare("INSERT OR REPLACE INTO threads VALUES(?,?,?,?)").run(id, path.join(home, "sessions", id + ".jsonl"), cwd, source);
  } finally { db.close(); }
}
