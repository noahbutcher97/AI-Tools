import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function checkHandoffs(records) {
  assert.ok(Array.isArray(records) && records.length, "Expected a nonempty handoff register");
  const ids = new Set();
  function required(object, keys) {
    for (const key of keys) {
      assert.ok(typeof object?.[key] === "string" && object[key].trim(), "Missing handoff field " + key);
    }
  }
  for (const record of records) {
    required(record, ["id", "revision", "worker", "coordinator", "scope", "acceptance", "state"]);
    assert.match(record.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(!ids.has(record.id), "Duplicate handoff identifier");
    ids.add(record.id);
    assert.match(record.revision, /^[a-f0-9]{40}$/);
    assert.notEqual(record.worker, record.coordinator, "Separate worker and coordinator labels are required");
    assert.ok(["assigned", "returned", "accepted"].includes(record.state), "Unknown handoff state");
    if (record.state === "assigned") {
      assert.equal(record.result, undefined);
    } else {
      required(record.result, ["revision", "verdict", "evidence", "limitations"]);
      assert.equal(record.result.revision, record.revision, "Review revision differs from assignment");
    }
    if (record.state === "accepted") {
      required(record.acknowledgment, ["by", "disposition", "next"]);
      assert.equal(record.acknowledgment.by, record.coordinator, "Acknowledgment needs the coordinator");
    } else {
      assert.equal(record.acknowledgment, undefined);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkHandoffs(JSON.parse(fs.readFileSync(new URL("../../_handoffs/relay-worker-handoffs.json", import.meta.url), "utf8")));
}
