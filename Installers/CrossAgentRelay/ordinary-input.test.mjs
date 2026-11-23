import assert from "node:assert/strict";
import test from "node:test";
import { qualifyOrdinaryInput } from "./fixtures/QualifyOrdinaryInput.mjs";

for (const scenario of ["matched", "different echo", "contradictory echo", "second input", "incomplete index",
  "unobserved busy", "status gap"]) {
  test("ordinary input correlation: " + scenario, async () => {
    const thread = "fixture-thread", turn = "fixture-turn", item = "fixture-item";
    let notify, terminal = false, submitted = false;
    const status = type => notify("thread/status/changed", { threadId: thread, status: { type } });
    function start(method, request) {
      assert.equal(method, "turn/start");
      assert.equal(request.threadId, thread);
      submitted = true;
      if (scenario !== "unobserved busy") status("active");
      if (scenario === "contradictory echo") {
        notify("item/started", { threadId: thread, turnId: turn, item: { type: "userMessage", id: item, clientId: "other" } });
      }
      notify("item/completed", { threadId: thread, turnId: turn, item: { type: "userMessage",
        id: item, clientId: scenario === "different echo" ? "other" : request.clientUserMessageId } });
      notify("item/completed", { threadId: "another thread", turnId: turn, item: { type: "userMessage", id: "unrelated" } });
      return { turn: { id: turn } };
    }
    function readTurns(id) {
      assert.equal(id, thread);
      if (!submitted) return [];
      if (!terminal) {
        queueMicrotask(() => {
          terminal = true;
          if (scenario === "status gap") status("notLoaded");
          notify("turn/completed", { threadId: thread, turn: { id: turn, status: "completed" } });
          status("idle");
        });
        return [{ turn_id: turn, status: "inProgress" }];
      }
      return [{ turn_id: turn, status: "completed", completed_at: 1, inputsComplete: scenario !== "incomplete index",
        inputs: scenario === "second input" ? [item, "other"] : [item] }];
    }
    const result = await qualifyOrdinaryInput(thread, start, callback => { notify = callback; }, readTurns);
    assert.equal(result.confirmed, scenario === "matched");
    assert.equal(notify, undefined);
    assert.ok(Object.values(result).every(value => typeof value === "boolean"));
  });
}

for (const phase of ["before", "after"]) {
  test("unavailable metadata " + phase + " submission has a bounded diagnostic", async () => {
    let calls = 0, listener;
    function readTurns() {
      if (phase === "after" && !calls) return [];
      throw Error("fixture-private-storage-detail");
    }
    await assert.rejects(qualifyOrdinaryInput("fixture", () => {
      calls++;
      return { turn: { id: "turn" } };
    }, value => { listener = value; }, readTurns), { message: "Turn metadata unavailable " + phase + " submission." });
    assert.equal(calls, phase === "after" ? 1 : 0);
    assert.equal(listener, undefined);
  });
}
