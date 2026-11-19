import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listenForJobReports, loadJobPolicy, provisionRun, reportJob, startCompletionBroker } from "./completion-broker.mjs";
import { prepareJobRequest } from "./completion-protocol.mjs";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { digest } from "./delivery-protocol.mjs";

const target = { id: "00000000-0000-4000-8000-000000000001", kind: "claude", pid: 17, startedAt: 23, addressable: true };
const instance = digest(JSON.stringify([target.id, target.pid, target.startedAt]));
const policy = { v: 1, grants: [{ id: target.id, provider: target.kind, instance }] };
const ended = { code: 23, signal: null };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-broker-"));
  const policyFile = path.join(root, "completion-policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const dir = path.join(root, "completion-state");
  fs.mkdirSync(dir);
  const file = path.join(dir, "jobs.sqlite");
  await initializeCompletionJobs(file);
  const store = await openCompletionJobs(file, { permits: loadJobPolicy(root), send: assert.fail, status: assert.fail });
  const issue = () => store.issue(target, Date.now() + 60000);
  let listener;
  async function restart(port = 0) {
    if (listener) await listener.close();
    listener = await startCompletionBroker(root, { port });
    return listener.port;
  }
  t.after(async () => {
    if (listener) await listener.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, policyFile, store, issue, restart };
}

test("one wrapper claims a job and a restarted broker acknowledges an identical outcome", async t => {
  const f = await fixture(t);
  const port = await f.restart();
  const grant = f.issue();
  await assert.rejects(reportJob(grant, "complete", ended, { port }));
  const attempts = await Promise.allSettled([1, 2].map(() => reportJob(grant, "claim", null, { port })));
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await f.store.dispatch(grant.id), "claimed");
  await reportJob(grant, "complete", ended, { port });
  await f.restart(port);
  await reportJob(grant, "complete", ended, { port });
  await assert.rejects(reportJob(grant, "complete", { code: 0, signal: null }, { port }));
  await assert.rejects(reportJob(grant, "claim", null, { port }));
});

test("one approved Codex startup grant survives restart and obeys the current policy", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "completion-grants");
  fs.mkdirSync(dir);
  const grants = [{ id: target.id, provider: "codex", scope: "thread-status" }];
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const config = { v: 2, grants, startupRun: { id: target.id, expiresAt } };
  fs.writeFileSync(f.policyFile, JSON.stringify(config));
  const port = await f.restart();
  const [file] = fs.readdirSync(dir);
  const first = fs.readFileSync(path.join(dir, file), "utf8");
  const batch = JSON.parse(first);
  assert.equal(batch.grants.length, 1);
  assert.equal(batch.session, target.id);
  assert.equal(batch.validUntil, Date.parse(expiresAt));
  await f.restart(port);
  assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), first);
  assert.equal(f.store.subscriptions().subscriptions.length, 1);
  await assert.rejects(provisionRun(f.root, target.id, "2", expiresAt));
  await assert.rejects(provisionRun(f.root, target.id, "1", new Date(Date.now() + 120000).toISOString()));
  const event = { session: target.id, provider: "codex" };
  await assert.rejects(reportJob(batch.grants[0], "claim_run", { session: target.id }, { port }));
  await reportJob(batch.grants[0], "claim_run", event, { port });
  await assert.rejects(reportJob(batch.grants[0], "claim_run", event, { port }));
  fs.writeFileSync(f.policyFile, JSON.stringify({ v: 1, grants: [] }));
  await assert.rejects(reportJob(batch.grants[0], "complete", ended, { port }));
  fs.writeFileSync(f.policyFile, JSON.stringify({ ...config, startupRun: { id: target.id, expiresAt: new Date(0).toISOString() } }));
  await f.restart(port);
  await assert.rejects(reportJob(batch.grants[0], "complete", ended, { port }));
});

