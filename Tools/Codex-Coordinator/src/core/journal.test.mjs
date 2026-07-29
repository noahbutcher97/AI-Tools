import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  openJournal,
  readJournalEvents,
  recoverJournalMutationFence,
} from "./journal.mjs";
import {
  hashCoordinatorState,
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";

const thisFile = fileURLToPath(import.meta.url);

function event(sequence, type = "runtime.started", payload = {}) {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    timestampUtc: `2026-07-28T00:00:0${Math.min(sequence, 9)}.000Z`,
    source: "journal-test",
    type,
    payload,
  };
}

function replay(events) {
  return events.reduce(
    (state, item) => reduceCoordinatorEvent(state, item),
    initialCoordinatorState(),
  );
}

async function temporaryRoot(t) {
  const parentDir = await mkdtemp(path.join(tmpdir(), "codex-journal-"));
  t.after(() => rm(parentDir, { recursive: true, force: true }));
  return path.join(parentDir, "runtime");
}

async function runCrashChild() {
  const rootDir = process.env.COORD_JOURNAL_ROOT;
  const crashBoundary = process.env.COORD_JOURNAL_BOUNDARY;
  const journal = await openJournal({
    rootDir,
    async boundaryHook(boundary) {
      if (boundary === crashBoundary) {
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
      }
    },
  });

  if (crashBoundary.startsWith("append.") || crashBoundary.startsWith("flush.")) {
    await journal.append(event(1), { flush: true });
  } else if (crashBoundary.startsWith("checkpoint.")) {
    const state = replay(await journal.readFrom(0));
    await journal.checkpoint(state);
  } else if (crashBoundary.startsWith("rotation.")) {
    await journal.rotate();
  }
  process.exitCode = 97;
}

async function runRaceChild() {
  const journal = await openJournal({
    rootDir: process.env.COORD_JOURNAL_ROOT,
  });
  await journal.append(event(1), { flush: true });
}

