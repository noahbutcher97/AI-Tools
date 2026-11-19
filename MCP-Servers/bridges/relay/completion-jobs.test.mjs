import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { localStatus, sendProvedNotice } from "./local-ping.mjs";
import { digest } from "./delivery-protocol.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const target = { id, kind: "claude", pid: 27, startedAt: 123, addressable: true };
const binding = digest(JSON.stringify([id, target.pid, target.startedAt]));
const permits = (to, provider, value) => to === id && provider === "claude" && value === binding;
const event = { code: 23, signal: null };

async function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-completion-"));
  const file = path.join(profile, "jobs.sqlite");
  const opened = [];
  t.after(() => {
    for (const store of opened) store.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await initializeCompletionJobs(file);
  async function open(options = {}) {
    const store = await openCompletionJobs(file, { now: () => 100, permits, ...options });
    opened.push(store);
    return store;
  }
  return { profile, file, open };
}

test("a live ID grants no job authority and the wrapper cannot redirect or attach a tail", async t => {
  const f = await fixture(t);
  const denied = await f.open({ permits: undefined });
  assert.throws(() => denied.issue(target, 200), /denied/);
  const jobs = await f.open({ send: assert.fail, status: assert.fail });
  assert.throws(() => jobs.issue({ ...target, id: other }, 200), /denied/);
  assert.throws(() => jobs.issue({ ...target, kind: "codex" }, 200), /unknown session instance/);
  const grant = jobs.issue(target, 200);
  const second = jobs.issue(target, 200);
  assert.throws(() => jobs.complete(grant.id, second.capability, event), /denied/);
  assert.throws(() => jobs.complete(grant.id, id, event), /denied/);
  assert.throws(() => jobs.complete(grant.id, grant.capability, { code: null, signal: "SIGUNKNOWN" }), /invalid/);
  for (const extra of [{ to: other }, { tail: "fixture" }, { file: "fixture" }]) {
    assert.throws(() => jobs.complete(grant.id, grant.capability, { ...event, ...extra }), /invalid/);
  }
  assert.equal(await jobs.dispatch(grant.id), "waiting");
  jobs.complete(grant.id, grant.capability, event);
  jobs.complete(grant.id, grant.capability, event);
  assert.throws(() => jobs.complete(grant.id, grant.capability, { code: 0, signal: null }), /conflict/);
  jobs.revoke(grant.id);
  assert.equal(await jobs.dispatch(grant.id), "unavailable");
  assert.throws(() => jobs.complete(grant.id, grant.capability, event), /denied/);
});

test("recovery checks the original rendered completion after a lost acknowledgement", async t => {
  const f = await fixture(t);
  let calls = 0, grant, expected;
  const send = (to, message, options) => sendProvedNotice(to, message, { ...options, profile: f.profile,
    capture: async () => ({ id, marker: 4 }), verify: assert.fail,
    send: async invocation => {
      assert.equal(invocation.to, id);
      assert.equal(invocation.kind, "notice");
      assert.equal(invocation.message, "Job " + grant.id + " ended with exit code 23. No reply is needed.");
      const rendered = "fixture header\n" + invocation.message;
      expected = digest(rendered);
      await invocation.beforeSubmit(target, rendered);
      calls++;
      throw new Error("lost acknowledgement");
    },
  });
  const jobs = await f.open({ send });
  grant = jobs.issue(target, 200);
  jobs.complete(grant.id, grant.capability, event);
  await assert.rejects(jobs.dispatch(grant.id), /lost acknowledgement/);
  let proveState = "pending";
  const recovered = await f.open({ send: assert.fail, status: handle => localStatus(handle, { profile: f.profile,
    verify: async (cursor, hash) => {
      assert.deepEqual(cursor, { id, marker: 4 });
      assert.equal(hash, expected);
      return proveState;
    },
  }) });
  assert.equal(await recovered.dispatch(grant.id), "observing");
  proveState = "delivered";
  assert.equal(await recovered.dispatch(grant.id), "delivered");
  assert.equal(await jobs.dispatch(grant.id), "delivered");
  assert.equal(calls, 1);
});

test("policy loss, instance change and expiry prevent resource reads or submission", async t => {
  const f = await fixture(t);
  let allowed = true, clock = 100, live = target, captures = 0, submits = 0;
  const jobs = await f.open({ now: () => clock, permits: (...args) => allowed && permits(...args),
    send: (to, message, options) => sendProvedNotice(to, message, { ...options, profile: f.profile,
      capture: async () => { captures++; allowed = false; return { id }; }, verify: assert.fail,
      send: async invocation => {
        try { await invocation.beforeSubmit(live, "fixture envelope"); }
        catch { return { ok: false }; }
        submits++;
        return { ok: true };
      },
    }),
  });
  const grant = jobs.issue(target, 200);
  jobs.complete(grant.id, grant.capability, event);
  allowed = false;
  assert.equal(await jobs.dispatch(grant.id), "unavailable");
  allowed = true;
  live = { ...target, startedAt: target.startedAt + 1 };
  assert.equal(await jobs.dispatch(grant.id), "ready");
  assert.equal(captures, 0);
  live = target;
  assert.equal(await jobs.dispatch(grant.id), "unavailable");
  assert.equal(captures, 1);
  assert.equal(submits, 0);
  allowed = true;
  clock = 200;
  assert.equal(await jobs.dispatch(grant.id), "unavailable");
});

test("a crash before a durable handle leaves an unknown outcome across workers", async t => {
  const f = await fixture(t);
  const peer = await f.open({ send: assert.fail, status: assert.fail });
  let grant;
  const jobs = await f.open({ send: async () => {
    assert.equal(await peer.dispatch(grant.id), "unknown");
    throw new Error("fixture crash");
  } });
  grant = jobs.issue(target, 200);
  jobs.complete(grant.id, grant.capability, { code: null, signal: "SIGTERM" });
  await assert.rejects(jobs.dispatch(grant.id), /fixture crash/);
  assert.equal(await peer.dispatch(grant.id), "unknown");
});

test("revocation after submission prevents proof reads until independently authorized", async t => {
  const f = await fixture(t);
  let allowed = true, calls = 0, reads = 0;
  const status = handle => {
    reads++;
    return localStatus(handle, { profile: f.profile, verify: async () => "delivered" });
  };
  const jobs = await f.open({ permits: (...args) => allowed && permits(...args), status,
    send: (to, message, options) => sendProvedNotice(to, message, { ...options, profile: f.profile,
      capture: async () => ({ id }), verify: assert.fail, send: async invocation => {
        await invocation.beforeSubmit(target, "fixture bytes");
        calls++;
        allowed = false;
        return { ok: true };
      },
    }),
  });
  const grant = jobs.issue(target, 200);
  jobs.complete(grant.id, grant.capability, event);
  assert.equal(await jobs.dispatch(grant.id), "unavailable");
  assert.equal(reads, 0);
  const peer = await f.open({ status, send: assert.fail });
  assert.equal(await peer.dispatch(grant.id), "delivered");
  assert.equal(reads, 1);
  assert.equal(calls, 1);
});

test("failed asynchronous receipt persistence prevents submission", async t => {
  const f = await fixture(t);
  let submits = 0;
  const result = await sendProvedNotice(id, "fixture", { profile: f.profile, capture: async () => ({ id }),
    onHandle: async () => { throw new Error("fixture storage unavailable"); }, verify: assert.fail,
    send: async invocation => {
      try { await invocation.beforeSubmit(target, "fixture"); } catch { return { ok: false }; }
      submits++;
      return { ok: true };
    },
  });
  assert.equal(result.state, "dispatch_failed");
  assert.equal(submits, 0);
});
