import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  beginSensorGeneration,
  commitSensorGeneration,
  openEvidenceStore,
} from "./evidence-store.mjs";
import { openJournal, readJournalEvents } from "./journal.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";

const thisFile = fileURLToPath(import.meta.url);

async function temporaryRoot(t) {
  const containerDir = await mkdtemp(
    path.join(tmpdir(), "codex-evidence-"),
  );
  const rootDir = path.join(containerDir, "runtime");
  await mkdir(rootDir, { recursive: true });
  t.after(() => rm(containerDir, { recursive: true, force: true }));
  return rootDir;
}

function replay(events) {
  return events.reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
}

function generation(id = "g-1") {
  return beginSensorGeneration({
    sensorId: "combat-lane",
    generationId: id,
    startedUtc: "2026-07-28T00:00:00.000Z",
  });
}

async function runCrashChild() {
  const rootDir = process.env.COORD_EVIDENCE_ROOT;
  const crashBoundary = process.env.COORD_EVIDENCE_BOUNDARY;
  const evidence = await openEvidenceStore({
    rootDir,
    async boundaryHook(boundary) {
      if (boundary !== crashBoundary) {
        return;
      }
      const markerPath = path.join(
        rootDir,
        `boundary-${boundary.replace(".", "-")}.reached`,
      );
      const marker = await open(markerPath, "w");
      try {
        await marker.writeFile(`${boundary}\n`, "utf8");
        await marker.sync();
      } finally {
        await marker.close();
      }
      process.kill(process.pid, "SIGKILL");
    },
  });
  const journal = await openJournal({ rootDir });
  if (process.env.COORD_EVIDENCE_RECOVERY_CHILD === "1") {
    await evidence.recoverPersistence({
      journal,
      probeId: "probe-crash-recovery",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });
    process.exitCode = 97;
    return;
  }
  const transaction = generation();
  transaction.stage("p4", {
    status: "observed",
    value: { head: 3438 },
  });
  await commitSensorGeneration({
    journal,
    evidence,
    sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
  });
  process.exitCode = 97;
}

async function runLiveLockChild() {
  const rootDir = process.env.COORD_EVIDENCE_ROOT;
  const readyPath = path.join(rootDir, "live-lock.ready");
  const evidence = await openEvidenceStore({
    rootDir,
    async faultInjector(boundary) {
      if (boundary !== "health.mutation-pending.after") {
        return;
      }
      const marker = await open(readyPath, "w");
      try {
        await marker.writeFile("ready\n", "utf8");
        await marker.sync();
      } finally {
        await marker.close();
      }
      await new Promise(() => {
        setInterval(() => {}, 1_000);
      });
    },
  });
  await evidence.put({ value: "hold live evidence lock" });
}

