import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sessionDelivery, serveSession, completionText, frameIO } from "./completion-session.mjs";
import { installedDelegate, installedQueue } from "./completion-worker.mjs";
import { scheduleNotice, changeNotice } from "./completion-protocol.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const body = "Job " + id + " ended with exit code 23. No reply is needed.";
const handle = "local-proof." + "b".repeat(80);
const target = { id, kind: "claude", pid: 42, startedAt: 137, addressable: true, name: "fixture" };
const binding = { id, kind: "claude", pid: 42, startedAt: 137, addressable: true };

function exchanges(worker) {
  return async operation => {
    const requests = new PassThrough(), responses = new PassThrough();
    const done = serveSession(frameIO(requests,responses), worker).finally(() => responses.end());
    try { return await operation(frameIO(responses,requests)); }
    finally { requests.end(); await done; }
  };
}

for (const notice of [scheduleNotice, changeNotice]) {
  test("worker confines fixed thread notice: " + notice, async () => {
    let observed = target, submitted = 0, calls = 0;
    const adapter = sessionDelivery("", exchanges({ status: assert.fail, send: async (to, text, opts) => {
      calls++;
      assert.equal(opts.allowDelegate, false);
      assert.equal(text, notice);
      await opts.checkTarget(observed);
      await opts.onHandle(handle, observed);
      submitted++;
      return { state: "pending" };
    } }));
    const options = { checkTarget() {}, onHandle() {} };
    await assert.rejects(adapter.send(id, notice + " extra", options));
    assert.equal(calls, 0);
    assert.equal((await adapter.send(id, notice, options)).state, "dispatch_failed");
    assert.equal(submitted, 0);
    observed = { id, kind: "codex", name: id, pid: null, startedAt: null, addressable: true };
    assert.equal((await adapter.send(id, notice, options)).state, "pending");
    assert.equal(submitted, 1);
  });
}

test("authenticated worker check performs no provider or transcript operations", async () => {
  const adapter = sessionDelivery("", exchanges({ enabled: () => false, send: assert.fail, status: assert.fail }));
  assert.equal(await adapter.check(), true);
  assert.deepEqual(await adapter.send(id, body, { onHandle: assert.fail, checkTarget: assert.fail }), { state: "dispatch_failed" });
  assert.deepEqual(await adapter.status(handle), { state: "proof_unavailable" });
});

test("worker reads the cursor after authorization and submits only after durable reservation", async () => {
  const calls = [];
  const adapter = sessionDelivery("", exchanges({ status: async h => {
    assert.equal(h, handle); return { to: id, state: "delivered" };
  }, send: async (to, text, opts) => {
    assert.equal(to, id); assert.equal(text, body); assert.equal(opts.deferProof, true);
    await opts.checkTarget(target);
    calls.push("capture");
    await opts.onHandle(handle, target);
    calls.push("submit");
    return { state: "pending" };
  } }));
  const result = await adapter.send(id, body, {
    checkTarget(t) { assert.deepEqual(t, binding); calls.push("authorize"); },
    onHandle(h, t) { assert.equal(h, handle); assert.deepEqual(t, binding); calls.push("reserve"); },
  });
  assert.deepEqual(result, { state: "pending" });
  assert.deepEqual(calls, ["authorize","capture","reserve","submit"]);
  assert.deepEqual(await adapter.status(handle), { state: "delivered", to: id });
});

test("changed target or revoked grant prevents submit, and an interrupted reserved send is unknown", async () => {
  for (const step of ["wrong session", "invalid name", "denied", "revoked", "lost reply"]) {
    let submitted = 0, captures = 0;
    const t = step === "wrong session" ? { ...target, id: "different" } : step === "invalid name" ? { ...target, name: "a\nb" } : target;
    const adapter = sessionDelivery("", exchanges({ status: assert.fail, send: async (_to, _text, opts) => {
      await opts.checkTarget(t);
      captures++;
      await opts.onHandle(handle, t);
      submitted++;
      throw Error("lost reply");
    } }));
    const result = await adapter.send(id, body, {
      checkTarget() { if (step === "denied") throw Error("denied"); },
      onHandle() { if (step === "revoked") throw Error("revoked"); },
    });
    assert.equal(captures, ["revoked","lost reply"].includes(step) ? 1 : 0);
    assert.equal(submitted, step === "lost reply" ? 1 : 0);
    assert.equal(result.state, step === "lost reply" ? "unknown" : "dispatch_failed");
  }
});

