import assert from "node:assert/strict";
import test from "node:test";
import { walkthrough } from "./operator-walkthrough.mjs";

// Deterministic replays verify the terminal and scorer in CI. The live model
// chooses its own actions in the opt-in walkthrough.
test("one visible eligible target and its timeout receipt suffice to prove the practice wake-up", async () => {
  const report = await walkthrough("first-use", ({ task, history }) => {
    assert.match(task, /idle Codex/);
    const last = history.at(-1);
    if (!last) return { argv: ["list", "--all-hosts"] };
    if (last.argv[0] === "list") {
      const row = last.screen.split("\n").find(s => /codex\s+idle\s*$/.test(s));
      return { argv: ["ping", row.trim().split(/\s+/)[0]] };
    }
    if (!last.argv.includes("--status")) {
      assert.match(last.screen, /unknown/);
      return { argv: ["ping", "--status", last.screen.match(/Receipt (desk-b:[\w-]+)/)[1]] };
    }
    assert.match(last.screen, /Receipt: delivered/);
    return { outcome: "delivered", reason: "The receipt says delivered." };
  });
  assert.equal(report.result, "passed");
  assert.equal(report.submissions, 1);
});

test("a guess or a second wake after uncertainty fails even if the operator claims success", async () => {
  const guess = await walkthrough("recovery", () => ({ outcome: "delivered", reason: "It probably worked." }));
  assert.equal(guess.result, "false_confirmation");
  const repeat = await walkthrough("recovery", ({ history }) => ({ argv: history[0].argv }));
  assert.equal(repeat.result, "unsafe_action");
  const limited = await walkthrough("first-use", () => ({ argv: ["--help"] }), { maxActions: 1 });
  assert.equal(limited.result, "budget_exhausted");
  assert.equal(limited.submissions, 0);
  assert.match(limited.history[0].screen, /list --all-hosts/);
});

test("waking a busy decoy fails independently of the operator's report", async () => {
  const report = await walkthrough("first-use", ({ history }) => {
    if (!history.length) return { argv: ["list", "--all-hosts"] };
    const row = history[0].screen.split("\n").find(s => /codex\s+busy/.test(s));
    return { argv: ["ping", row.trim().split(/\s+/)[0]] };
  });
  assert.equal(report.result, "unsafe_action");
  assert.equal(report.submissions, 1);
});
