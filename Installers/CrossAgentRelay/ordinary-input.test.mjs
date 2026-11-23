import assert from "node:assert/strict";
import test from "node:test";
import { qualifyOrdinaryInput } from "./fixtures/QualifyOrdinaryInput.mjs";

for (const scenario of ["matched", "different echo", "contradictory echo", "second input", "incomplete index", "unobserved busy"]) {
  test("ordinary input correlation: " + scenario, async () => {
    const thread = "fixture-thread", turn = "fixture-turn", item = "fixture-item";
    let notify, terminal = false;
    const status = type => notify("thread/status/changed", { threadId: thread, status: { type } });
    function start(method, request) {
      assert.equal(method, "turn/start");
      assert.equal(request.threadId, thread);
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
      if (!terminal) {
        queueMicrotask(() => {
          terminal = true;
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