async function runConcurrentRecoveryChild() {
  const rootDir = process.env.COORD_EVIDENCE_ROOT;
  const role = process.env.COORD_EVIDENCE_RECOVERY_ROLE;
  const readyPath = path.join(rootDir, `recovery-${role}.ready`);
  const releasePath = path.join(rootDir, "recovery-a.release");
  const evidence = await openEvidenceStore({
    rootDir,
    async boundaryHook(boundary, details) {
      const pausesFirst =
        role === "a" && boundary === "recovery.lock-cleared";
      const confirmsSecondWait =
        role === "b" && boundary === "recovery.mutex.waiting";
      if (!pausesFirst && !confirmsSecondWait) {
        return;
      }
      const marker = await open(readyPath, "w");
      try {
        await marker.writeFile(`${JSON.stringify(details)}\n`, "utf8");
        await marker.sync();
      } finally {
        await marker.close();
      }
      if (confirmsSecondWait) {
        return;
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await access(releasePath);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      throw new Error("concurrent recovery release timed out");
    },
  });
  const journal = await openJournal({ rootDir });
  const recovered = await evidence.recoverPersistence({
    journal,
    probeId: "probe-concurrent-recovery",
    timestampUtc: "2026-07-28T00:07:00.000Z",
  });
  process.stdout.write(`${JSON.stringify(recovered)}\n`);
}

function spawnCrash(rootDir, boundary, { recovery = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [thisFile], {
      env: {
        ...process.env,
        COORD_EVIDENCE_CRASH_CHILD: "1",
        COORD_EVIDENCE_ROOT: rootDir,
        COORD_EVIDENCE_BOUNDARY: boundary,
        ...(recovery
          ? { COORD_EVIDENCE_RECOVERY_CHILD: "1" }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`evidence crash child timed out at ${boundary}`));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

function spawnConcurrentRecovery(rootDir, role) {
  const child = spawn(process.execPath, [thisFile], {
    env: {
      ...process.env,
      COORD_EVIDENCE_CONCURRENT_RECOVERY_CHILD: "1",
      COORD_EVIDENCE_RECOVERY_ROLE: role,
      COORD_EVIDENCE_ROOT: rootDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `concurrent recovery child ${role} timed out`,
      ));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

async function waitForPath(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await access(filePath);
}

if (process.env.COORD_EVIDENCE_CONCURRENT_RECOVERY_CHILD === "1") {
  await runConcurrentRecoveryChild();
} else if (process.env.COORD_EVIDENCE_LIVE_LOCK_CHILD === "1") {
  await runLiveLockChild();
} else if (process.env.COORD_EVIDENCE_CRASH_CHILD === "1") {
  await runCrashChild();
} else {
  test("evidence deduplicates canonical JSON by SHA-256", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const first = await evidence.put({ z: 2, a: { y: 3, b: 1 } });
    const second = await evidence.put({ a: { b: 1, y: 3 }, z: 2 });

    assert.deepEqual(second, first);
    const stored = await evidence.get(first.sha256);
    assert.equal(stored.sha256, first.sha256);
    assert.equal(stored.truncated, false);
    assert.deepEqual(stored.payload, { a: { b: 1, y: 3 }, z: 2 });
  });

  test("evidence records bounded truncation metadata at 256 KiB", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    assert.equal(evidence.maxBytesPerRecord, 256 * 1024);
    const result = await evidence.put({ text: "x".repeat(300 * 1024) });
    const stored = await evidence.get(result.sha256);

    assert.equal(result.truncated, true);
    assert.equal(stored.originalByteLength > 256 * 1024, true);
    assert.equal(stored.storedByteLength <= 256 * 1024, true);
    assert.equal(stored.payloadEncoding, "canonical-json-prefix");
    assert.equal(
      (await stat(evidence.pathFor(result.sha256))).size <= 256 * 1024,
      true,
    );
  });

  test("evidence truncation retains a complete literal replacement character", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({
      rootDir,
      maxBytesPerRecord: 512,
    });
    const value = {
      text: `${"a".repeat(117)}\uFFFD${"z".repeat(700)}`,
    };

    const stored = await evidence.put(value);
    const envelope = JSON.parse(
      await readFile(evidence.pathFor(stored.sha256), "utf8"),
    );

    assert.equal(envelope.truncated, true);
    assert.equal(envelope.payload.endsWith("\uFFFD"), true);
    assert.equal(
      envelope.storedByteLength,
      Buffer.byteLength(envelope.payload, "utf8"),
    );
    assert.equal(
      envelope.storedSha256,
      createHash("sha256")
        .update(envelope.payload, "utf8")
        .digest("hex"),
    );
  });

  test("evidence truncation never emits a partial UTF-8 character", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({
      rootDir,
      maxBytesPerRecord: 512,
    });
    const value = {
      text: `${"a".repeat(117)}\u{1F600}${"z".repeat(700)}`,
    };

    const stored = await evidence.put(value);
    const envelope = JSON.parse(
      await readFile(evidence.pathFor(stored.sha256), "utf8"),
    );
    const source = Buffer.from(JSON.stringify(value), "utf8");
    const prefix = Buffer.from(envelope.payload, "utf8");

    assert.equal(envelope.payload.includes("\uFFFD"), false);
    assert.equal(source.subarray(0, prefix.byteLength).equals(prefix), true);
  });

  test("evidence rejects a configured bound too small for its envelope", async (t) => {
    const rootDir = await temporaryRoot(t);
    await assert.rejects(
      () =>
        openEvidenceStore({
          rootDir,
          maxBytesPerRecord: 511,
        }),
      /512 bytes through 256 KiB/i,
    );
    const bounded = await openEvidenceStore({
      rootDir,
      maxBytesPerRecord: 512,
    });
    assert.equal((await bounded.put(null)).truncated, false);
  });

  test("partial provider staging is never projected", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const transaction = generation();
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });

    assert.equal((await journal.readFrom(0)).length, 0);
    assert.deepEqual(replay(await journal.readFrom(0)).observations.current, {});
  });

  test("forged provider generation provenance rejects before mutation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const boundaries = [];
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({
      rootDir,
      boundaryHook(boundary) {
        boundaries.push(boundary);
      },
    });
    const transaction = generation("g-sample-owner");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const sample = transaction.toSample(
      "2026-07-28T00:00:01.000Z",
    );
    sample.providerResults.p4 = {
      ...sample.providerResults.p4,
      generationId: "g-forged-provider",
    };

    await assert.rejects(
      () => commitSensorGeneration({ journal, evidence, sample }),
      /provider generation ID.*sample|generation provenance/i,
    );
    assert.deepEqual(boundaries, []);
    assert.deepEqual(await journal.readFrom(0), []);
    assert.equal(evidence.health().status, "healthy");
    assert.equal(evidence.canRunCommand("model-turn"), true);
  });

  test("sample generation commits once and preserves last-known-good", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const observed = generation("g-observed");
    observed.stage("p4", {
      status: "observed",
      value: { head: 3438 },
      durationMs: 12,
    });
    const first = await commitSensorGeneration({
      journal,
      evidence,
      sample: observed.toSample("2026-07-28T00:00:01.000Z"),
    });
    const unavailable = beginSensorGeneration({
      sensorId: "combat-lane",
      generationId: "g-unavailable",
      startedUtc: "2026-07-28T00:01:00.000Z",
    });
    unavailable.stage("p4", {
      status: "unavailable",
      diagnostic: "provider is offline",
    });
    await commitSensorGeneration({
      journal,
      evidence,
      sample: unavailable.toSample("2026-07-28T00:01:01.000Z"),
    });

    const events = await journal.readFrom(0);
    assert.equal(
      events.filter((item) => item.type === "sensor.sampleCommitted").length,
      2,
    );
    const state = replay(events);
    assert.equal(
      state.observations.current["combat-lane"].p4.status,
      "unavailable",
    );
    assert.equal(
      state.observations.lastKnownGood["combat-lane"].p4.evidenceSha256,
      first.providers.p4.evidenceSha256,
    );
    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: observed.toSample("2026-07-28T00:00:01.000Z"),
        }),
      /generation.*already committed|sample.*duplicate/i,
    );
  });

  test("stale sample rejection does not degrade persistence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const newest = generation("g-newest");
    newest.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    await commitSensorGeneration({
      journal,
      evidence,
      sample: newest.toSample("2026-07-28T00:00:02.000Z"),
    });
    const stale = generation("g-stale");
    stale.stage("p4", {
      status: "observed",
      value: { head: 3437 },
    });

    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: stale.toSample("2026-07-28T00:00:01.000Z"),
        }),
      /completion cannot precede/i,
    );
    assert.equal(evidence.health().status, "healthy");
    assert.equal(evidence.canRunCommand("model-turn"), true);
    assert.deepEqual(
      (await journal.readFrom(0)).map((event) => event.type),
      ["sensor.sampleCommitted"],
    );
  });

  test("concurrent sample generations serialize sequence selection", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const transactions = Array.from({ length: 8 }, (_, index) => {
      const transaction = generation(`g-concurrent-${index}`);
      transaction.stage(`provider-${index}`, {
        status: "observed",
        value: { index },
      });
      return transaction;
    });
    const results = await Promise.all(
      transactions.map((transaction, index) =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: transaction.toSample(
            `2026-07-28T00:00:0${index + 1}.000Z`,
          ),
        })),
    );

    assert.equal(results.length, 8);
    assert.equal(evidence.health().status, "healthy");
    assert.deepEqual(
      (await journal.readFrom(0)).map((item) => item.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  test("sample commit retries a concurrent unrelated journal append", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const journal = await openJournal({ rootDir });
    let interleaved = false;
    const interleavingJournal = {
      ...journal,
      async append(event, options) {
        if (!interleaved && event.type === "sensor.sampleCommitted") {
          interleaved = true;
          await journal.append(
            {
              schemaVersion: 1,
              sequence: 1,
              eventId: "interleaved-runtime-start",
              timestampUtc: "2026-07-28T00:00:00.500Z",
              source: "evidence-test",
              type: "runtime.started",
              payload: { generationId: "runtime-1" },
            },
            { flush: true },
          );
        }
        return journal.append(event, options);
      },
    };
    const transaction = generation("g-interleaved");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });

    await commitSensorGeneration({
      journal: interleavingJournal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });

    assert.deepEqual(
      (await journal.readFrom(0)).map((event) => event.type),
      ["runtime.started", "sensor.sampleCommitted"],
    );
    assert.equal(evidence.health().status, "healthy");
  });

  test("sample commit rejects a journal from another runtime root", async (t) => {
    const evidenceRoot = await temporaryRoot(t);
    const journalRoot = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir: evidenceRoot });
    const journal = await openJournal({ rootDir: journalRoot });
    const transaction = generation("g-cross-root");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });

    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
        }),
      /same runtime root/i,
    );
    assert.equal((await journal.readFrom(0)).length, 0);
  });

  test("sample commit fences prune until the journal reference is flushed", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    let markSampleReady;
    let releaseSample;
    const sampleReady = new Promise((resolve) => {
      markSampleReady = resolve;
    });
    const sampleReleased = new Promise((resolve) => {
      releaseSample = resolve;
    });
    const evidence = await openEvidenceStore({
      rootDir,
      async boundaryHook(boundary) {
        if (boundary === "sample.before") {
          markSampleReady();
          await sampleReleased;
        }
      },
    });
    const providerResult = {
      status: "observed",
      value: { head: 3438 },
    };
    const preexisting = await evidence.put(providerResult);
    await utimes(
      evidence.pathFor(preexisting.sha256),
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const transaction = generation("g-prune-race");
    transaction.stage("p4", providerResult);
    const committing = commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    await sampleReady;
    const pruning = evidence.prune(
      new Set(),
      "2999-01-01T00:00:00.000Z",
    );
    releaseSample();
    const [committed, pruned] = await Promise.all([committing, pruning]);

    assert.equal(pruned.deleted, 0);
    assert.equal(
      (await evidence.get(committed.providers.p4.evidenceSha256)).sha256,
      committed.providers.p4.evidenceSha256,
    );
  });

  test("concurrent identical evidence puts deduplicate without degradation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        evidence.put({ same: "canonical value" })),
    );

    assert.equal(new Set(results.map((item) => item.sha256)).size, 1);
    assert.equal(evidence.health().status, "healthy");
  });

  test("evidence prune deletes only expired unreferenced records", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const referenced = await evidence.put({ value: "keep" });
    const unreferenced = await evidence.put({ value: "delete" });
    const result = await evidence.prune(
      new Set([referenced.sha256]),
      "2999-01-01T00:00:00.000Z",
    );

    assert.equal(result.deleted, 1);
    assert.equal((await evidence.get(referenced.sha256)).sha256, referenced.sha256);
    assert.equal(await evidence.get(unreferenced.sha256), null);
  });

  test("evidence prune derives authoritative journal references", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const transaction = generation("g-authoritative-prune");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    const hash = committed.providers.p4.evidenceSha256;
    await utimes(
      evidence.pathFor(hash),
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const result = await evidence.prune(
      new Set(),
      "2999-01-01T00:00:00.000Z",
    );
    assert.equal(result.deleted, 0);
    assert.equal((await evidence.get(hash)).sha256, hash);
  });

  test("evidence prune retains recovery-probe journal references", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    let injectFailure = true;
    const evidence = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (injectFailure && boundary === "evidence.write.before") {
          const error = new Error("force recovery");
          error.code = "ENOSPC";
          throw error;
        }
      },
    });
    await assert.rejects(() => evidence.put({ unavailable: true }), /force recovery/i);
    injectFailure = false;
    await evidence.recoverPersistence({
      journal,
      probeId: "probe-prune-reference",
      timestampUtc: "2026-07-28T00:02:00.000Z",
    });
    const recoveredEvent = (await journal.readFrom(0)).find(
      (event) => event.type === "runtime.recovered",
    );
    const recoverySha = recoveredEvent.payload.evidenceSha256;
    await utimes(
      evidence.pathFor(recoverySha),
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const result = await evidence.prune(
      new Set(),
      "2999-01-01T00:00:00.000Z",
    );

    assert.equal(result.deleted, 0);
    assert.notEqual(await evidence.get(recoverySha), null);
  });

  test("bound changes produce truthful content-address metadata", async (t) => {
    const rootDir = await temporaryRoot(t);
    const bounded = await openEvidenceStore({
      rootDir,
      maxBytesPerRecord: 512,
    });
    const value = { text: "x".repeat(2_000) };
    const first = await bounded.put(value);
    assert.equal(first.truncated, true);

    const reopened = await openEvidenceStore({ rootDir });
    const second = await reopened.put(value);
    const persisted = await reopened.get(second.sha256);

    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.truncated, persisted.truncated);
    assert.equal(second.storedByteLength, persisted.storedByteLength);
  });

  for (const failure of [
    { name: "disk-full", code: "ENOSPC", boundary: "evidence.write.before" },
    { name: "permission-denied", code: "EACCES", boundary: "evidence.directory.after" },
    { name: "file-lock", code: "EBUSY", boundary: "evidence.replace.before" },
    { name: "atomic-replacement", code: "EIO", boundary: "evidence.replace.before" },
  ]) {
    test(`evidence ${failure.name} failure enters degraded read-only`, async (t) => {
      const rootDir = await temporaryRoot(t);
      let injectFailure = true;
      const evidence = await openEvidenceStore({
        rootDir,
        faultInjector(boundary) {
          if (injectFailure && boundary === failure.boundary) {
            const error = new Error(failure.name);
            error.code = failure.code;
            throw error;
          }
        },
      });
      const journal = await openJournal({ rootDir });
      const transaction = generation();
      transaction.stage("p4", {
        status: "observed",
        value: { head: 3438 },
      });
      await assert.rejects(
        () =>
          commitSensorGeneration({
            journal,
            evidence,
            sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
          }),
        new RegExp(failure.name, "i"),
      );
      const events = await journal.readFrom(0);
      assert.equal(
        events.some((item) => item.type === "sensor.sampleCommitted"),
        false,
      );
      assert.equal(evidence.health().status, "degraded-read-only");
      assert.equal(evidence.canRunCommand("status"), true);
      assert.equal(evidence.canRunCommand("doctor"), true);
      assert.equal(evidence.canRunCommand("explain"), true);
      assert.equal(evidence.canRunCommand("export"), true);
      assert.equal(evidence.canRunCommand("model-turn"), false);
      assert.throws(
        () => evidence.beginSensorGeneration({
          sensorId: "combat-lane",
          generationId: "blocked",
          startedUtc: "2026-07-28T00:02:00.000Z",
        }),
        /degraded|read-only/i,
      );
      const reopened = await openEvidenceStore({ rootDir });
      assert.equal(reopened.health().status, "degraded-read-only");
      assert.equal(reopened.canRunCommand("model-turn"), false);

      injectFailure = false;
      const recovered = await evidence.recoverPersistence({
        journal,
        probeId: `probe-${failure.name}`,
        timestampUtc: "2026-07-28T00:03:00.000Z",
      });
      assert.equal(recovered.status, "healthy");
      assert.equal(evidence.canRunCommand("model-turn"), true);
    });
  }

  test("journal write failure leaves a durable degraded startup fence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const failingJournal = {
      rootDir,
      readFrom: journal.readFrom,
      async append() {
        const error = new Error("injected journal append failure");
        error.code = "EIO";
        throw error;
      },
    };
    const transaction = generation("g-journal-failure");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal: failingJournal,
          evidence,
          sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
        }),
      /journal append failure/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    const reopened = await openEvidenceStore({ rootDir });
    assert.equal(reopened.health().status, "degraded-read-only");
    assert.equal(reopened.canRunCommand("model-turn"), false);

    const recovered = await reopened.recoverPersistence({
      journal,
      probeId: "probe-journal-failure",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });
    assert.equal(recovered.status, "healthy");
  });

  test("degraded gate is shared by every store on the runtime root", async (t) => {
    const rootDir = await temporaryRoot(t);
    const first = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (boundary === "evidence.write.before") {
          const error = new Error("shared ENOSPC");
          error.code = "ENOSPC";
          throw error;
        }
      },
    });
    const second = await openEvidenceStore({ rootDir });
    await assert.rejects(() => first.put({ value: 1 }), /ENOSPC/i);
    assert.equal(second.health().status, "degraded-read-only");
    assert.equal(second.canRunCommand("model-turn"), false);
    await assert.rejects(
      () => second.put({ value: 2 }),
      /degraded|read-only|recovery/i,
    );
  });

  test("health-marker write failure retains a durable mutation fence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (
          boundary === "health.mutation-pending.before" ||
          boundary === "health.degraded-read-only.before"
        ) {
          const error = new Error("health marker replacement failed");
          error.code = "EIO";
          throw error;
        }
      },
    });

    await assert.rejects(
      () => evidence.put({ value: "must not commit" }),
      /health marker replacement failed/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    assert.equal(evidence.canRunCommand("model-turn"), false);
    const reopened = await openEvidenceStore({ rootDir });
    assert.equal(reopened.health().status, "degraded-read-only");
    await assert.rejects(
      () => reopened.put({ value: "still fenced" }),
      /degraded|read-only|fenced/i,
    );
  });

  test("recovery distinguishes a reused PID from the original lock owner", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const originalOwner = {
      pid: process.pid,
      generationId: "owner-generation-original",
      creationTimeUtc: "2026-07-28T00:00:00.000Z",
      executablePath: process.execPath,
      windowsBootId: "windows-boot-original",
    };
    const reusedOwner = {
      ...originalOwner,
      generationId: "owner-generation-reused",
      creationTimeUtc: "2026-07-28T00:05:00.000Z",
      windowsBootId: "windows-boot-reused",
    };
    let failMarkers = true;
    const evidence = await openEvidenceStore({
      rootDir,
      processIdentityProvider: async () => originalOwner,
      faultInjector(boundary) {
        if (
          failMarkers &&
          (boundary === "health.mutation-pending.before" ||
            boundary === "health.degraded-read-only.before")
        ) {
          throw new Error("retain identity-bearing evidence lock");
        }
      },
    });
    await assert.rejects(
      () => evidence.put({ value: "leave lock" }),
      /retain identity-bearing evidence lock/i,
    );
    failMarkers = false;

    const lock = JSON.parse(
      await readFile(
        path.join(rootDir, ".codex-coordinator-evidence.lock"),
        "utf8",
      ),
    );
    assert.deepEqual(lock.owner, originalOwner);

    const reopened = await openEvidenceStore({
      rootDir,
      processIdentityProvider: async () => reusedOwner,
    });
    const recovered = await reopened.recoverPersistence({
      journal,
      probeId: "probe-pid-reuse",
      timestampUtc: "2026-07-28T00:06:00.000Z",
    });
    assert.equal(recovered.status, "healthy");
  });

  test("recovery fails closed on ambiguous live-owner identity drift", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const originalOwner = {
      pid: process.pid,
      generationId: "owner-generation-original",
      creationTimeUtc: "2026-07-28T00:00:00.000Z",
      executablePath: process.execPath,
      windowsBootId: "windows-boot-original",
    };
    const driftedOwner = {
      ...originalOwner,
      generationId: "owner-generation-drifted",
      windowsBootId: "windows-boot-drifted",
    };
    const evidence = await openEvidenceStore({
      rootDir,
      processIdentityProvider: async () => originalOwner,
      faultInjector(boundary) {
        if (
          boundary === "health.mutation-pending.before" ||
          boundary === "health.degraded-read-only.before"
        ) {
          throw new Error("retain ambiguous evidence lock");
        }
      },
    });
    await assert.rejects(
      () => evidence.put({ value: "leave ambiguous lock" }),
      /retain ambiguous evidence lock/i,
    );

    const reopened = await openEvidenceStore({
      rootDir,
      processIdentityProvider: async () => driftedOwner,
    });
    await assert.rejects(
      () =>
        reopened.recoverPersistence({
          journal,
          probeId: "probe-ambiguous-owner",
          timestampUtc: "2026-07-28T00:06:00.000Z",
        }),
      /ambiguous|live lock owner|identity drift/i,
    );
    await access(
      path.join(rootDir, ".codex-coordinator-evidence.lock"),
    );
  });

  test("recovery refuses the exact live external lock owner", async (t) => {
    const rootDir = await temporaryRoot(t);
    const readyPath = path.join(rootDir, "live-lock.ready");
    const child = spawn(process.execPath, [thisFile], {
      env: {
        ...process.env,
        COORD_EVIDENCE_LIVE_LOCK_CHILD: "1",
        COORD_EVIDENCE_ROOT: rootDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await access(readyPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await access(readyPath);

    const evidence = await openEvidenceStore({ rootDir });
    const journal = await openJournal({ rootDir });
    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-live-owner",
          timestampUtc: "2026-07-28T00:06:00.000Z",
        }),
      /live lock owner PID/i,
      stderr,
    );

    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
    });
    child.kill("SIGKILL");
    await exited;
    const recovered = await evidence.recoverPersistence({
      journal,
      probeId: "probe-live-owner",
      timestampUtc: "2026-07-28T00:06:00.000Z",
    });
    assert.equal(recovered.status, "healthy");
  });

  test("concurrent recovery processes serialize dead-lock clearing and mutation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const crashed = await spawnCrash(rootDir, "evidence.pending.after");
    assert.notEqual(crashed.code, 97, crashed.stderr);

    const first = spawnConcurrentRecovery(rootDir, "a");
    t.after(() => {
      if (first.child.exitCode === null) {
        first.child.kill("SIGKILL");
      }
    });
    await waitForPath(path.join(rootDir, "recovery-a.ready"));

    const second = spawnConcurrentRecovery(rootDir, "b");
    t.after(() => {
      if (second.child.exitCode === null) {
        second.child.kill("SIGKILL");
      }
    });
    await waitForPath(path.join(rootDir, "recovery-b.ready"));

    const release = await open(
      path.join(rootDir, "recovery-a.release"),
      "w",
    );
    try {
      await release.writeFile("release\n", "utf8");
      await release.sync();
    } finally {
      await release.close();
    }

    const [firstResult, secondResult] = await Promise.all([
      first.completed,
      second.completed,
    ]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.equal(JSON.parse(firstResult.stdout).status, "healthy");
    assert.equal(JSON.parse(secondResult.stdout).status, "healthy");

    const events = await readJournalEvents(rootDir);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "runtime.recovered" &&
          event.payload.probeId === "probe-concurrent-recovery",
      ).length,
      1,
    );
    await assert.rejects(
      () => access(
        path.join(rootDir, ".codex-coordinator-evidence.lock"),
      ),
      /ENOENT/,
    );
  });

  test("recovery fails the owner process closed if its mutex helper dies", async (t) => {
    const rootDir = await temporaryRoot(t);
    const crashed = await spawnCrash(rootDir, "evidence.pending.after");
    assert.notEqual(crashed.code, 97, crashed.stderr);

    const first = spawnConcurrentRecovery(rootDir, "a");
    t.after(() => {
      if (first.child.exitCode === null) {
        first.child.kill("SIGKILL");
      }
    });
    const firstReadyPath = path.join(rootDir, "recovery-a.ready");
    await waitForPath(firstReadyPath);
    const firstBoundary = JSON.parse(
      await readFile(firstReadyPath, "utf8"),
    );
    assert.equal(
      Number.isSafeInteger(firstBoundary.mutexHelperPid),
      true,
    );

    const second = spawnConcurrentRecovery(rootDir, "b");
    t.after(() => {
      if (second.child.exitCode === null) {
        second.child.kill("SIGKILL");
      }
    });
    await waitForPath(path.join(rootDir, "recovery-b.ready"));
    process.kill(firstBoundary.mutexHelperPid, "SIGKILL");

    let exitTimer;
    const firstResult = await Promise.race([
      first.completed,
      new Promise((resolve) => {
        exitTimer = setTimeout(
          () => resolve({ timedOut: true }),
          2_000,
        );
      }),
    ]);
    clearTimeout(exitTimer);
    assert.notEqual(
      firstResult.timedOut,
      true,
      "recovery owner must fail-stop when mutex ownership is lost",
    );
    assert.notEqual(firstResult.code, 0, firstResult.stderr);

    const secondResult = await second.completed;
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.equal(JSON.parse(secondResult.stdout).status, "healthy");
    const events = await readJournalEvents(rootDir);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "runtime.recovered" &&
          event.payload.probeId === "probe-concurrent-recovery",
      ).length,
      1,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(rootDir, "persistence-health.json"),
          "utf8",
        ),
      ).status,
      "healthy",
    );
  });

  test("evidence get fails closed on envelope corruption", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const stored = await evidence.put({ answer: 42 });
    await readFile(evidence.pathFor(stored.sha256), "utf8");
    const handle = await open(evidence.pathFor(stored.sha256), "w");
    try {
      await handle.writeFile('{"schemaVersion":1}\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assert.rejects(
      () => evidence.get(stored.sha256),
      /envelope|hash|corrupt|schema/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    assert.equal(evidence.canRunCommand("model-turn"), false);
  });

  test("evidence rejects oversized records before unbounded parsing", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const stored = await evidence.put({ answer: 42 });
    await truncate(evidence.pathFor(stored.sha256), 512 * 1024);

    await assert.rejects(
      () => evidence.get(stored.sha256),
      /configured byte bound|unsafe|corrupt/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("recovery rejects oversized pending records with the same read bound", async (t) => {
    const rootDir = await temporaryRoot(t);
    const owner = {
      pid: process.pid,
      generationId: "owner-generation-pending-bound",
      creationTimeUtc: "2026-07-28T00:00:00.000Z",
      executablePath: process.execPath,
      windowsBootId: "windows-boot-pending-bound",
    };
    let injectFailure = true;
    const evidence = await openEvidenceStore({
      rootDir,
      processIdentityProvider: async () => owner,
      faultInjector(boundary) {
        if (
          injectFailure &&
          boundary === "evidence.write.before"
        ) {
          throw new Error("prepare bounded pending recovery");
        }
      },
    });
    await assert.rejects(
      () => evidence.put({ value: "degrade" }),
      /prepare bounded pending recovery/i,
    );
    injectFailure = false;
    const prefixDir = path.join(rootDir, "evidence", "aa");
    await mkdir(prefixDir, { recursive: true });
    const pendingPath = path.join(
      prefixDir,
      `${"a".repeat(62)}.json.pending-${process.pid}-00000000-0000-4000-8000-000000000001`,
    );
    await writeFile(pendingPath, "{}\n");
    await truncate(pendingPath, 32 * 1024 * 1024);
    const journal = await openJournal({ rootDir });

    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-oversized-pending",
          timestampUtc: "2026-07-28T00:06:00.000Z",
        }),
      /pending evidence envelope.*byte bound/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("evidence rejects multiply linked record files", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const stored = await evidence.put({ answer: 42 });
    await link(
      evidence.pathFor(stored.sha256),
      path.join(rootDir, "evidence-hard-link.json"),
    );

    await assert.rejects(
      () => evidence.get(stored.sha256),
      /hard link|multiple|unsafe/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("evidence detects same-length truncated payload corruption", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const stored = await evidence.put({ text: "x".repeat(300 * 1024) });
    const recordPath = evidence.pathFor(stored.sha256);
    const envelope = JSON.parse(await readFile(recordPath, "utf8"));
    envelope.payload =
      (envelope.payload[0] === "x" ? "y" : "x") +
      envelope.payload.slice(1);
    const handle = await open(recordPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(envelope)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await assert.rejects(
      () => evidence.get(stored.sha256),
      /stored.*hash|payload.*hash|corrupt/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("truncated evidence cannot be rebound to another content address", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const first = await evidence.put({ text: `a${"x".repeat(300 * 1024)}` });
    const second = await evidence.put({ text: `b${"x".repeat(300 * 1024)}` });
    const firstEnvelope = JSON.parse(
      await readFile(evidence.pathFor(first.sha256), "utf8"),
    );
    firstEnvelope.sha256 = second.sha256;
    await writeFile(
      evidence.pathFor(second.sha256),
      `${JSON.stringify(firstEnvelope)}\n`,
    );

    await assert.rejects(
      () => evidence.get(second.sha256),
      /address|hash|corrupt/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("recovery rejects a journal from another runtime root", async (t) => {
    const evidenceRoot = await temporaryRoot(t);
    const journalRoot = await temporaryRoot(t);
    let injectFailure = true;
    const evidence = await openEvidenceStore({
      rootDir: evidenceRoot,
      faultInjector(boundary) {
        if (injectFailure && boundary === "evidence.write.before") {
          throw new Error("make root degraded");
        }
      },
    });
    await assert.rejects(() => evidence.put({ value: 1 }), /degraded/i);
    injectFailure = false;
    const foreignJournal = await openJournal({ rootDir: journalRoot });

    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal: foreignJournal,
          probeId: "probe-cross-root",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        }),
      /same runtime root/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    assert.equal((await foreignJournal.readFrom(0)).length, 0);
  });

  test("recovery rejects a fresh healthy runtime without writing", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const journal = await openJournal({ rootDir });

    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-not-needed",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        }),
      /already healthy|recovery.*not required/i,
    );
    assert.equal((await journal.readFrom(0)).length, 0);
    assert.equal(evidence.health().lastRecoveryProbeId, null);
  });

  test("recovery retry reconciles one already-durable probe event", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    let failEvidence = true;
    let failFinalHealth = false;
    const evidence = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (failEvidence && boundary === "evidence.write.before") {
          throw new Error("initial evidence failure");
        }
        if (
          failFinalHealth &&
          boundary === "health.healthy.before"
        ) {
          throw new Error("final healthy marker failure");
        }
      },
    });
    await assert.rejects(
      () => evidence.put({ value: "fail" }),
      /initial evidence failure/i,
    );
    failEvidence = false;
    failFinalHealth = true;
    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-retry-idempotent",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        }),
      /final healthy marker failure/i,
    );
    failFinalHealth = false;

    const recovered = await evidence.recoverPersistence({
      journal,
      probeId: "probe-retry-idempotent",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });

    assert.equal(recovered.status, "healthy");
    const recoveredEvents = await journal.readFrom(0);
    assert.deepEqual(
      recoveredEvents.map((event) => event.type),
      ["runtime.degraded", "runtime.recovered"],
    );
    assert.equal(
      recoveredEvents.filter(
        (event) =>
          event.type === "runtime.recovered" &&
          event.payload.probeId === "probe-retry-idempotent",
      ).length,
      1,
    );
    const repeated = await evidence.recoverPersistence({
      journal,
      probeId: "probe-retry-idempotent",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });
    assert.equal(repeated.status, "healthy");
    assert.equal(
      (await journal.readFrom(0)).filter(
        (event) => event.type === "runtime.recovered",
      ).length,
      1,
    );
  });

  test("healthy recovery retry revalidates every authoritative reference", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    let injectFailure = false;
    const evidence = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (injectFailure && boundary === "evidence.write.before") {
          throw new Error("make retry verification necessary");
        }
      },
    });
    const transaction = generation("g-retry-authoritative");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    injectFailure = true;
    await assert.rejects(
      () => evidence.put({ value: "fail" }),
      /retry verification necessary/i,
    );
    injectFailure = false;
    await evidence.recoverPersistence({
      journal,
      probeId: "probe-retry-authoritative",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });
    await unlink(evidence.pathFor(committed.providers.p4.evidenceSha256));

    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-retry-authoritative",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        }),
      /journal-referenced evidence is missing/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("recovery retries a concurrent unrelated journal append", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    let injectFailure = true;
    const evidence = await openEvidenceStore({
      rootDir,
      faultInjector(boundary) {
        if (injectFailure && boundary === "evidence.write.before") {
          throw new Error("make recovery necessary");
        }
      },
    });
    await assert.rejects(
      () => evidence.put({ value: "fail" }),
      /recovery necessary/i,
    );
    injectFailure = false;
    let interleaved = false;
    const interleavingJournal = {
      ...journal,
      async append(event, options) {
        if (!interleaved && event.type === "runtime.recovered") {
          interleaved = true;
          const events = await journal.readFrom(0);
          await journal.append(
            {
              schemaVersion: 1,
              sequence: (events.at(-1)?.sequence ?? 0) + 1,
              eventId: "recovery-interleaved-runtime-start",
              timestampUtc: "2026-07-28T00:02:30.000Z",
              source: "evidence-test",
              type: "runtime.started",
              payload: { generationId: "runtime-interleaved" },
            },
            { flush: true },
          );
        }
        return journal.append(event, options);
      },
    };

    const result = await evidence.recoverPersistence({
      journal: interleavingJournal,
      probeId: "probe-interleaved",
      timestampUtc: "2026-07-28T00:03:00.000Z",
    });

    assert.equal(result.status, "healthy");
    assert.equal(evidence.health().status, "healthy");
    assert.equal(
      (await journal.readFrom(0)).at(-1).type,
      "runtime.recovered",
    );
  });

  test("recovery refuses unresolved evidence corruption", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const transaction = generation("g-corrupt-recovery");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    const recordPath = evidence.pathFor(
      committed.providers.p4.evidenceSha256,
    );
    await writeFile(recordPath, '{"schemaVersion":1}\n');
    await assert.rejects(
      () => evidence.get(committed.providers.p4.evidenceSha256),
      /envelope|schema|corrupt/i,
    );
    await assert.rejects(
      () =>
        evidence.recoverPersistence({
          journal,
          probeId: "probe-corrupt",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        }),
      /envelope|schema|corrupt|referenced evidence/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
  });

  test("startup degrades when journal-referenced evidence is missing", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const transaction = generation("g-missing-referenced");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    await unlink(
      evidence.pathFor(committed.providers.p4.evidenceSha256),
    );

    const reopened = await openEvidenceStore({ rootDir });
    assert.equal(reopened.health().status, "degraded-read-only");
    assert.equal(reopened.canRunCommand("model-turn"), false);
  });

  test("get degrades when requested journal evidence is missing", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const transaction = generation("g-get-missing");
    transaction.stage("p4", {
      status: "observed",
      value: { head: 3438 },
    });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: transaction.toSample("2026-07-28T00:00:01.000Z"),
    });
    const sha256 = committed.providers.p4.evidenceSha256;
    await unlink(evidence.pathFor(sha256));

    await assert.rejects(
      () => evidence.get(sha256),
      /journal-referenced evidence is missing/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    assert.equal(evidence.canRunCommand("model-turn"), false);
  });

  test("get rejects an invalid hash without degrading persistence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });

    await assert.rejects(
      () => evidence.get("not-a-sha256"),
      /evidence hash/i,
    );
    assert.equal(evidence.health().status, "healthy");
    assert.equal(evidence.canRunCommand("model-turn"), true);
  });

  test("put rejects an invalid value without degrading persistence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });

    await assert.rejects(
      () => evidence.put(undefined),
      /evidence value/i,
    );
    assert.equal(evidence.health().status, "healthy");
    assert.equal(evidence.canRunCommand("model-turn"), true);
  });

  test("missing referenced evidence degrades the live store before mutation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const evidence = await openEvidenceStore({ rootDir });
    const first = generation("g-live-missing-1");
    first.stage("p4", { status: "observed", value: { head: 3438 } });
    const committed = await commitSensorGeneration({
      journal,
      evidence,
      sample: first.toSample("2026-07-28T00:00:01.000Z"),
    });
    await unlink(evidence.pathFor(committed.providers.p4.evidenceSha256));
    const second = generation("g-live-missing-2");
    second.stage("p4", { status: "observed", value: { head: 3439 } });

    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: second.toSample("2026-07-28T00:00:02.000Z"),
        }),
      /journal-referenced evidence is missing/i,
    );
    assert.equal(evidence.health().status, "degraded-read-only");
    assert.equal(evidence.canRunCommand("model-turn"), false);
    assert.throws(
      () => evidence.beginSensorGeneration({
        sensorId: "combat-lane",
        generationId: "g-blocked",
        startedUtc: "2026-07-28T00:00:03.000Z",
      }),
      /degraded read-only/i,
    );
  });

  test("forced exits expose no partial sample projection", async (t) => {
    for (const boundary of [
      "evidence.before",
      "evidence.pending.after",
      "evidence.after",
      "sample.before",
      "sample.after",
    ]) {
      const rootDir = await temporaryRoot(t);
      const result = await spawnCrash(rootDir, boundary);
      assert.notEqual(result.code, 97, `${boundary}: ${result.stderr}`);
      assert.equal(
        await readFile(
          path.join(
            rootDir,
            `boundary-${boundary.replace(".", "-")}.reached`,
          ),
          "utf8",
        ),
        `${boundary}\n`,
      );
      const events = await readJournalEvents(rootDir);
      const committed = events.filter(
        (item) => item.type === "sensor.sampleCommitted",
      );
      assert.equal(
        committed.length,
        boundary === "sample.after" ? 1 : 0,
        boundary,
      );
      const state = replay(events);
      assert.equal(
        Object.keys(state.observations.current).length,
        boundary === "sample.after" ? 1 : 0,
        boundary,
      );
      if (boundary === "evidence.pending.after") {
        const reopened = await openEvidenceStore({ rootDir });
        assert.equal(reopened.health().status, "degraded-read-only");
        const recovered = await reopened.recoverPersistence({
          journal: await openJournal({ rootDir }),
          probeId: "probe-pending",
          timestampUtc: "2026-07-28T00:03:00.000Z",
        });
        assert.equal(recovered.status, "healthy");
      }
    }
  });

  test("forced recovery exits reconcile one logical probe event", async (t) => {
    for (const boundary of [
      "evidence.after",
      "recovery.after",
      "health.healthy.before",
    ]) {
      const rootDir = await temporaryRoot(t);
      let injectFailure = true;
      const evidence = await openEvidenceStore({
        rootDir,
        faultInjector(currentBoundary) {
          if (
            injectFailure &&
            currentBoundary === "evidence.write.before"
          ) {
            throw new Error("prepare degraded recovery root");
          }
        },
      });
      await assert.rejects(
        () => evidence.put({ value: "degrade" }),
        /prepare degraded recovery root/i,
      );
      injectFailure = false;

      const result = await spawnCrash(rootDir, boundary, {
        recovery: true,
      });
      assert.notEqual(result.code, 97, `${boundary}: ${result.stderr}`);
      const reopened = await openEvidenceStore({ rootDir });
      assert.equal(
        reopened.health().status,
        "degraded-read-only",
        boundary,
      );
      await reopened.recoverPersistence({
        journal: await openJournal({ rootDir }),
        probeId: "probe-crash-recovery",
        timestampUtc: "2026-07-28T00:03:00.000Z",
      });
      const events = await readJournalEvents(rootDir);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "runtime.recovered" &&
            event.payload.probeId === "probe-crash-recovery",
        ).length,
        1,
        boundary,
      );
    }
  });

  test("prototype-key identifiers are rejected before journal append", async (t) => {
    assert.throws(
      () =>
        beginSensorGeneration({
          sensorId: "constructor",
          generationId: "g-1",
          startedUtc: "2026-07-28T00:00:00.000Z",
        }),
      /sensor ID|identifier|reserved/i,
    );
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    assert.deepEqual(await journal.readFrom(0), []);
  });

  test("prototype-bearing samples reject before persistence mutation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = await openEvidenceStore({ rootDir });
    const journal = await openJournal({ rootDir });
    const plain = generation("g-prototype-sample")
      .toSample("2026-07-28T00:00:01.000Z");
    const inheritedSample = Object.assign(
      Object.create({ inherited: true }),
      plain,
    );
    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: inheritedSample,
        }),
      /plain|prototype|schema/i,
    );

    const inheritedProviders = {
      ...plain,
      providerResults: Object.assign(
        Object.create({ inherited: true }),
        plain.providerResults,
      ),
    };
    await assert.rejects(
      () =>
        commitSensorGeneration({
          journal,
          evidence,
          sample: inheritedProviders,
        }),
      /plain|prototype|schema/i,
    );
    assert.equal((await journal.readFrom(0)).length, 0);
    assert.equal(evidence.health().status, "healthy");
  });

  test("evidence test roots isolate sibling journal fences under the OS temp directory", async (t) => {
    const rootDir = await temporaryRoot(t);
    const secondRootDir = await temporaryRoot(t);
    const resolvedTempDir = path.resolve(tmpdir()).toLowerCase();
    const firstParent = path.dirname(path.resolve(rootDir)).toLowerCase();
    const secondParent = path.dirname(
      path.resolve(secondRootDir),
    ).toLowerCase();

    assert.equal(
      path.resolve(rootDir).toLowerCase().startsWith(
        resolvedTempDir,
      ),
      true,
    );
    assert.equal(path.dirname(firstParent), resolvedTempDir);
    assert.equal(path.dirname(secondParent), resolvedTempDir);
    assert.notEqual(firstParent, secondParent);
    await assert.rejects(() => access(path.join(rootDir, "not-created")));
  });
}