test("startup issuance requires one matching thread-status grant and a free listener", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "completion-grants");
  fs.mkdirSync(dir);
  const port = await f.restart();
  assert.deepEqual(fs.readdirSync(dir), []);
  const row = { id: target.id, provider: "codex", scope: "thread-status" };
  const request = { id: target.id, expiresAt: new Date(Date.now() + 60000).toISOString() };
  for (const policy of [
    { v: 1, grants: [row], startupRun: request },
    { v: 2, grants: [], startupRun: request },
    { v: 2, grants: [row, row], startupRun: request },
    { v: 2, grants: [{ id: target.id, provider: "claude", instance }], startupRun: request },
    { v: 2, grants: [row], startupRun: { ...request, count: 2 } },
    { v: 2, grants: [row], startupRun: { ...request, id: "00000000-0000-4000-8000-000000000002" } },
  ]) {
    fs.writeFileSync(f.policyFile, JSON.stringify(policy));
    await assert.rejects(startCompletionBroker(f.root, { port: 0 }));
  }
  fs.writeFileSync(f.policyFile, JSON.stringify({ v: 2, grants: [row], startupRun: request }));
  await assert.rejects(startCompletionBroker(f.root, { port }));
  assert.deepEqual(f.store.subscriptions().subscriptions, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a separate wrapper process reports its child's actual exit status over the local listener", async t => {
  const f = await fixture(t);
  const port = await f.restart();
  const grant = f.issue();
  const source = `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { reportJob } from ${JSON.stringify(new URL("./completion-broker.mjs", import.meta.url).href)};
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const { grant, port } = JSON.parse(input);
    await reportJob(grant, "claim", null, { port });
    const child = spawn(process.execPath, ["-e", "process.exitCode=23"], { stdio: "ignore", windowsHide: true });
    const [code, signal] = await once(child, "close");
    await reportJob(grant, "complete", { code, signal }, { port });`;
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "ignore", "pipe"], timeout: 8000, windowsHide: true,
  });
  const closed = once(wrapper, "close");
  let errors = "";
  wrapper.stderr.on("data", chunk => { errors += chunk; });
  wrapper.stdin.end(JSON.stringify({ grant, port }));
  assert.deepEqual(await closed, [0, null], errors);
  // An acknowledgement after restart requires the stored outcome to match.
  await f.restart(port);
  await reportJob(grant, "complete", ended, { port });
  await assert.rejects(reportJob(grant, "complete", { code: 0, signal: null }, { port }));
});

test("reports follow current policy and fail closed on revocation, loss, or malformed policy", async t => {
  const f = await fixture(t);
  const port = await f.restart();
  const grant = f.issue();
  await reportJob(grant, "claim", null, { port });
  for (const replacement of [{ v: 1, grants: [] }, { ...policy, extra: true },
    { v: 1, grants: [{ ...policy.grants[0], instance: "0".repeat(64) }] }]) {
    fs.writeFileSync(f.policyFile, JSON.stringify(replacement));
    await assert.rejects(reportJob(grant, "complete", ended, { port }));
  }
  fs.unlinkSync(f.policyFile);
  await assert.rejects(reportJob(grant, "complete", ended, { port }));
  fs.writeFileSync(f.policyFile, JSON.stringify(policy));
  assert.equal(await f.store.dispatch(grant.id), "claimed");
  f.store.revoke(grant.id);
  await assert.rejects(reportJob(grant, "complete", ended, { port }));
});

test("the wire carries no bearer and acknowledgement authenticates the exact call", async t => {
  const f = await fixture(t);
  const grant = f.issue();
  const original = prepareJobRequest(grant, "claim", null);
  assert.ok(!JSON.stringify(original.frame).includes(grant.capability));
  for (const change of [{ id: f.issue().id }, { op: "complete", event: ended },
    { mac: "0".repeat(64) }, { tail: "fixture" }, { op: "dispatch" }]) {
    assert.throws(() => f.store.acceptFrame({ ...original.frame, ...change }));
  }
  assert.equal(await f.store.dispatch(grant.id), "waiting");
  const ack = f.store.acceptFrame(original.frame);
  assert.equal(original.accepts(ack), true);
  assert.equal(original.accepts({ ack: original.frame.mac }), false);
  const impostor = await listenForJobReports(() => ack, { port: 0 });
  try { await assert.rejects(reportJob(grant, "claim", null, { port: impostor.port })); }
  finally { await impostor.close(); }
});