function spawnChild(rootDir, environment, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [thisFile], {
      env: {
        ...process.env,
        COORD_JOURNAL_ROOT: rootDir,
        ...environment,
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
      reject(new Error(`child timed out during ${timeoutLabel}`));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

function spawnCrash(rootDir, boundary) {
  return spawnChild(
    rootDir,
    {
      COORD_JOURNAL_CRASH_CHILD: "1",
      COORD_JOURNAL_BOUNDARY: boundary,
    },
    boundary,
  );
}

async function assertBoundaryReached(rootDir, boundary) {
  assert.equal(
    await readFile(
      path.join(rootDir, `boundary-${boundary.replace(".", "-")}.reached`),
      "utf8",
    ),
    `${boundary}\n`,
  );
}

async function recoverDeadMutationFence(rootDir) {
  const journal = await openJournal({ rootDir });
  const status = await journal.getRecoveryStatus();
  assert.equal(status.health, "recovery-required");
  assert.equal(status.mutationFence.kind, "journal-mutation");
  return recoverJournalMutationFence(rootDir, {
    expectedLockSha256: status.mutationFence.lockSha256,
  });
}

if (process.env.COORD_JOURNAL_CRASH_CHILD === "1") {
  await runCrashChild();
} else if (process.env.COORD_JOURNAL_RACE_CHILD === "1") {
  await runRaceChild();
} else {
  test("journal appends sequential validated events and replays them", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.append(event(2, "runtime.stopped"), { flush: true });

    assert.deepEqual(
      (await journal.readFrom(0)).map((item) => item.sequence),
      [1, 2],
    );
    assert.deepEqual(
      (await journal.readFrom(1)).map((item) => item.sequence),
      [2],
    );
    await assert.rejects(
      () => journal.append(event(4), { flush: true }),
      /sequence.*3/i,
    );
  });

  test("journal serializes concurrent root mutations before writing", async (t) => {
    const rootDir = await temporaryRoot(t);
    const firstJournal = await openJournal({ rootDir });
    const secondJournal = await openJournal({ rootDir });
    const sameSequence = await Promise.allSettled([
      firstJournal.append(event(1), { flush: true }),
      secondJournal.append(
        { ...event(1), eventId: "duplicate-sequence" },
        { flush: true },
      ),
    ]);
    assert.equal(
      sameSequence.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.deepEqual(
      (await readJournalEvents(rootDir)).map((item) => item.sequence),
      [1],
    );

    const rootDir2 = await temporaryRoot(t);
    const orderedJournal = await openJournal({ rootDir: rootDir2 });
    const ordered = await Promise.all([
      orderedJournal.append(event(1), { flush: true }),
      orderedJournal.append(event(2, "runtime.stopped"), { flush: true }),
    ]);
    assert.equal(ordered.length, 2);
    assert.deepEqual(
      (await readJournalEvents(rootDir2)).map((item) => item.sequence),
      [1, 2],
    );
  });

  test("journal fences concurrent writers in separate processes", async (t) => {
    const rootDir = await temporaryRoot(t);
    await openJournal({ rootDir });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        spawnChild(
          rootDir,
          { COORD_JOURNAL_RACE_CHILD: "1" },
          "cross-process append race",
        )),
    );
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.deepEqual(
      (await readJournalEvents(rootDir)).map((item) => item.sequence),
      [1],
    );
  });

  test("journal mutation respects the shared upgrade fence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const lockPath = path.join(
      path.dirname(rootDir),
      ".codex-coordinator-upgrade.lock",
    );
    await writeFile(lockPath, "upgrade in progress\n");
    await assert.rejects(
      () => journal.append(event(1), { flush: true }),
      /fenced|active.*lock|upgrade/i,
    );
    assert.deepEqual(await readJournalEvents(rootDir), []);
    await unlink(lockPath);
  });

  test("journal serializes concurrent first-open initialization", async (t) => {
    const parent = await temporaryRoot(t);
    const rootDir = path.join(parent, "new-runtime");
    const [firstJournal, secondJournal] = await Promise.all([
      openJournal({ rootDir }),
      openJournal({ rootDir }),
    ]);
    const results = await Promise.allSettled([
      firstJournal.append(event(1), { flush: true }),
      secondJournal.append(
        { ...event(1), eventId: "concurrent-first-open" },
        { flush: true },
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.deepEqual(
      (await readJournalEvents(rootDir)).map((item) => item.sequence),
      [1],
    );
  });

  test("journal requires sequence-one genesis or a checkpoint anchor", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await writeFile(
      journal.activePath,
      `${JSON.stringify(event(2))}\n`,
      "utf8",
    );
    await assert.rejects(
      () => readJournalEvents(rootDir),
      /genesis|sequence.*1/i,
    );
  });

  test("journal requires every rotated segment to begin with a checkpoint", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await writeFile(
      path.join(
        rootDir,
        "journal",
        "segments",
        "segment-000002.jsonl",
      ),
      `${JSON.stringify(event(2, "runtime.stopped"))}\n`,
      "utf8",
    );

    await assert.rejects(
      () => readJournalEvents(rootDir),
      /segment.*checkpoint|checkpoint.*segment/i,
    );
  });

  test("journal reserves checkpoint events for the checkpoint workflow", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const state = initialCoordinatorState();
    await assert.rejects(
      () =>
        journal.append(
          event(1, "state.checkpoint", {
            state,
            stateHash: hashCoordinatorState(state),
            priorLastSequence: 0,
            priorSegment: "segment-000000.jsonl",
          }),
          { flush: true },
        ),
      /checkpoint.*workflow|cannot append.*checkpoint/i,
    );
  });

  test("journal truncated trailing record never becomes replay state", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await appendFile(journal.activePath, '{"schemaVersion":1');

    const events = await journal.readFrom(0);
    assert.deepEqual(events.map((item) => item.sequence), [1]);
    const recovery = await journal.getRecoveryStatus();
    assert.equal(recovery.health, "recovery-required");
    assert.equal(recovery.tail.byteLength > 0, true);
    await assert.rejects(
      () => journal.append(event(2), { flush: true }),
      /recovery-required|truncated/i,
    );
  });

  test("journal valid JSON without a final record terminator is recovery evidence", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await writeFile(journal.activePath, JSON.stringify(event(1)), "utf8");

    assert.deepEqual(await journal.readFrom(0), []);
    assert.equal((await journal.getRecoveryStatus()).health, "recovery-required");
  });

  test("journal writes canonical JSON object bytes", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(
      event(1, "runtime.started", { z: 1, a: { y: 2, b: 3 } }),
      { flush: true },
    );
    const text = await readFile(journal.activePath, "utf8");
    assert.equal(
      text.includes('"payload":{"a":{"b":3,"y":2},"z":1}'),
      true,
    );
  });

  test("journal checkpoint rotation starts the new segment with verified state", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir, maxSegmentBytes: 1 });
    await journal.append(event(1), { flush: true });
    const state = replay(await journal.readFrom(0));

    const checkpoint = await journal.checkpoint(state);
    assert.equal(checkpoint.stateHash, hashCoordinatorState(state));
    assert.equal((await stat(checkpoint.pendingPath)).isFile(), true);
    const rotation = await journal.rotate();

    assert.equal(rotation.checkpointSequence, 2);
    assert.notEqual(rotation.activePath, rotation.previousActivePath);
    const activeText = await readFile(rotation.activePath, "utf8");
    const firstEvent = JSON.parse(activeText.trim().split(/\r?\n/, 1)[0]);
    assert.equal(firstEvent.type, "state.checkpoint");
    assert.equal(firstEvent.payload.stateHash, hashCoordinatorState(state));
    assert.equal(
      hashCoordinatorState(replay(await journal.readFrom(0))),
      hashCoordinatorState(state),
    );
    const retention = JSON.parse(
      await readFile(path.join(rootDir, "journal", "retention.json"), "utf8"),
    );
    assert.equal(retention.eligibleSegments.length, 1);
    const retained = retention.eligibleSegments[0];
    assert.equal(
      Date.parse(retained.deleteAfterUtc) - Date.parse(retained.eligibleUtc),
      7 * 24 * 60 * 60 * 1_000,
    );
    assert.equal(journal.maxSegmentBytes, 1);
  });

  test("journal uses the ten MiB default segment threshold", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    assert.equal(journal.maxSegmentBytes, 10 * 1024 * 1024);
  });

  test("journal deletes retention-eligible diagnostics after seven days", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    const firstRotation = await journal.rotate();
    const retentionPath = path.join(rootDir, "journal", "retention.json");
    const retention = JSON.parse(await readFile(retentionPath, "utf8"));
    const originalDateNow = Date.now;
    Date.now = () =>
      Date.parse(retention.eligibleSegments[0].deleteAfterUtc) + 1;
    try {
      await journal.append(event(3, "runtime.stopped"), { flush: true });
      await journal.checkpoint(replay(await journal.readFrom(0)));
      await journal.rotate();
    } finally {
      Date.now = originalDateNow;
    }

    await assert.rejects(
      () => access(firstRotation.previousActivePath),
      /ENOENT/,
    );
    const pruned = JSON.parse(await readFile(retentionPath, "utf8"));
    assert.deepEqual(
      pruned.eligibleSegments.map((item) => item.path),
      ["segment-000002.jsonl"],
    );
  });

  test("journal checkpoint must match authoritative replay state", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(
      event(1, "runtime.started", { generationId: "runtime-1" }),
      { flush: true },
    );
    const forged = replay(await journal.readFrom(0));
    forged.runtime.status = "stopped";
    await assert.rejects(
      () => journal.checkpoint(forged),
      /authoritative|replay|state hash/i,
    );
  });

  test("journal corrupted checkpoint prevents rotation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    const checkpoint = await journal.checkpoint(replay(await journal.readFrom(0)));
    await writeFile(checkpoint.pendingPath, '{"corrupted":true}\n');

    await assert.rejects(() => journal.rotate(), /checkpoint|schema|event/i);
    assert.equal(journal.activePath.endsWith("segment-000001.jsonl"), true);
  });

  test("journal rejects checkpoint sequence tampering before rotation", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    const checkpoint = await journal.checkpoint(replay(await journal.readFrom(0)));
    const record = JSON.parse(await readFile(checkpoint.pendingPath, "utf8"));
    record.sequence = 999;
    await writeFile(checkpoint.pendingPath, `${JSON.stringify(record)}\n`);
    await assert.rejects(
      () => journal.rotate(),
      /checkpoint.*sequence|expected.*2/i,
    );
    assert.equal((await stat(checkpoint.pendingPath)).isFile(), true);
    assert.equal(journal.activePath.endsWith("segment-000001.jsonl"), true);
  });

  test("journal pending checkpoint fences append and can finish after reopen", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));

    const reopened = await openJournal({ rootDir });
    assert.equal((await reopened.getRecoveryStatus()).health, "recovery-required");
    await assert.rejects(
      () => reopened.append(event(2), { flush: true }),
      /checkpoint|recovery-required/i,
    );
    await reopened.rotate();
    assert.equal((await reopened.getRecoveryStatus()).health, "healthy");
  });

  test("journal rotation fails before rename on corrupt retention metadata", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    const checkpoint = await journal.checkpoint(replay(await journal.readFrom(0)));
    await writeFile(
      path.join(rootDir, "journal", "retention.json"),
      "not-json\n",
    );
    await assert.rejects(() => journal.rotate(), /retention/i);
    assert.equal((await stat(checkpoint.pendingPath)).isFile(), true);
    assert.equal(journal.activePath.endsWith("segment-000001.jsonl"), true);
  });

  test("journal rejects retention shorter than seven days", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    await writeFile(
      path.join(rootDir, "journal", "retention.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        eligibleSegments: [{
          path: "segment-000099.jsonl",
          eligibleUtc: "2026-07-28T00:00:00.000Z",
          deleteAfterUtc: "2026-07-28T00:00:01.000Z",
          checkpointSequence: 1,
          stateHash: "0".repeat(64),
        }],
      })}\n`,
    );

    await assert.rejects(() => journal.rotate(), /retention|seven days/i);
  });

  test("journal rejects a forged segment-committed rotation ledger", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    const segmentsDir = path.join(rootDir, "journal", "segments");
    await writeFile(
      path.join(rootDir, "journal", "rotation-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "segment-committed",
        pendingPath: path.join(
          segmentsDir,
          ".pending-segment-000002.jsonl",
        ),
        targetPath: journal.activePath,
        previousActivePath: journal.activePath,
        checkpointSequence: 777,
        stateHash: "0".repeat(64),
        retention: {
          schemaVersion: 1,
          eligibleSegments: [{
            path: "segment-000001.jsonl",
            eligibleUtc: "2026-07-28T00:00:00.000Z",
            deleteAfterUtc: "2026-08-04T00:00:00.000Z",
            checkpointSequence: 777,
            stateHash: "0".repeat(64),
          }],
        },
      })}\n`,
    );

    await assert.rejects(
      () => journal.rotate(),
      /rotation.*checkpoint|rotation.*identity|ledger|state hash/i,
    );
  });

  test("journal rejects drifted completed rotation metadata", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    await journal.rotate();
    const rotationPath = path.join(
      rootDir,
      "journal",
      "rotation-state.json",
    );
    const rotation = JSON.parse(await readFile(rotationPath, "utf8"));
    rotation.stateHash = "0".repeat(64);
    await writeFile(rotationPath, `${JSON.stringify(rotation)}\n`);

    await assert.rejects(
      () => journal.getRecoveryStatus(),
      /rotation.*ledger|checkpoint|state hash|boundary/i,
    );
  });

  test("journal fences retention drift from its completed rotation ledger", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    const completed = await journal.rotate();
    const retentionPath = path.join(
      rootDir,
      "journal",
      "retention.json",
    );
    const retention = JSON.parse(await readFile(retentionPath, "utf8"));
    retention.eligibleSegments[0].eligibleUtc =
      "2026-07-20T00:00:00.000Z";
    retention.eligibleSegments[0].deleteAfterUtc =
      "2026-07-27T00:00:00.000Z";
    await writeFile(retentionPath, `${JSON.stringify(retention)}\n`);

    await assert.rejects(
      () => journal.getRecoveryStatus(),
      /retention.*rotation|rotation.*retention|ledger.*retention/i,
    );
    await assert.rejects(
      () => journal.append(event(3), { flush: true }),
      /retention.*rotation|rotation.*retention|ledger.*retention/i,
    );
    await access(completed.previousActivePath);
  });

  test("journal rejects a missing unexpired retained segment", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    const firstRotation = await journal.rotate();
    await journal.append(event(3, "runtime.stopped"), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    await journal.rotate();
    await unlink(firstRotation.previousActivePath);

    await assert.rejects(
      () => journal.getRecoveryStatus(),
      /retained segment.*missing|retention.*missing|unexpired/i,
    );
  });

  test("journal rejects a checkpoint that conflicts with retained history", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    const rotation = await journal.rotate();
    const checkpoint = JSON.parse(
      (await readFile(rotation.activePath, "utf8")).trim(),
    );
    checkpoint.payload.state.runtime.status = "stopped";
    checkpoint.payload.stateHash = hashCoordinatorState(
      checkpoint.payload.state,
    );
    await writeFile(
      rotation.activePath,
      `${JSON.stringify(checkpoint)}\n`,
    );

    await assert.rejects(
      () => openJournal({ rootDir }),
      /checkpoint.*authoritative|retained.*history|state hash/i,
    );
  });

  test("journal rejects symlinked segment paths before append", async (t) => {
    const rootDir = await temporaryRoot(t);
    const segmentsDir = path.join(rootDir, "journal", "segments");
    await mkdir(segmentsDir, { recursive: true });
    const outsidePath = path.join(rootDir, "outside.txt");
    await writeFile(outsidePath, "outside\n");
    await symlink(
      outsidePath,
      path.join(segmentsDir, "segment-000001.jsonl"),
      "file",
    );

    await assert.rejects(
      () => openJournal({ rootDir }),
      /symbolic|symlink|reparse/i,
    );
    assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
  });

  test("journal rejects hard-linked segment paths before append", async (t) => {
    const rootDir = await temporaryRoot(t);
    const segmentsDir = path.join(rootDir, "journal", "segments");
    await mkdir(segmentsDir, { recursive: true });
    const outsidePath = path.join(rootDir, "outside-hardlink.txt");
    await writeFile(outsidePath, "");
    await link(
      outsidePath,
      path.join(segmentsDir, "segment-000001.jsonl"),
    );

    await assert.rejects(
      () => openJournal({ rootDir }),
      /hard[- ]link|link count|multiple links/i,
    );
  });

  test("journal verifies the opened segment identity after boundary hooks", async (t) => {
    const rootDir = await temporaryRoot(t);
    await mkdir(rootDir, { recursive: true });
    const outsidePath = path.join(rootDir, "outside-swap.txt");
    await writeFile(outsidePath, "outside\n");
    const journal = await openJournal({
      rootDir,
      async boundaryHook(boundary, details) {
        if (boundary === "append.before") {
          await unlink(details.activePath);
          await symlink(outsidePath, details.activePath, "file");
        }
      },
    });

    await assert.rejects(
      () => journal.append(event(1), { flush: true }),
      /symbolic|identity|link/i,
    );
    assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
  });

  test("journal reconciles a post-rename rotation interruption", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({
      rootDir,
      boundaryHook(boundary) {
        if (boundary === "rotation.after") {
          throw new Error("injected post-rename interruption");
        }
      },
    });
    await journal.append(event(1), { flush: true });
    await journal.checkpoint(replay(await journal.readFrom(0)));
    await assert.rejects(() => journal.rotate(), /post-rename/i);

    const reopened = await openJournal({ rootDir });
    assert.equal((await reopened.getRecoveryStatus()).health, "recovery-required");
    const recovered = await reopened.rotate();
    assert.equal(recovered.checkpointSequence, 2);
    assert.equal((await reopened.getRecoveryStatus()).health, "healthy");
  });

  test("journal replay produces the same reduced state twice", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    await journal.append(event(1), { flush: true });
    await journal.append(event(2, "runtime.degraded", { reason: "disk-full" }), {
      flush: true,
    });
    const first = replay(await readJournalEvents(rootDir));
    const second = replay(await readJournalEvents(rootDir));
    assert.deepEqual(second, first);
    assert.equal(hashCoordinatorState(second), hashCoordinatorState(first));
  });

  test("journal forced exits recover only previous or next append state", async (t) => {
    for (const boundary of [
      "append.before",
      "append.after",
      "flush.before",
      "flush.after",
    ]) {
      const rootDir = await temporaryRoot(t);
      const result = await spawnCrash(rootDir, boundary);
      assert.notEqual(result.code, 97, `${boundary}: ${result.stderr}`);
      await assertBoundaryReached(rootDir, boundary);
      const events = await readJournalEvents(rootDir);
      assert.equal([0, 1].includes(events.length), true, boundary);
      if (boundary === "append.before") {
        assert.equal(events.length, 0);
      }
      if (boundary === "flush.after") {
        assert.equal(events.length, 1);
      }
      await recoverDeadMutationFence(rootDir);
      const reopened = await openJournal({ rootDir });
      const nextSequence = events.length + 1;
      await reopened.append(
        event(
          nextSequence,
          nextSequence === 1 ? "runtime.started" : "runtime.stopped",
        ),
        { flush: true },
      );
    }
  });

  test("journal hash-fenced recovery clears only a dead mutation owner", async (t) => {
    const rootDir = await temporaryRoot(t);
    const result = await spawnCrash(rootDir, "append.before");
    assert.notEqual(result.code, 97, result.stderr);
    const journal = await openJournal({ rootDir });
    const recovery = await journal.getRecoveryStatus();
    assert.equal(recovery.health, "recovery-required");
    assert.equal(recovery.mutationFence.kind, "journal-mutation");
    await assert.rejects(
      () =>
        recoverJournalMutationFence(rootDir, {
          expectedLockSha256: "0".repeat(64),
        }),
      /hash.*drift|expected.*hash/i,
    );
    const recovered = await recoverJournalMutationFence(rootDir, {
      expectedLockSha256: recovery.mutationFence.lockSha256,
    });
    assert.equal(recovered.health, "healthy");
    await journal.append(event(1), { flush: true });
    assert.deepEqual(
      (await journal.readFrom(0)).map((item) => item.sequence),
      [1],
    );
  });

  test("journal mutation recovery refuses a live owner", async (t) => {
    const rootDir = await temporaryRoot(t);
    const journal = await openJournal({ rootDir });
    const lockPath = path.join(
      path.dirname(rootDir),
      ".codex-coordinator-upgrade.lock",
    );
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        operation: "journal-mutation",
        operationName: "append",
        rootDir,
        ownerPid: process.pid,
        token: "11111111-1111-4111-8111-111111111111",
        acquiredUtc: new Date().toISOString(),
      })}\n`,
    );
    const status = await journal.getRecoveryStatus();
    await assert.rejects(
      () =>
        recoverJournalMutationFence(rootDir, {
          expectedLockSha256: status.mutationFence.lockSha256,
        }),
      /refuses live owner|owner.*alive/i,
    );
    await unlink(lockPath);
  });

  test("journal forced exits preserve checkpoint and rotation atomicity", async (t) => {
    for (const boundary of ["checkpoint.before", "checkpoint.after"]) {
      const rootDir = await temporaryRoot(t);
      const journal = await openJournal({ rootDir });
      await journal.append(event(1), { flush: true });
      const beforeHash = hashCoordinatorState(replay(await journal.readFrom(0)));
      const result = await spawnCrash(rootDir, boundary);
      assert.notEqual(result.code, 97, `${boundary}: ${result.stderr}`);
      await assertBoundaryReached(rootDir, boundary);
      assert.equal(
        hashCoordinatorState(replay(await readJournalEvents(rootDir))),
        beforeHash,
      );
      await recoverDeadMutationFence(rootDir);
      const reopened = await openJournal({ rootDir });
      if (boundary === "checkpoint.before") {
        await reopened.checkpoint(replay(await reopened.readFrom(0)));
      } else {
        await reopened.rotate();
      }
    }

    for (const boundary of ["rotation.before", "rotation.after"]) {
      const rootDir = await temporaryRoot(t);
      const journal = await openJournal({ rootDir });
      await journal.append(event(1), { flush: true });
      const beforeState = replay(await journal.readFrom(0));
      await journal.checkpoint(beforeState);
      const result = await spawnCrash(rootDir, boundary);
      assert.notEqual(result.code, 97, `${boundary}: ${result.stderr}`);
      await assertBoundaryReached(rootDir, boundary);
      assert.equal(
        hashCoordinatorState(replay(await readJournalEvents(rootDir))),
        hashCoordinatorState(beforeState),
      );
      await recoverDeadMutationFence(rootDir);
      const reopened = await openJournal({ rootDir });
      await reopened.rotate();
    }
  });
}
