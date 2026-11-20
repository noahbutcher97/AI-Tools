import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { branchCredentialBinding, installedCredentialRecord, sampleAnonymousBranch, sampleInstalledBranch, validBranchResource } from "./branch-observation.mjs";

const endpoint = "https://" + ["fixture","invalid"].join(".") + "/fixture/repo";
const ref = "refs/heads/fixture";
const profile = { image: "X:/git/bin/git.exe", execPath: "X:/git/helpers", cwd: "X:/watch/empty", windows: "X:/system" };
const revision = "a".repeat(40);

test("anonymous Git observation runs a single configured HTTPS ref query in an isolated environment", async () => {
  let calls = 0;
  const run = async (command, args, options) => {
    calls++;
    assert.equal(command, profile.image);
    assert.deepEqual(args.slice(-6), ["ls-remote","--exit-code","--refs","--",endpoint,ref]);
    assert.deepEqual(args.slice(0,-6), ["-c","protocol.allow=never","-c","protocol.https.allow=always",
      "-c","credential.helper=","-c","credential.interactive=false","-c","http.emptyAuth=false","-c","http.proxy=",
      "-c","http.followRedirects=false","-c","http.sslVerify=true","-c","http.sslBackend=schannel"]);
    assert.deepEqual(Object.keys(options.env).sort(), ["SystemRoot","PATH","GIT_EXEC_PATH","GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL","GIT_TERMINAL_PROMPT","GIT_CEILING_DIRECTORIES"].sort());
    assert.equal(options.env.GIT_EXEC_PATH, profile.execPath);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, "NUL");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.cwd, profile.cwd);
    assert.equal(options.timeoutMs, 9000);
    assert.equal(options.maxBytes, 4096);
    return { code: 0, stdout: revision + "\t" + ref + "\n" };
  };
  assert.equal(await sampleAnonymousBranch(profile, endpoint, ref, undefined, run), revision);
  for (const bad of [endpoint.replace("https:", "http:"), endpoint + "?credential=fixture",
    endpoint.replace("//", "//fixture@"), endpoint + "/../other", endpoint + "%20x", endpoint + "\n"]) {
    await assert.rejects(sampleAnonymousBranch(profile, bad, ref, undefined, run), /unavailable/);
  }
  for (const bad of ["HEAD","refs/tags/fixture",ref+"*",ref+"..x",ref+"\n",ref+"/a.lock"]) {
    assert.equal(validBranchResource(endpoint, bad), false);
  }
  assert.equal(calls, 1);
});

test("only a successful exact ref result exposes a revision", async () => {
  for (const [code, stdout] of [[2,""],[0,revision+"\trefs/heads/other\n"],[0,revision+"\t"+ref+"\n\n"],
    [0,revision+"\t"+ref+"\nextra"],[0,"untrusted"],[1,revision+"\t"+ref+"\n"]]) {
    await assert.rejects(sampleAnonymousBranch(profile, endpoint, ref, undefined, async () => ({ code, stdout })),
      { message: "branch observation unavailable" });
  }
});

test("a private observation must retain its exact grant before reading and before sending", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-private-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["completion-git.json", "git.exe", "git-remote-https.exe"]) {
    fs.writeFileSync(path.join(root, name), "fixture");
  }
  const hash = createHash("sha256").update("fixture").digest("hex");
  const installed = { ...profile, image: path.join(root, "git.exe"), execPath: root,
    profileHash: hash, imageHash: hash, transportHash: hash };
  const grant = { endpoint, ref, credential: randomUUID() };
  const marker = "fixture:synthetic-reader";
  let reads = 0, launches = 0, allowed = true, change = () => {};
  let returned, observed;
  const credentialRecord = {
    id: grant.credential, endpoint, ref,
    readSealed() { reads++; return Buffer.from("sealed fixture"); },
    async unseal(sealed) {
      assert.equal(sealed.toString(), "sealed fixture");
      await Promise.resolve();
      change();
      returned = Buffer.from(marker);
      return returned;
    },
  };
  const options = { credentialRecord, canObserve: () => allowed, run: async (cmd, argv, { env }) => {
    launches++;
    observed = { cmd, argv, env: { ...env } };
    return { code: 0, stdout: revision + "\t" + ref + "\n" };
  } };
  const query = (g = grant, opts = options) => sampleInstalledBranch(root, installed, g, undefined, opts);
  const refused = { message: "branch observation unavailable" };
  for (const g of [{ ...grant, endpoint: endpoint + "/nested" }, { ...grant, ref: ref + "-other" },
    { ...grant, credential: randomUUID() }, { ...grant, credential: "../private" }]) {
    await assert.rejects(query(g), refused);
  }
  await assert.rejects(query(grant, { ...options, credentialRecord: undefined }), refused);
  allowed = false;
  await assert.rejects(query(), refused);
  allowed = true;
  const inFlight = query();
  allowed = false;
  await assert.rejects(inFlight, refused);
  assert.deepEqual([reads, launches], [0, 0]);

  allowed = true;
  change = () => { allowed = false; };
  await assert.rejects(query(), refused);
  assert.deepEqual([reads, launches], [1, 0]);
  assert.ok(returned.every(byte => byte === 0));
  allowed = true;
  change = () => {};
  assert.equal(await query(), revision);
  assert.deepEqual([reads, launches], [2, 1]);
  assert.ok(returned.every(byte => byte === 0));
  const encoded = Buffer.from(marker).toString("base64");
  assert.equal(observed.env.GIT_CONFIG_KEY_0, "http." + endpoint + ".extraHeader");
  assert.equal(observed.env.GIT_CONFIG_VALUE_0, "Authorization: Basic " + encoded);
  assert.deepEqual(observed.argv.slice(-2), [endpoint, ref]);
  assert.ok(!observed.argv.some(arg => arg.includes(marker) || arg.includes(encoded)));
  await assert.rejects(query(grant, { ...options, run: () => { throw Error(encoded); } }), refused);
  change = () => { fs.writeFileSync(path.join(root, "completion-git.json"), "replaced"); };
  await assert.rejects(query(), refused);
  assert.equal(launches, 1);
  assert.ok(returned.every(byte => byte === 0));
});

