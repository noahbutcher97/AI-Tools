import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openJournal } from "./journal.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";
import {
  executeRuntimeUpgrade,
  planRuntimeUpgrade,
  recoverRuntimeUpgrade,
} from "./versioning.mjs";

function startedEvent(sequence = 1) {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `upgrade-${sequence}`,
    timestampUtc: `2026-07-28T00:00:0${sequence}.000Z`,
    source: "versioning-test",
    type: "runtime.started",
    payload: { generationId: "runtime-1" },
  };
}

async function createRuntime(t, metadata = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "codex-upgrade-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, "runtime-v1");
  const journal = await openJournal({ rootDir: sourceRoot });
  await journal.append(startedEvent(), { flush: true });
  await writeFile(
    path.join(sourceRoot, "runtime-version.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        toolVersion: "0.1.0",
        mutationSequence: 1,
        ...metadata,
      },
      null,
      2,
    )}\n`,
  );
  return { parent, sourceRoot };
}

async function treeSnapshot(rootDir, current = rootDir) {
  const entries = await readdir(current, { withFileTypes: true });
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      rows.push(...(await treeSnapshot(rootDir, absolutePath)));
    } else {
      const bytes = await readFile(absolutePath);
      rows.push({
        path: path.relative(rootDir, absolutePath).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return rows;
}

test("versioning dry-run verifies upgrade without writing", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const before = await readdir(parent);
  const beforeSource = await treeSnapshot(sourceRoot);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  const after = await readdir(parent);
  const afterSource = await treeSnapshot(sourceRoot);

  assert.deepEqual(after, before);
  assert.deepEqual(afterSource, beforeSource);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.sourceVersion, "0.1.0");
  assert.equal(plan.targetVersion, "0.2.0");
  assert.match(plan.sourceStateHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.availableBytes >= plan.requiredBytes, true);
  assert.equal(plan.sourceManifest.length > 0, true);
  assert.deepEqual(plan.orderedMigrations, []);
});

test("versioning rejects an unknown newer runtime schema", async (t) => {
  const { sourceRoot } = await createRuntime(t, { schemaVersion: 2 });
  await assert.rejects(
    () => planRuntimeUpgrade({ sourceRoot, targetVersion: "0.2.0" }),
    /newer|schema/i,
  );
});

test("versioning execute backs up, replays state hash, switches, and rolls back", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  const result = await executeRuntimeUpgrade(plan);

  assert.equal(result.backupVerified, true);
  assert.equal(result.sourceStateHash, result.targetStateHash);
  assert.equal(result.activeRoot, result.targetRoot);
  const pointer = JSON.parse(await readFile(result.activePointerPath, "utf8"));
  assert.equal(pointer.activeRoot, result.targetRoot);
  const rollback = await result.rollback();
  assert.equal(rollback.activeRoot, sourceRoot);
  const rolledBackPointer = JSON.parse(
    await readFile(result.activePointerPath, "utf8"),
  );
  assert.equal(rolledBackPointer.activeRoot, sourceRoot);
});

test("versioning rollback refuses mutation after active-root switch", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const result = await executeRuntimeUpgrade(
    await planRuntimeUpgrade({ sourceRoot, targetVersion: "0.2.0" }),
  );
  const targetJournal = await openJournal({ rootDir: result.targetRoot });
  await targetJournal.append(
    {
      ...startedEvent(2),
      eventId: "post-upgrade-mutation",
      type: "runtime.stopped",
      payload: {},
    },
    { flush: true },
  );

  await assert.rejects(() => result.rollback(), /mutation|boundary/i);
  await assert.rejects(() => access(result.lockPath), /ENOENT/);
});

test("versioning execute rejects tampered derived paths", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  const redirected = path.join(parent, "redirected-pointer.json");
  plan.activePointerPath = redirected;
  await assert.rejects(() => executeRuntimeUpgrade(plan), /plan|derived|drift/i);
  await assert.rejects(() => access(redirected), /ENOENT/);
});

test("versioning execute requires active pointer to identify the source", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await writeFile(
    path.join(parent, "active-root.json"),
    `${JSON.stringify({ schemaVersion: 1, activeRoot: "C:/foreign" })}\n`,
  );
  await assert.rejects(
    () => executeRuntimeUpgrade(plan),
    /active root|pointer|source/i,
  );
});

test("versioning rejects a relative active root pointer", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await writeFile(
    path.join(parent, "active-root.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      activeRoot: path.basename(sourceRoot),
    })}\n`,
  );
  const originalWorkingDirectory = process.cwd();
  process.chdir(parent);
  try {
    await assert.rejects(
      () => executeRuntimeUpgrade(plan),
      /active root.*schema|pointer.*schema|absolute|relative/i,
    );
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});