test("only status and bounded completion notices cross the worker channel", async () => {
  const frames = [{ op: "send", to: id, body, command: "fixture" }, { op: "status", handle, path: "fixture" },
    { op: "send", to: id, body: body + "\nrun fixture" }, { op: "check", grant: "fixture" }, { op: "issue" }];
  for (const req of frames) {
    const replies = [];
    await serveSession({ read: async () => req, write: async x => replies.push(x) }, { send: assert.fail, status: assert.fail });
    assert.deepEqual(replies, [{ op: "failed" }]);
  }
  assert.ok(completionText(body));
  for (const text of [body.replace("23", "000"),body.replace("23", "4294967296"),body.replace("exit code 23","signal SIGINVALID"),
    Array(9).fill(body.split(". No reply")[0]+".").join("\n")+" No reply is needed."]) assert.equal(completionText(text), false);
  for (const text of ['{"op":"status","op":"check"}\n', '{} {}\n', 'x'.repeat(13000)]) {
    await assert.rejects(frameIO(Readable.from([Buffer.from(text)]), null).read());
  }
});

test("installed delegate uses the protected executable, empty cwd and fixed isolation options", () => {
  const root = path.resolve("fixture");
  installedDelegate(root, { command: "untrusted", args: ["-p","--tools","SendMessage"], stdin: "fixture" }, (cmd, args, opts) => {
    assert.equal(cmd, path.join(root,"provider","claude.exe"));
    assert.deepEqual(args, ["--model","haiku","--effort","low","--setting-sources","","--settings",'{"disableAllHooks":true}',"-p","--tools","SendMessage"]);
    assert.deepEqual(opts, { cwd: path.join(root,"worker-cwd"), stdin: "fixture" });
  });
});

test("a Codex worker submits only an exact thread address through the installed native queue", async () => {
  const root = path.resolve("fixture");
  const actual = { ...target, kind: "codex", pid: null, startedAt: null, name: id };
  for (const name of [id, "different"]) {
    let queued = 0;
    const adapter = sessionDelivery(root, exchanges({ status: assert.fail, send: async (to, text, opts) => {
      await opts.checkTarget({ ...actual, name });
      await opts.onHandle(handle, actual);
      installedQueue(root, to, text, (cmd, argv, options) => {
        assert.equal(cmd, path.join(root, "provider", "codex.exe"));
        assert.deepEqual(argv, ["queue", "--thread", id, "--message", body]);
        assert.deepEqual(options, { cwd: path.join(root, "worker-cwd") });
        queued++;
      });
      return { state: "pending" };
    } }));
    const result = await adapter.send(id, body, { checkTarget(t) { assert.equal(t.kind, "codex"); }, onHandle() {} });
    assert.equal(result.state, name === id ? "pending" : "dispatch_failed");
    assert.equal(queued, name === id ? 1 : 0);
  }
});

test("Windows authenticates both named pipe peers before transferring data", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-channel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, "channel-check.exe");
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const src = name => fileURLToPath(new URL(name, import.meta.url));
  const build = spawnSync(compiler, ["/nologo","/r:System.Web.Extensions.dll","/main:CompletionChannelCheck","/out:" + exe,
    src("CompletionChannel.cs"),src("fixtures/CompletionChannelCheck.cs")], { encoding: "utf8", windowsHide: true });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const result = spawnSync(exe, [], { timeout: 15000, windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
