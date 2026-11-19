import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parseDirectory, queryFleet, sshInvocation, inventory } from "./fleet.mjs";
import { receive } from "./receive.mjs";
import { parseArgs } from "./client.mjs";

const hosts = ["host-a", "host-b", "host-c"].map((host) => ({
  host, endpoint: host, port: 22, user: "operator",
}));
const directory = parseDirectory({ host: "host-a" }, hosts);

test("host configuration admits only typed operands", () => {
  for (const change of [{ host: "-o" }, { endpoint: "name@host" }, { endpoint: "x y" },
    { port: "22" }, { proxy: "custom" }, { user: "name\nother" }]) {
    assert.throws(() => parseDirectory({ host: "host-a" }, [hosts[0], { ...hosts[1], ...change }]));
  }
  assert.throws(() => parseDirectory({ host: "host-a" }, [hosts[0], hosts[0]]));
  assert.throws(() => parseDirectory({ host: "absent" }, hosts));
});

test("SSH client uses pinned trust, one credential and a literal receive command", () => {
  const { command, args } = sshInvocation(hosts[1]);
  assert.ok(path.isAbsolute(command));
  assert.deepEqual(args.slice(-3), ["--", "host-b", "relay receive"]);
  assert.deepEqual(args.slice(0, 3), ["-F", "none", "-T"]);
  assert.equal(args.filter((arg) => arg === "-i").length, 1);
  assert.deepEqual(args.filter((v, i) => args[i - 1] === "-o"), [
    "BatchMode=yes", "ConnectTimeout=2", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes",
    "IdentityAgent=none", "PreferredAuthentications=publickey", "ControlPath=none",
    "ClearAllForwardings=yes", "ForwardAgent=no", "ProxyCommand=none", "GlobalKnownHostsFile=none",
    args.find((arg) => arg.startsWith("UserKnownHostsFile=")), "HostKeyAlias=host-b",
  ]);
  assert.match(args.find((arg) => arg.startsWith("UserKnownHostsFile=")), /known_hosts"$/);
});

test("fleet probes start concurrently and preserve an offline peer", async () => {
  const pending = new Map();
  const result = queryFleet("probe", { directory, query: (entry, request) => new Promise((resolve) => {
    pending.set(entry.host, { request, resolve });
  }) });
  assert.equal(pending.size, 2);
  const healthy = pending.get("host-b");
  healthy.resolve({ reply: { ...healthy.request, ok: true, host: "host-b", peer: "host-a" } });
  pending.get("host-c").resolve({ error: "offline" });
  const fleet = await result;
  assert.deepEqual(fleet.hosts.map((h) => h.status), ["ready", "ready", "offline"]);
  assert.equal(fleet.complete, false);
  assert.equal(fleet.delivery, "not_attempted");
});

test("fleet inventory rejects mismatched or overbroad peer replies", async () => {
  const fleet = await queryFleet("inventory", {
    directory, localInventory: async () => ({ targets: [], partial: false }),
    query: async (entry, request) => ({ reply: { ...request, host: entry.host, peer: "host-a",
      ok: true, partial: false, targets: [], ...(entry.host === "host-b" ? { localPath: "private" } : { requestId: "wrong" }) } }),
  });
  assert.deepEqual(fleet.hosts.map((h) => h.status), ["ready", "invalid_response", "invalid_response"]);
  assert.equal(JSON.stringify(fleet).includes("private"), false);
});

test("inventory through receive projects metadata and strips private fields", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "registry");
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(root, "thread-writer-locks"));
  fs.writeFileSync(path.join(dir, "1000.json"), JSON.stringify({ pid: 1000, name: "worker", sessionId: "session-a",
    status: "busy", cwd: "private-folder", messagingSocketPath: "private-endpoint" }));
  const request = { v: 1, requestId: "00000000-0000-4000-8000-000000000001", op: "inventory" };
  const reply = await receive(["--peer", "host-a", "--host", "host-b"], "relay receive",
    Readable.from([Buffer.from(JSON.stringify(request))]), 3000, () => inventory({ claudeSessionsDir: dir, codexHome: root }));
  assert.deepEqual(reply.targets, [{ id: "session-a", kind: "claude", addressable: true, status: "busy" }]);
  assert.equal(JSON.stringify(reply).includes("private"), false);
});

test("fleet selection is explicit on CLI", () => {
  assert.equal(parseArgs(["list", "--all-hosts"]).allHosts, true);
  assert.equal(parseArgs(["ping", "--all-hosts"]).allHosts, true);
  assert.throws(() => parseArgs(["ping"]));
  assert.throws(() => parseArgs(["send", "worker", "--all-hosts"]));
});
