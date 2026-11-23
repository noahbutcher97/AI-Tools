import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readTrialTurns } from "./fixtures/ReadTurnMetadata.mjs";
import { createCandidateObserver } from "./fixtures/ObserveTurnCandidates.mjs";

function trial(t) {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "relay-candidates-"));
  const dir = path.join(profile, ".codex");
  fs.mkdirSync(dir);
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  t.after(() => { db.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  // A read of message content would fail against this schema.
  db.exec("CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,root_turn_id,first_user_item_id);" +
    "CREATE TABLE thread_items(thread_id,turn_id,item_id,item_type,rollout_ordinal)");
  const scope = { machine: "local", provider: "fixture", thread: randomUUID(), store: randomUUID(), writer: randomUUID() };
  const candidates = [];
  const state = { allowed: true, sampleScope: scope, writerState: "busy", reads: 0 };
  const adapters = {
    authorize: () => state.allowed,
    readSample() {
      state.reads++;
      return { scope: state.sampleScope, writerState: state.writerState, turn: readTrialTurns(scope.thread, profile).at(-1) };
    },
    readFinalCauses: () => state.receipt,
    cursors: new Map(),
    record: kind => candidates.push(kind),
  };
  let ordinal = 0, inputOrdinal = 0, turn;
  function begin() {
    turn = randomUUID();
    ordinal++;
    db.prepare("INSERT INTO thread_turns VALUES(?,?,?,'inProgress',1,NULL,?,NULL)").run(scope.thread, turn, ordinal, turn);
    state.writerState = "busy";
    state.receipt = undefined;
    return turn;
  }
  function input() {
    const id = randomUUID();
    db.prepare("INSERT INTO thread_items VALUES(?,?,?,'userMessage',?)").run(scope.thread, turn, id, ++inputOrdinal);
    return id;
  }
  function complete(writerState = "idle") {
    db.prepare("UPDATE thread_turns SET status='completed', completed_at=2 WHERE turn_id=?").run(turn);
    state.writerState = writerState;
  }
  // The fixture supplies independently retained provenance for the final
  // input set. Codex indexed userMessage rows supply only the IDs.
  function attest(...ids) {
    state.receipt = { scope, turn, finalized: true, inputs: ids.map(id => ({ id, origin: "ordinary" })) };
  }
  const restart = () => createCandidateObserver(scope, adapters);
  return { scope, adapters, candidates, state, begin, complete, input, attest, restart, poll: restart() };
}

test("one completed ordinary turn and a later live idle sample each record one candidate", t => {
  const f = trial(t);
  f.begin();
  const first = f.input(), second = f.input();
  f.poll();
  f.attest(second, first);
  f.complete("busy");
  f.poll();
  f.poll();
  assert.deepEqual(f.candidates, ["turn-completed"]);
  f.state.writerState = "idle";
  f.poll();
  f.poll();
  f.state.writerState = "busy";
  f.poll();
  f.state.writerState = "idle";
  f.poll();
  assert.deepEqual(f.candidates, ["turn-completed", "busy-to-idle"]);
});

test("the first terminal snapshot only baselines and a later unsampled busy interval proves only completion", t => {
  const f = trial(t);
  f.begin();
  f.attest(f.input());
  f.complete();
  f.poll();
  assert.deepEqual(f.candidates, []);
  f.begin();
  f.attest(f.input());
  f.complete();
  f.poll();
  assert.deepEqual(f.candidates, ["turn-completed"]);
});

test("only complete, independently attributed ordinary inputs for the exact scope and turn qualify", async t => {
  const controls = {
    "no receipt despite an ordinary label on the sample": f => {
      f.state.receipt = undefined;
      const read = f.adapters.readSample;
      f.adapters.readSample = () => ({ ...read(), origin: "ordinary" });
    },
    "unfinalized ordinary receipt": f => { f.state.receipt.finalized = false; },
    "different turn": f => { f.state.receipt.turn = randomUUID(); },
    "different input": f => { f.state.receipt.inputs[0].id = randomUUID(); },
    "duplicate receipt IDs": f => { f.state.receipt.inputs.push(f.state.receipt.inputs[0]); f.input(); },
    "more inputs than accounted for": f => { f.input(); },
    "third input beyond the projection": f => { f.state.receipt.inputs.push({ id: f.input(), origin: "ordinary" }); f.input(); },
    "notice alone": f => { f.state.receipt.inputs[0].origin = "watcher"; },
    "unknown source": f => { f.state.receipt.inputs[0].origin = "unknown"; },
    "ordinary input with a pause notice": f => { f.state.receipt.inputs.push({ id: f.input(), origin: "pause-notice" }); },
  };
  for (const key of ["machine", "provider", "thread", "store", "writer"]) {
    controls["different receipt " + key] = f => { f.state.receipt.scope = { ...f.scope, [key]: randomUUID() }; };
  }
  for (const [name, change] of Object.entries(controls)) await t.test(name, t => {
    const f = trial(t);
    f.begin();
    f.attest(f.input());
    change(f);
    const poll = f.restart();
    poll();
    f.complete();
    poll();
    assert.deepEqual(f.candidates, []);
  });
});

test("restart baselines a missed completion, rechecks the grant and accepts a fresh observed turn", t => {
  const f = trial(t);
  f.begin();
  f.attest(f.input());
  f.poll();
  f.complete();
  f.adapters.cursors = new Map(JSON.parse(JSON.stringify([...f.adapters.cursors])));
  const coldPoll = f.restart();
  f.state.allowed = false;
  coldPoll();
  assert.equal(f.state.reads, 1);
  f.state.allowed = true;
  coldPoll();
  coldPoll();
  assert.deepEqual(f.candidates, []);
  f.begin();
  coldPoll();
  f.attest(f.input());
  f.complete();
  coldPoll();
  assert.deepEqual(f.candidates, ["turn-completed", "busy-to-idle"]);
});

test("interrupted or mismatched observation cannot bridge the gap to a completion", async t => {
  for (const field of ["writerState", "writer", "store", "thread", "provider", "machine"]) await t.test(field, t => {
    const f = trial(t);
    f.begin();
    f.attest(f.input());
    f.poll();
    if (field === "writerState") f.state.writerState = "unavailable";
    else f.state.sampleScope = { ...f.scope, [field]: randomUUID() };
    f.poll();
    f.state.sampleScope = f.scope;
    f.complete();
    f.poll();
    assert.deepEqual(f.candidates, []);
  });
});

test("revoking observation during the cause lookup suppresses both candidates", t => {
  const f = trial(t);
  f.adapters.readFinalCauses = () => { f.state.allowed = false; return f.state.receipt; };
  const poll = f.restart();
  f.begin();
  f.attest(f.input());
  poll();
  f.complete();
  poll();
  assert.deepEqual(f.candidates, []);
});

test("an ambiguous completion while busy cannot become an idle candidate on a later poll", t => {
  const f = trial(t);
  f.begin();
  const id = f.input();
  f.poll();
  f.complete("busy");
  f.poll();
  f.attest(id);
  f.state.writerState = "idle";
  f.poll();
  assert.deepEqual(f.candidates, []);
});

test("a stale sample cannot reopen an already counted turn or rewind the cursor", t => {
  const f = trial(t);
  let replay;
  const read = f.adapters.readSample;
  f.adapters.readSample = () => replay ?? read();
  const poll = f.restart();
  f.begin();
  f.attest(f.input());
  const busy = read();
  poll();
  f.complete();
  poll();
  replay = busy;
  poll();
  replay = undefined;
  poll();
  f.begin();
  poll();
  replay = busy;
  poll();
  replay = undefined;
  f.attest(f.input());
  f.complete();
  poll();
  assert.deepEqual(f.candidates, ["turn-completed", "busy-to-idle"]);
});
