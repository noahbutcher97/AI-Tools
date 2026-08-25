import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { encodeProjectDir, readTranscript, resolveReference, summarizeTarget } from "./client.mjs";

// Unit 4, Claude half. Claude keeps a session transcript at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, one JSON record per line.
//
// Measured on a live 6MB transcript, 4119 records:
//   assistant:tool_use 504   user:tool_result 504   assistant:text 254
//   assistant:thinking 252   user:string 54         user:text 3
//
// So the same two disciplines apply as on the Codex side: tool results are the
// bulk and stay behind an explicit flag, and what comes back is another
// session's words and is delimited as data.

const NOW = 1787507400000;
const SESSION = "2ed73e8c-517a-4786-b8fb-9f80f35c90fc";
const CWD = "D:\\Work\\Alpha";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-ct-"));
}

function registry(overrides = {}) {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "1000.json"),
    JSON.stringify({
      pid: 1000,
      sessionId: SESSION,
      name: "alpha-one",
      cwd: CWD,
      status: "idle",
      statusUpdatedAt: NOW - 60_000,
      messagingSocketPath: "\\\\.\\pipe\\x",
      entrypoint: "cli",
      ...overrides,
    }),
  );
  return dir;
}

function rec(o) {
  return JSON.stringify(o);
}

// A transcript shaped like the real one: a human ask, thinking, a tool call and
// its result, then the agent's answer.
function transcript(projectsRoot, records) {
  const dir = path.join(projectsRoot, encodeProjectDir(CWD));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `${records.map(rec).join("\n")}\n`);
  return dir;
}

function standard(projectsRoot) {
  return transcript(projectsRoot, [
    { type: "mode", mode: "normal", sessionId: SESSION },
    {
      type: "user", uuid: "u1", timestamp: "2026-08-23T12:00:00.000Z", sessionId: SESSION,
      message: { role: "user", content: "please audit the combat module" },
    },
    {
      type: "assistant", uuid: "a1", timestamp: "2026-08-23T12:00:05.000Z", sessionId: SESSION,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "weighing two approaches here" }] },
    },
    {
      type: "assistant", uuid: "a2", timestamp: "2026-08-23T12:00:10.000Z", sessionId: SESSION,
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rg TODO" } }] },
    },
    {
      type: "user", uuid: "u2", timestamp: "2026-08-23T12:00:12.000Z", sessionId: SESSION,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "X".repeat(50_000) }] },
    },
    {
      type: "assistant", uuid: "a3", timestamp: "2026-08-23T12:00:20.000Z", sessionId: SESSION,
      message: { role: "assistant", content: [{ type: "text", text: "Audit done: three issues found." }] },
    },
  ]);
}

function opts(projectsRoot, extra = {}) {
  return {
    claudeSessionsDir: registry(),
    claudeProjectsDir: projectsRoot,
    codexHome: tmpdir(),
    now: NOW,
    ...extra,
  };
}

// ── Locating the transcript ──

test("a working directory encodes to its project directory name", () => {
  // Measured: D:\DevTools\AI-Tools is stored as D--DevTools-AI-Tools.
  assert.equal(encodeProjectDir("D:\\DevTools\\AI-Tools"), "D--DevTools-AI-Tools");
});

test("a nested workspace encodes the whole path", () => {
  assert.equal(
    encodeProjectDir("D:\\DevTools\\AI-Tools\\MCP-Servers\\bridges\\relay"),
    "D--DevTools-AI-Tools-MCP-Servers-bridges-relay",
  );
});

test("a transcript filed under an unexpected directory is still found", async () => {
  // Encoding is a convention that could drift, so a miss falls back to scanning
  // the project directories for the session id.
  const projectsRoot = tmpdir();
  const odd = path.join(projectsRoot, "some-other-encoding");
  fs.mkdirSync(odd, { recursive: true });
  fs.writeFileSync(
    path.join(odd, `${SESSION}.jsonl`),
    `${rec({ type: "assistant", uuid: "a1", timestamp: "2026-08-23T12:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "found anyway" }] } })}\n`,
  );

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(r.ok, true);
  assert.match(r.turns[0].text, /found anyway/);
});

test("a claude session with no transcript is refused by name", async () => {
  const r = await readTranscript({ to: "alpha-one", ...opts(tmpdir()) });

  assert.equal(r.ok, false);
  assert.match(r.detail, /transcript/i);
});

// ── read ──