test("removed machine approval or a replaced HTTPS transport prevents a Git launch", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ref-"));
  const files = ["completion-git.json","git.exe","git-remote-https.exe"].map(name => path.join(root,name));
  t.after(() => { for (const file of files) fs.rmSync(file, { force: true }); fs.rmdirSync(root); });
  for (const file of files) fs.writeFileSync(file,"fixture");
  const hash = createHash("sha256").update("fixture").digest("hex");
  const installed = { ...profile, image: files[1], execPath: root, profileHash: hash, imageHash: hash, transportHash: hash };
  const grant = { endpoint, ref, credential: null };
  let launches = 0;
  const run = async () => { launches++; return { code: 0, stdout: revision + "\t" + ref + "\n" }; };
  const permitted = { run, canObserve: () => true };
  for (const canObserve of [undefined, () => false, async () => true, () => { throw Error(); }]) {
    await assert.rejects(sampleInstalledBranch(root, installed, grant, undefined, { run, canObserve }),
      { message: "branch observation unavailable" });
  }
  assert.equal(launches, 0);
  if (process.platform === "win32") {
    assert.equal(await sampleInstalledBranch(root, installed, grant, undefined, permitted), revision);
    assert.equal(launches, 1);
  }
  launches = 0;
  for (const file of files) {
    fs.writeFileSync(file, "changed");
    await assert.rejects(sampleInstalledBranch(root, installed, grant, undefined, permitted), { message: "branch observation unavailable" });
    fs.writeFileSync(file, "fixture");
  }
  fs.unlinkSync(files[0]);
  await assert.rejects(sampleInstalledBranch(root, installed, grant, undefined, permitted), { message: "branch observation unavailable" });
  assert.equal(launches, 0);
});

test("Windows branch reader limits file access and decrypts only the bytes opened for its binding", {
  skip: process.platform !== "win32",
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sealed-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = randomUUID();
  const binding = branchCredentialBinding(id, endpoint, ref);
  const grant = { endpoint, ref, credential: id };
  const directory = path.join(root, "branch-credentials");
  fs.mkdirSync(directory);
  const marker = "fixture:synthetic-reader";
  const seal = `
    $ErrorActionPreference='Stop'
    Add-Type -AssemblyName System.Security
    $binding=[Convert]::FromBase64String([Console]::ReadLine())
    $marker=[Text.Encoding]::ASCII.GetBytes([Console]::ReadLine())
    $sealed=[Security.Cryptography.ProtectedData]::Protect($marker,$binding,'LocalMachine')
    [Console]::OpenStandardOutput().Write($sealed,0,$sealed.Length)`;
  const blob = execFileSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", seal], { windowsHide: true, timeout: 5000,
      input: Buffer.from(binding, "hex").toString("base64") + "\n" + marker + "\n" });
  const hash = createHash("sha256").update(blob).digest("hex");
  const member = binding + "-" + hash;
  const file = path.join(directory, member + ".bin");
  const machine = { ...profile, cwd: root, windows: process.env.SystemRoot, credentialBindings: [member] };
  const record = installedCredentialRecord(root, machine, grant);
  assert.equal(installedCredentialRecord(root, machine, { ...grant, endpoint: endpoint + "/sub" }), undefined);
  assert.equal(installedCredentialRecord(root, machine, { ...grant, ref: ref + "-other" }), undefined);
  assert.equal(installedCredentialRecord(root, machine, { ...grant, credential: randomUUID() }), undefined);
  fs.writeFileSync(file, blob);
  const bytes = record.readSealed();
  assert.deepEqual(bytes, blob);
  fs.unlinkSync(file);
  assert.equal((await record.unseal(bytes)).toString(), marker);
  const other = { ...grant, ref: ref + "-other" };
  machine.credentialBindings.push(branchCredentialBinding(id, endpoint, other.ref) + "-" + hash);
  const different = installedCredentialRecord(root, machine, other);
  await assert.rejects(different.unseal(bytes), { message: "branch observation unavailable" });
  for (const length of [0, blob.length, 8193]) {
    fs.writeFileSync(file, Buffer.alloc(length));
    assert.throws(() => record.readSealed(), { message: "branch observation unavailable" });
  }
  fs.writeFileSync(file, blob);
  fs.linkSync(file, path.join(root, "other.bin"));
  assert.throws(() => record.readSealed(), { message: "branch observation unavailable" });
});
