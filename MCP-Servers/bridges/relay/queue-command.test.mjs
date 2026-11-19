import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRunQueue, resolveCodexCommand } from "./client.mjs";

function windows(files, pathValue = "D:\\Wrappers;D:\\Npm Tools") {
  const present = new Set(files);
  return resolveCodexCommand({
    platform: "win32", pathValue, execPath: "D:\\Node Tools\\node.exe",
    existsSync: (file) => present.has(file),
  });
}

test("Windows skips a custom batch wrapper and finds the later npm launcher", () => {
  const js = "D:\\Npm Tools\\node_modules\\@openai\\codex\\bin\\codex.js";
  assert.deepEqual(windows([
    "D:\\Wrappers\\codex.cmd", "D:\\Wrappers\\codex",
    "D:\\Npm Tools\\codex.cmd", js,
  ]), { command: "D:\\Node Tools\\node.exe", prefix: [js] });
});

test("Windows finds a native executable beside an unsupported batch wrapper", () => {
  assert.deepEqual(windows(["D:\\Wrappers\\codex.cmd", "D:\\Wrappers\\codex.exe"]),
    { command: "D:\\Wrappers\\codex.exe", prefix: [] });
});

test("Windows never returns a batch or extensionless wrapper alone", () => {
  assert.equal(windows(["D:\\Wrappers\\codex.cmd", "D:\\Wrappers\\codex"]), null);
});

test("Windows keeps the first supported native executable in PATH order", () => {
  assert.deepEqual(windows(["D:\\Wrappers\\codex.exe", "D:\\Npm Tools\\codex.exe"]),
    { command: "D:\\Wrappers\\codex.exe", prefix: [] });
});

test("empty PATH entries do not search the working directory", () => {
  assert.equal(windows(["codex.exe"], ";;"), null);
});

test("POSIX executable resolution is unchanged", () => {
  assert.deepEqual(resolveCodexCommand({
    platform: "linux", pathValue: "/tools:/usr/bin", execPath: "/usr/bin/node",
    existsSync: (file) => file === "/usr/bin/codex",
  }), { command: "/usr/bin/codex", prefix: [] });
});

test("POSIX npm entry point remains a single unquoted argv prefix", () => {
  const js = "/npm tools/node_modules/@openai/codex/bin/codex.js";
  assert.deepEqual(resolveCodexCommand({
    platform: "linux", pathValue: "/npm tools", execPath: "/node tools/node",
    existsSync: (file) => ["/npm tools/codex", js].includes(file),
  }), { command: "/node tools/node", prefix: [js] });
});

test("queue keeps multiline shell metacharacters in one unchanged argument without a shell", async () => {
  const message = 'line one "quoted" & | %PATH% !value! `tick` $(expression)\nsecond line';
  const command = "D:\\Node Tools\\node.exe";
  const js = "D:\\Npm Tools\\codex.js";
  let calls = 0;
  const result = await defaultRunQueue("synthetic-thread", message, {
    resolveCommand: () => ({ command, prefix: [js] }),
    run(actualCommand, args) {
      calls++;
      assert.equal(actualCommand, command);
      assert.deepEqual(args, [js, "queue", "--thread", "synthetic-thread", "--message", message]);
      return { code: 0, stdout: "synthetic receipt", stderr: "" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.stdout, "synthetic receipt");
});

test("batch-only resolution fails before invoking a process with recovery information", async () => {
  await assert.rejects(defaultRunQueue("synthetic-thread", "message", {
    resolveCommand: () => null,
    run() { assert.fail("No process should start"); },
  }), /No shell-free Codex launcher.*native codex\.exe.*npm launcher/);
});