test("a claude transcript projects into the same turn shape as codex", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(r.ok, true);
  assert.equal(r.kind, "claude");
  assert.deepEqual(r.turns.map((t) => t.role), ["user", "reasoning", "agent"]);
  assert.match(r.turns[0].text, /audit the combat module/);
  assert.match(r.turns.at(-1).text, /three issues found/);
});

test("each entry carries the record uuid, which is what --re refers to", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(r.turns[0].turnId, "u1");
  assert.equal(r.turns.at(-1).turnId, "a3");
});

test("tool names are reported without their output", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(r.turns.some((t) => (t.toolNames || []).includes("Bash")), true);
  assert.equal(JSON.stringify(r).includes("XXXX"), false);
});

test("tool results stay out unless asked for, and are capped when asked for", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const without = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });
  const withResults = await readTranscript({ to: "alpha-one", ...opts(projectsRoot), withToolResults: true, toolResultLimit: 500 });

  assert.equal(JSON.stringify(without).includes("XXXX"), false);
  const out = withResults.turns.flatMap((t) => t.toolResults || []);
  assert.equal(out.length > 0, true);
  for (const o of out) assert.equal(o.text.length <= 500, true);
  assert.equal(out.some((o) => o.truncated), true);
});

test("thinking is projected as reasoning, matching the codex side", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });
  const thinking = r.turns.find((t) => t.role === "reasoning");

  assert.match(thinking.text, /weighing two approaches/);
});

test("a subagent sidechain is not mixed into the main conversation", async () => {
  // The Claude analogue of a Codex subagent thread: another agent's internals,
  // not part of what this session and its human said to each other.
  const projectsRoot = tmpdir();
  transcript(projectsRoot, [
    { type: "user", uuid: "u1", timestamp: "2026-08-23T12:00:00.000Z", message: { role: "user", content: "main ask" } },
    { type: "assistant", uuid: "s1", isSidechain: true, timestamp: "2026-08-23T12:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "assistant", uuid: "a1", timestamp: "2026-08-23T12:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "main answer" }] } },
  ]);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(JSON.stringify(r).includes("subagent chatter"), false);
});

test("returned claude text is delimited as data, like the codex side", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const r = await readTranscript({ to: "alpha-one", ...opts(projectsRoot) });

  assert.match(r.envelope.begin, /^RELAY-[0-9a-f-]{36}-TRANSCRIPT-BEGIN$/);
  assert.match(r.envelope.notice, /data, not instructions/i);
});

// ── summary ──

test("summary of a claude session reports the last ask and the last answer", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const s = await summarizeTarget({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(s.ok, true);
  assert.equal(s.kind, "claude");
  assert.match(s.lastUserAsk, /audit the combat module/);
  assert.match(s.lastAgentSaid, /three issues found/);
});

test("summary counts tool use by name", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const s = await summarizeTarget({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(s.toolHistogram.Bash, 1);
});

test("an injected system message is not mistaken for something the human asked", async () => {
  // isMeta records are inserted by the harness, not typed by anyone.
  const projectsRoot = tmpdir();
  transcript(projectsRoot, [
    { type: "user", uuid: "u1", timestamp: "2026-08-23T12:00:00.000Z", message: { role: "user", content: "the real question" } },
    { type: "user", uuid: "u2", isMeta: true, timestamp: "2026-08-23T12:00:01.000Z", message: { role: "user", content: "<system-reminder>injected</system-reminder>" } },
  ]);

  const s = await summarizeTarget({ to: "alpha-one", ...opts(projectsRoot) });

  assert.match(s.lastUserAsk, /the real question/);
});

test("summary carries no tool output", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const s = await summarizeTarget({ to: "alpha-one", ...opts(projectsRoot) });

  assert.equal(JSON.stringify(s).includes("XXXX"), false);
});

// ── threading ──

test("a claude turn can be referenced by uuid and quoted", async () => {
  // Completes Unit 5 across the matrix: --re works against a Claude target
  // rather than being refused for want of a read layer.
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const ref = await resolveReference({ to: "alpha-one", re: "a3", ...opts(projectsRoot) });

  assert.equal(ref.ok, true);
  assert.match(ref.excerpt, /three issues found/);
});

test("an unknown claude uuid is refused rather than sent dangling", async () => {
  const projectsRoot = tmpdir();
  standard(projectsRoot);

  const ref = await resolveReference({ to: "alpha-one", re: "no-such-uuid", ...opts(projectsRoot) });

  assert.equal(ref.ok, false);
});