function raw(port, bytes) {
  const host = Object.values(os.networkInterfaces()).flat().find(e => e.internal && net.isIPv4(e.address)).address;
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    const chunks = [];
    s.setTimeout(4500, () => s.destroy(new Error("fixture deadline")));
    s.on("error", reject);
    s.on("data", chunk => chunks.push(chunk));
    s.once("end", () => resolve(Buffer.concat(chunks).toString()));
    if (bytes !== null) s.end(bytes);
  });
}

test("the listener bounds incomplete frames and rejects duplicates, oversize and trailing bytes before storage", async () => {
  let calls = 0;
  const listener = await listenForJobReports(() => { calls++; return {}; }, { port: 0 });
  try {
    await assert.rejects(listenForJobReports(assert.fail, { port: listener.port }));
    const inputs = ['{"v":1,"v":1}', '{}{}', Buffer.from([255]), 'x'.repeat(769), null];
    for (const r of await Promise.allSettled(inputs.map(bytes => raw(listener.port, bytes)))) {
      if (r.status === "fulfilled") assert.ok(["", "{}"].includes(r.value));
      else assert.equal(r.reason.code, "ECONNRESET");
    }
    assert.equal(calls, 0);
  } finally { await listener.close(); }
});

test("Windows state ACL rejects an inherited read grant outside the broker authorities", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-broker-acl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("./completion-acl.ps1", import.meta.url));
  const script = `
    . $env:RELAY_FIXTURE_SCRIPT
    $dir = $env:RELAY_FIXTURE_DIR
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $dir
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $acl = [IO.Directory]::GetAccessControl($dir, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    [IO.Directory]::SetAccessControl($dir, $acl)
    Assert-BrokerAcl $dir @($owner, $sid.Value) -PrivateState
    $outsider = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($outsider,'Read','ObjectInherit','InheritOnly','Allow'))
    [IO.Directory]::SetAccessControl($dir, $acl)
    try { Assert-BrokerAcl $dir @($owner, $sid.Value) -PrivateState } catch {
        if ($_.Exception.Message -eq 'Excessive broker file access') { exit 0 }
        throw
    }
    exit 1`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, RELAY_FIXTURE_DIR: root, RELAY_FIXTURE_SCRIPT: source }, windowsHide: true, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("Windows handoff directory requires inherited session read and rejects extra readers and writers", {
  skip: process.platform !== "win32",
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-grant-acl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    . $env:RELAY_FIXTURE_SCRIPT
    $dir = $env:RELAY_FIXTURE_DIR
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $dir
    $authorities = @($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value, $me.Value)
    $reader = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001')
    $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    function Rule($sid, $rights) {
        [Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,'ContainerInherit,ObjectInherit','None','Allow')
    }
    function Denied {
        try { Assert-GrantDirectory $dir $authorities $reader.Value } catch { return }
        throw 'A handoff with an unsafe ACL was accepted'
    }
    $acl = [IO.Directory]::GetAccessControl($dir, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((Rule $me 'FullControl'))
    [IO.Directory]::SetAccessControl($dir,$acl)
    Denied
    $acl.AddAccessRule((Rule $reader 'Read'))
    [IO.Directory]::SetAccessControl($dir,$acl)
    $file = Join-Path $dir 'fixture'
    [IO.File]::WriteAllText($file,'')
    Assert-GrantDirectory $dir $authorities $reader.Value
    $childAcl = [IO.File]::GetAccessControl($file)
    $childAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))
    [IO.File]::SetAccessControl($file,$childAcl)
    Denied
    [IO.File]::Delete($file)
    $acl.AddAccessRule((Rule $reader 'Write'))
    [IO.Directory]::SetAccessControl($dir,$acl)
    Denied`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, RELAY_FIXTURE_DIR: dir, RELAY_FIXTURE_SCRIPT: fileURLToPath(new URL("./completion-acl.ps1", import.meta.url)) },
    windowsHide: true, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