test("versioning rejects a drive-relative rooted active pointer", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await writeFile(
    path.join(parent, "active-root.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      activeRoot: sourceRoot.slice(2),
    })}\n`,
  );
  const originalWorkingDirectory = process.cwd();
  process.chdir(path.parse(sourceRoot).root);
  try {
    await assert.rejects(
      () => executeRuntimeUpgrade(plan),
      /active root.*schema|pointer.*schema|fully qualified|drive-relative/i,
    );
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});

test("versioning rejects an unresolved source journal before planning", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const journal = await openJournal({
    rootDir: sourceRoot,
    boundaryHook(boundary) {
      if (boundary === "rotation.after") {
        throw new Error("injected post-rename interruption");
      }
    },
  });
  const state = (await journal.readFrom(0)).reduce(
    (current, item) => reduceCoordinatorEvent(current, item),
    initialCoordinatorState(),
  );
  await journal.checkpoint(state);
  await assert.rejects(() => journal.rotate(), /interruption/i);
  assert.equal((await journal.getRecoveryStatus()).health, "recovery-required");

  await assert.rejects(
    () => planRuntimeUpgrade({ sourceRoot, targetVersion: "0.2.0" }),
    /journal.*recovery|required.*healthy/i,
  );
});

test("versioning fails closed on unknown active-pointer schema", async (t) => {
  const { parent, sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await writeFile(
    path.join(parent, "active-root.json"),
    `${JSON.stringify({
      schemaVersion: 999,
      activeRoot: sourceRoot,
      unknownNewerField: true,
    })}\n`,
  );
  await assert.rejects(
    () => executeRuntimeUpgrade(plan),
    /active root.*schema|pointer.*schema|unknown/i,
  );
});

test("versioning exposes hash-fenced abort for an interrupted upgrade", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    plan.transactionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      phase: "copying-backup",
      sourceRoot: plan.sourceRoot,
      backupPendingRoot: plan.backupPendingRoot,
      targetPendingRoot: plan.targetPendingRoot,
      startedUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await mkdir(plan.backupPendingRoot, { recursive: true });
  await writeFile(path.join(plan.backupPendingRoot, "partial"), "partial\n");

  await assert.rejects(() => executeRuntimeUpgrade(plan), /recovery-required/i);
  const inspection = await recoverRuntimeUpgrade(plan);
  assert.equal(inspection.recoveryRequired, true);
  assert.match(inspection.lockSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () =>
      recoverRuntimeUpgrade(plan, {
        action: "abort",
        expectedLockSha256: "0".repeat(64),
      }),
    /lock.*drift|hash/i,
  );
  const aborted = await recoverRuntimeUpgrade(plan, {
    action: "abort",
    expectedLockSha256: inspection.lockSha256,
    expectedTransactionSha256: inspection.transactionSha256,
  });
  assert.equal(aborted.aborted, true);
  await assert.rejects(() => access(plan.lockPath), /ENOENT/);
  await assert.rejects(() => access(plan.transactionPath), /ENOENT/);
  await assert.rejects(() => access(plan.backupPendingRoot), /ENOENT/);

  const result = await executeRuntimeUpgrade(plan);
  assert.equal(result.activeRoot, result.targetRoot);
});

test("versioning recovers a crash after lock acquisition", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await mkdir(plan.backupRoot, { recursive: true });
  const foreignSentinel = path.join(plan.backupRoot, "foreign-sentinel.txt");
  await writeFile(foreignSentinel, "foreign\n");
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  const inspection = await recoverRuntimeUpgrade(plan);
  assert.equal(inspection.phase, "lock-acquired");
  await recoverRuntimeUpgrade(plan, {
    action: "abort",
    expectedLockSha256: inspection.lockSha256,
  });
  assert.equal(await readFile(foreignSentinel, "utf8"), "foreign\n");
  await rm(plan.backupRoot, { recursive: true });
  const result = await executeRuntimeUpgrade(plan);
  assert.equal(result.activeRoot, result.targetRoot);
});

test("versioning finalizes a switched crash and reconstructs rollback", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  const completed = await executeRuntimeUpgrade(plan);
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );

  const inspection = await recoverRuntimeUpgrade(plan);
  assert.equal(inspection.phase, "switched");
  const finalized = await recoverRuntimeUpgrade(plan, {
    action: "finalize",
    expectedLockSha256: inspection.lockSha256,
    expectedTransactionSha256: inspection.transactionSha256,
  });
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.activeRoot, completed.targetRoot);
  const rolledBack = await finalized.rollback();
  assert.equal(rolledBack.activeRoot, sourceRoot);
});

test("versioning aborts a verified backup rename crash window", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await cp(plan.sourceRoot, plan.backupRoot, { recursive: true });
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    plan.transactionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      phase: "copying-backup",
      sourceRoot: plan.sourceRoot,
      backupPendingRoot: plan.backupPendingRoot,
      targetPendingRoot: plan.targetPendingRoot,
      startedUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  const inspection = await recoverRuntimeUpgrade(plan);
  await recoverRuntimeUpgrade(plan, {
    action: "abort",
    expectedLockSha256: inspection.lockSha256,
    expectedTransactionSha256: inspection.transactionSha256,
  });
  await assert.rejects(() => access(plan.backupRoot), /ENOENT/);
  const result = await executeRuntimeUpgrade(plan);
  assert.equal(result.activeRoot, result.targetRoot);
});

test("versioning aborts a verified target rename crash window", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await executeRuntimeUpgrade(plan);
  await writeFile(
    plan.activePointerPath,
    `${JSON.stringify({ schemaVersion: 1, activeRoot: plan.sourceRoot })}\n`,
  );
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    plan.transactionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      phase: "migrating-target",
      sourceRoot: plan.sourceRoot,
      backupRoot: plan.backupRoot,
      targetPendingRoot: plan.targetPendingRoot,
      updatedUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  const inspection = await recoverRuntimeUpgrade(plan);
  await recoverRuntimeUpgrade(plan, {
    action: "abort",
    expectedLockSha256: inspection.lockSha256,
    expectedTransactionSha256: inspection.transactionSha256,
  });
  await assert.rejects(() => access(plan.targetRoot), /ENOENT/);
  await assert.rejects(() => access(plan.backupRoot), /ENOENT/);
  const result = await executeRuntimeUpgrade(plan);
  assert.equal(result.activeRoot, result.targetRoot);
});

test("versioning control metadata ignores inherited toJSON hooks", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  Object.defineProperty(Object.prototype, "toJSON", {
    value() {
      return null;
    },
    configurable: true,
  });
  try {
    const result = await executeRuntimeUpgrade(plan);
    const pointer = JSON.parse(
      await readFile(result.activePointerPath, "utf8"),
    );
    assert.equal(pointer.activeRoot, result.targetRoot);
    const rolledBack = await result.rollback();
    assert.equal(rolledBack.activeRoot, sourceRoot);
  } finally {
    delete Object.prototype.toJSON;
  }
});

test("versioning finalize rejects a missing active pointer", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  await executeRuntimeUpgrade(plan);
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  const inspection = await recoverRuntimeUpgrade(plan);
  await unlink(plan.activePointerPath);
  await assert.rejects(
    () =>
      recoverRuntimeUpgrade(plan, {
        action: "finalize",
        expectedLockSha256: inspection.lockSha256,
        expectedTransactionSha256: inspection.transactionSha256,
      }),
    /active root.*missing|pointer.*missing|ENOENT/i,
  );
});

test("versioning finalizes a rollback crash after pointer switch", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const plan = await planRuntimeUpgrade({
    sourceRoot,
    targetVersion: "0.2.0",
  });
  const completed = await executeRuntimeUpgrade(plan);
  await writeFile(
    plan.lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      acquiredUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    plan.transactionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.planId,
      phase: "rollback-prepared",
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      backupRoot: plan.backupRoot,
      targetManifestHash: completed.targetManifestHash,
      targetStateHash: completed.targetStateHash,
      updatedUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    plan.activePointerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      activeRoot: plan.sourceRoot,
      priorRoot: plan.targetRoot,
      planId: plan.planId,
      rolledBackUtc: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );

  const inspection = await recoverRuntimeUpgrade(plan);
  assert.equal(inspection.phase, "rollback-prepared");
  const recovered = await recoverRuntimeUpgrade(plan, {
    action: "finalize-rollback",
    expectedLockSha256: inspection.lockSha256,
    expectedTransactionSha256: inspection.transactionSha256,
  });
  assert.equal(recovered.activeRoot, sourceRoot);
  await assert.rejects(() => access(plan.lockPath), /ENOENT/);
});

test("versioning rollback refuses a same-state checkpoint mutation", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const result = await executeRuntimeUpgrade(
    await planRuntimeUpgrade({ sourceRoot, targetVersion: "0.2.0" }),
  );
  const targetJournal = await openJournal({ rootDir: result.targetRoot });
  const events = await targetJournal.readFrom(0);
  const state = events.reduce(
    (current, item) => reduceCoordinatorEvent(current, item),
    initialCoordinatorState(),
  );
  await targetJournal.checkpoint(state);
  await targetJournal.rotate();
  await assert.rejects(() => result.rollback(), /mutation|boundary/i);
  await assert.rejects(() => access(result.lockPath), /ENOENT/);
});

test("versioning rollback refuses non-journal target mutation", async (t) => {
  const { sourceRoot } = await createRuntime(t);
  const result = await executeRuntimeUpgrade(
    await planRuntimeUpgrade({ sourceRoot, targetVersion: "0.2.0" }),
  );
  await writeFile(path.join(result.targetRoot, "foreign.txt"), "mutation\n");
  await assert.rejects(() => result.rollback(), /mutation|boundary/i);
});
