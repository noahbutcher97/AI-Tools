import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openJournal } from "./journal.mjs";
import {
  createMigrationStateMachine,
  hashMigrationState,
} from "./migration.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const BOOT_ID = "windows-boot-2026-07-28-a";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIR, "..", "..");
const MIGRATION_MODULE_URL = pathToFileURL(
  path.join(TEST_DIR, "migration.mjs"),
).href;
const JOURNAL_MODULE_URL = pathToFileURL(
  path.join(TEST_DIR, "journal.mjs"),
).href;
const MUTEX_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "Invoke-CoordinatorMigration.ps1",
);

function spawnAndCollect(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
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
}

const allowedTransitions = [
  ["legacy-active", "shadow-observe"],
  ["shadow-observe", "cutover-prepared"],
  ["cutover-prepared", "unified-active"],
  ["unified-active", "rollback-prepared"],
  ["rollback-prepared", "legacy-active"],
];

function ownerForMode(mode) {
  return ["legacy-active", "shadow-observe", "cutover-prepared"].includes(
    mode,
  )
    ? "legacy"
    : "unified";
}

function processIdentity(name, pid, bootId = BOOT_ID) {
  return {
    generationId: `${name}-generation-1`,
    pid,
    creationTimeUtc: "2026-07-28T00:00:00.000Z",
    executablePath: `C:\\Coordinator\\${name}.exe`,
    bootId,
  };
}

function evidenceFor(priorMode, nextMode, sequence = 0) {
  return {
    schemaVersion: 1,
    windowsBootId: BOOT_ID,
    processes: {
      supervisor: processIdentity("supervisor", 4101),
      legacy: processIdentity("legacy", 4102),
    },
    eventFile: {
      byteLength: 107,
      cursor: 96,
      remainder: "{\"partial\":",
      fingerprintSha256: SHA_A,
    },
    journal: {
      sequence,
      checkpointSha256: SHA_B,
    },
    routingOwnership: {
      priorOwners: [ownerForMode(priorMode)],
      nextOwners: [ownerForMode(nextMode)],
    },
    compatibilityOutputOwnership: {
      priorOwners: [ownerForMode(priorMode)],
      nextOwners: [ownerForMode(nextMode)],
    },
    appServer: {
      generationId: "app-server-generation-1",
      pid: 4103,
      creationTimeUtc: "2026-07-28T00:00:00.000Z",
      executablePath: "C:\\Coordinator\\codex-app-server.exe",
      bootId: BOOT_ID,
      attachmentGeneration: "attachment-generation-1",
    },
    rollbackBoundary: {
      eventCursor: 96,
      eventFingerprintSha256: SHA_A,
      frozenLegacyConfigSha256: SHA_C,
    },
  };
}

async function temporaryRoot(t) {
  const containerDir = await mkdtemp(
    path.join(os.tmpdir(), "codex-coordinator-migration-"),
  );
  const rootDir = path.join(containerDir, "runtime");
  await mkdir(path.join(rootDir, "journal", "segments"), {
    recursive: true,
  });
  t.after(async () => {
    await rm(containerDir, { recursive: true, force: true });
  });
  return rootDir;
}

async function fixture(t, options = {}) {
  const rootDir = await temporaryRoot(t);
  const journal = await openJournal({ rootDir });
  let currentEvidence = evidenceFor(
    "legacy-active",
    "shadow-observe",
    0,
  );
  const machine = createMigrationStateMachine({
    journal,
    evidenceProvider: async () => {
      const value = structuredClone(currentEvidence);
      const events = await journal.readFrom(0);
      value.journal.sequence = events.at(-1)?.sequence ?? 0;
      return value;
    },
    boundaryHook: options.boundaryHook,
  });
  return {
    rootDir,
    journal,
    machine,
    setEvidence(value) {
      currentEvidence = structuredClone(value);
    },
    getEvidence() {
      return structuredClone(currentEvidence);
    },
    async boundary(priorMode, nextMode) {
      const events = await journal.readFrom(0);
      const value = evidenceFor(
        priorMode,
        nextMode,
        events.at(-1)?.sequence ?? 0,
      );
      currentEvidence = structuredClone(value);
      return value;
    },
  };
}

test("migration accepts only the registered forward and rollback paths", async (t) => {
  const context = await fixture(t);

  for (const [priorMode, nextMode] of allowedTransitions) {
    const evidence = await context.boundary(priorMode, nextMode);
    const prepared = await context.machine.prepareTransition(
      priorMode,
      nextMode,
      evidence,
    );
    assert.match(prepared.token, /^[a-f0-9-]{36}$/i);
    assert.equal(prepared.priorMode, priorMode);
    assert.equal(prepared.nextMode, nextMode);

    const committed = await context.machine.commitTransition(
      prepared.token,
    );
    assert.equal(committed.mode, nextMode);
    assert.equal(committed.pendingTransition, null);
    assert.equal(committed.lastTransition.status, "committed");
    assert.equal(
      hashMigrationState(committed),
      hashMigrationState(
        await context.machine.readMigrationState(),
      ),
    );
  }

  assert.equal(
    (await context.machine.readMigrationState()).mode,
    "legacy-active",
  );
});

test("migration rejects forbidden skips and expected-mode drift", async (t) => {
  const context = await fixture(t);
  const forbidden = evidenceFor(
    "legacy-active",
    "cutover-prepared",
    0,
  );

  await assert.rejects(
    () =>
      context.machine.prepareTransition(
        "legacy-active",
        "cutover-prepared",
        forbidden,
      ),
    /forbidden|transition/i,
  );
  await assert.rejects(
    () =>
      context.machine.prepareTransition(
        "shadow-observe",
        "cutover-prepared",
        evidenceFor("shadow-observe", "cutover-prepared", 0),
      ),
    /expected.*mode|mode.*drift/i,
  );
  assert.equal(
    (await context.machine.readMigrationState()).mode,
    "legacy-active",
  );
});

test("migration rejects stale tokens and records an abort without changing mode", async (t) => {
  const context = await fixture(t);
  const evidence = await context.boundary(
    "legacy-active",
    "shadow-observe",
  );
  const prepared = await context.machine.prepareTransition(
    "legacy-active",
    "shadow-observe",
    evidence,
  );

  await assert.rejects(
    () => context.machine.commitTransition("00000000-0000-4000-8000-000000000000"),
    /stale|token/i,
  );
  await assert.rejects(
    () =>
      context.machine.abortTransition(
        "00000000-0000-4000-8000-000000000000",
        "wrong caller",
      ),
    /stale|token/i,
  );
  const aborted = await context.machine.abortTransition(
    prepared.token,
    "operator cancelled before ownership transfer",
  );
  assert.equal(aborted.mode, "legacy-active");
  assert.equal(aborted.pendingTransition, null);
  assert.equal(aborted.lastTransition.status, "aborted");
  assert.equal(
    aborted.lastTransition.reason,
    "operator cancelled before ownership transfer",
  );
  await assert.rejects(
    () => context.machine.commitTransition(prepared.token),
    /stale|pending|token/i,
  );
});

test("cutover fails when the signal boundary drifts", async (t) => {
  const context = await fixture(t);
  const shadow = await context.boundary(
    "legacy-active",
    "shadow-observe",
  );
  const first = await context.machine.prepareTransition(
    "legacy-active",
    "shadow-observe",
    shadow,
  );
  await context.machine.commitTransition(first.token);

  const boundary = await context.boundary(
    "shadow-observe",
    "cutover-prepared",
  );
  const prepared = await context.machine.prepareTransition(
    "shadow-observe",
    "cutover-prepared",
    boundary,
  );
  const drifted = structuredClone(boundary);
  drifted.eventFile.byteLength += 1;
  drifted.eventFile.remainder += "x";
  context.setEvidence(drifted);

  await assert.rejects(
    () => context.machine.commitTransition(prepared.token),
    /boundary drift/i,
  );
  assert.equal(
    (await context.machine.readMigrationState()).mode,
    "shadow-observe",
  );
});

test("migration re-reads every recorded ownership boundary before commit", async (t) => {
  const mutations = [
    ["supervisor generation", (value) => {
      value.processes.supervisor.generationId = "supervisor-generation-2";
    }],
    ["supervisor PID", (value) => {
      value.processes.supervisor.pid += 10;
    }],
    ["legacy creation", (value) => {
      value.processes.legacy.creationTimeUtc =
        "2026-07-28T00:00:01.000Z";
    }],
    ["event cursor", (value) => {
      value.eventFile.cursor -= 1;
      value.eventFile.remainder = `x${value.eventFile.remainder}`;
      value.rollbackBoundary.eventCursor -= 1;
    }],
    ["event remainder", (value) => {
      value.eventFile.remainder = "{\"changed\":";
    }],
    ["event fingerprint", (value) => {
      value.eventFile.fingerprintSha256 = SHA_C;
    }],
    ["checkpoint hash", (value) => {
      value.journal.checkpointSha256 = SHA_C;
    }],
    ["routing owner", (value) => {
      value.routingOwnership.nextOwners = ["unified"];
    }],
    ["compatibility owner", (value) => {
      value.compatibilityOutputOwnership.nextOwners = ["unified"];
    }],
    ["app server identity", (value) => {
      value.appServer.generationId = "app-server-generation-2";
    }],
    ["attachment generation", (value) => {
      value.appServer.attachmentGeneration = "attachment-generation-2";
    }],
    ["rollback cursor", (value) => {
      value.rollbackBoundary.eventCursor -= 1;
    }],
    ["frozen legacy config", (value) => {
      value.rollbackBoundary.frozenLegacyConfigSha256 = SHA_A;
    }],
  ];

  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const context = await fixture(subtest);
      const boundary = await context.boundary(
        "legacy-active",
        "shadow-observe",
      );
      const prepared = await context.machine.prepareTransition(
        "legacy-active",
        "shadow-observe",
        boundary,
      );
      const drifted = structuredClone(boundary);
      mutate(drifted);
      context.setEvidence(drifted);

      await assert.rejects(
        () => context.machine.commitTransition(prepared.token),
        /boundary.*(?:drift|contradict)|journal.*drift|ownership/i,
      );
      assert.equal(
        (await context.machine.readMigrationState()).mode,
        "legacy-active",
      );
    });
  }
});

test("migration rejects dual routing and compatibility output owners", async (t) => {
  for (const field of [
    "routingOwnership",
    "compatibilityOutputOwnership",
  ]) {
    await t.test(field, async (subtest) => {
      const context = await fixture(subtest);
      const evidence = await context.boundary(
        "legacy-active",
        "shadow-observe",
      );
      evidence[field].priorOwners = ["legacy", "unified"];
      context.setEvidence(evidence);

      await assert.rejects(
        () =>
          context.machine.prepareTransition(
            "legacy-active",
            "shadow-observe",
            evidence,
          ),
        /exactly one|dual|owner/i,
      );
      assert.equal((await context.journal.readFrom(0)).length, 0);
    });
  }
});

test("migration rejects PID reuse under a different Windows boot identity", async (t) => {
  const context = await fixture(t);
  const boundary = await context.boundary(
    "legacy-active",
    "shadow-observe",
  );
  const prepared = await context.machine.prepareTransition(
    "legacy-active",
    "shadow-observe",
    boundary,
  );
  const reused = structuredClone(boundary);
  reused.windowsBootId = "windows-boot-2026-07-28-b";
  reused.processes.supervisor.bootId = reused.windowsBootId;
  reused.processes.legacy.bootId = reused.windowsBootId;
  reused.appServer.bootId = reused.windowsBootId;
  context.setEvidence(reused);

  await assert.rejects(
    () => context.machine.commitTransition(prepared.token),
    /boot|boundary drift/i,
  );
  assert.equal(
    (await context.machine.readMigrationState()).pendingTransition.token,
    prepared.token,
  );
});

test("migration fences concurrent prepare callers to one pending transition", async (t) => {
  const context = await fixture(t);
  const evidence = await context.boundary(
    "legacy-active",
    "shadow-observe",
  );
  const secondMachine = createMigrationStateMachine({
    journal: await openJournal({ rootDir: context.rootDir }),
    evidenceProvider: async () => structuredClone(evidence),
  });
  const results = await Promise.allSettled([
    context.machine.prepareTransition(
      "legacy-active",
      "shadow-observe",
      evidence,
    ),
    secondMachine.prepareTransition(
      "legacy-active",
      "shadow-observe",
      evidence,
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    (await context.machine.readMigrationState()).pendingTransition !== null,
    true,
  );
  assert.equal(
    (await context.journal.readFrom(0)).filter(
      (event) => event.type === "migration.transitionPrepared",
    ).length,
    1,
  );
});

function crashChildSource(boundaryName) {
  return `
    import { openJournal } from ${JSON.stringify(JOURNAL_MODULE_URL)};
    import { createMigrationStateMachine } from ${JSON.stringify(MIGRATION_MODULE_URL)};
    const rootDir = process.env.COORDINATOR_MIGRATION_TEST_ROOT;
    const evidence = JSON.parse(process.env.COORDINATOR_MIGRATION_TEST_EVIDENCE);
    const journal = await openJournal({ rootDir });
    const machine = createMigrationStateMachine({
      journal,
      evidenceProvider: async () => {
        const value = structuredClone(evidence);
        const events = await journal.readFrom(0);
        value.journal.sequence = events.at(-1)?.sequence ?? 0;
        return value;
      },
      boundaryHook: async (boundary) => {
        if (boundary === ${JSON.stringify(boundaryName)}) {
          process.kill(process.pid, "SIGKILL");
        }
      },
    });
    const prepared = await machine.prepareTransition(
      "legacy-active",
      "shadow-observe",
      evidence,
    );
    if (${JSON.stringify(boundaryName)} === "migration.commit.afterAppend") {
      await machine.commitTransition(prepared.token);
    }
  `;
}

for (const boundaryName of [
  "migration.prepare.afterAppend",
  "migration.commit.afterAppend",
]) {
  test(`migration forced-exit recovery at ${boundaryName}`, async (t) => {
    const rootDir = await temporaryRoot(t);
    const evidence = evidenceFor(
      "legacy-active",
      "shadow-observe",
      0,
    );
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", crashChildSource(boundaryName)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COORDINATOR_MIGRATION_TEST_ROOT: rootDir,
          COORDINATOR_MIGRATION_TEST_EVIDENCE: JSON.stringify(evidence),
        },
        timeout: 30_000,
      },
    );
    assert.notEqual(child.status, 0, child.stderr);

    const journal = await openJournal({ rootDir });
    const machine = createMigrationStateMachine({
      journal,
      evidenceProvider: async () => {
        const value = structuredClone(evidence);
        const events = await journal.readFrom(0);
        value.journal.sequence = events.at(-1)?.sequence ?? 0;
        return value;
      },
    });
    const state = await machine.readMigrationState();
    if (boundaryName === "migration.prepare.afterAppend") {
      assert.equal(state.mode, "legacy-active");
      assert.equal(state.pendingTransition !== null, true);
      const committed = await machine.commitTransition(
        state.pendingTransition.token,
      );
      assert.equal(committed.mode, "shadow-observe");
    } else {
      assert.equal(state.mode, "shadow-observe");
      assert.equal(state.pendingTransition, null);
      assert.equal(state.lastTransition.status, "committed");
    }
  });
}

test("migration checkpoint rotation preserves committed ownership state", async (t) => {
  const context = await fixture(t);
  const evidence = await context.boundary(
    "legacy-active",
    "shadow-observe",
  );
  const prepared = await context.machine.prepareTransition(
    "legacy-active",
    "shadow-observe",
    evidence,
  );
  const committed = await context.machine.commitTransition(prepared.token);
  const events = await context.journal.readFrom(0);
  const coordinatorState = events.reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
  assert.equal(coordinatorState.migration.mode, "shadow-observe");
  assert.equal(
    coordinatorState.migration.lastTransition.status,
    "committed",
  );

  await context.journal.checkpoint(coordinatorState);
  const rotation = await context.journal.rotate();
  const checkpointOnlyRoot = await temporaryRoot(t);
  const checkpointOnlyPath = path.join(
    checkpointOnlyRoot,
    "journal",
    "segments",
    "segment-000001.jsonl",
  );
  await writeFile(
    checkpointOnlyPath,
    await readFile(rotation.activePath),
  );
  const checkpointJournal = await openJournal({
    rootDir: checkpointOnlyRoot,
  });
  const checkpointMachine = createMigrationStateMachine({
    journal: checkpointJournal,
    evidenceProvider: async () =>
      evidenceFor("shadow-observe", "cutover-prepared", 3),
  });
  const reconstructed =
    await checkpointMachine.readMigrationState();

  assert.equal(reconstructed.mode, "shadow-observe");
  assert.equal(reconstructed.pendingTransition, null);
  assert.equal(reconstructed.lastTransition.status, "committed");
  assert.equal(
    hashMigrationState(reconstructed),
    hashMigrationState(committed),
  );
});

test("migration Windows mutex self-test rejects a second caller", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-SelfTest",
      "-TimeoutMilliseconds",
      "500",
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"ownerAcquired"\s*:\s*true/i);
  assert.match(result.stdout, /"secondCallerRejected"\s*:\s*true/i);
  assert.match(
    result.stdout,
    /Global\\\\OperationPhoenixCoordinatorMigrationV1/i,
  );
});

test("migration wrapper requires bearer authentication without contacting an endpoint", async () => {
  const script = await readFile(MUTEX_SCRIPT, "utf8");
  assert.match(script, /Authorization/i);
  assert.match(script, /Bearer/i);
  const environment = { ...process.env };
  delete environment.CODEX_COORDINATOR_BEARER_TOKEN;
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "500",
    ],
    {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bearer|token/i);
});

test("migration wrapper allowlists output from an authenticated loopback response", async (t) => {
  const bearerToken = "migration-test-token-".padEnd(40, "x");
  let observedAuthorization = null;
  const server = createServer((request, response) => {
    observedAuthorization = request.headers.authorization;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      priorMode: "legacy-active",
      mode: "shadow-observe",
      evidenceHash: SHA_A,
      echoedAuthorization: observedAuthorization,
      untrustedExtra: { secret: bearerToken },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await spawnAndCollect(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-Uri",
      `http://127.0.0.1:${address.port}/v1/migration/transition`,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "5000",
    ],
    {
      env: {
        ...process.env,
        CODEX_COORDINATOR_BEARER_TOKEN: bearerToken,
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    observedAuthorization,
    `Bearer ${bearerToken}`,
  );
  assert.equal(result.stdout.includes(bearerToken), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    priorMode: "legacy-active",
    mode: "shadow-observe",
    evidenceHash: SHA_A,
  });
});

test("migration wrapper suppresses nested web diagnostics under Debug", async (t) => {
  const bearerToken = "migration-debug-token-".padEnd(40, "x");
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      priorMode: "legacy-active",
      mode: "shadow-observe",
      evidenceHash: SHA_A,
      echoedAuthorization: authorization,
      hostileDebugBody: bearerToken,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await spawnAndCollect(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-Debug",
      "-Verbose",
      "-Uri",
      `http://127.0.0.1:${address.port}/v1/migration/transition`,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "5000",
    ],
    {
      env: {
        ...process.env,
        CODEX_COORDINATOR_BEARER_TOKEN: bearerToken,
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  for (const output of [result.stdout, result.stderr]) {
    assert.equal(output.includes(bearerToken), false);
    assert.equal(output.includes("echoedAuthorization"), false);
    assert.equal(output.includes("hostileDebugBody"), false);
    assert.doesNotMatch(output, /Authorization:\s*Bearer/i);
  }
  assert.deepEqual(JSON.parse(result.stdout), {
    priorMode: "legacy-active",
    mode: "shadow-observe",
    evidenceHash: SHA_A,
  });
});

test("migration wrapper refuses redirects away from its validated loopback URI", async (t) => {
  const bearerToken = "migration-redirect-token-".padEnd(40, "x");
  let redirectedRequests = 0;
  const target = createServer((request, response) => {
    redirectedRequests += 1;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      priorMode: "legacy-active",
      mode: "shadow-observe",
      evidenceHash: SHA_A,
    }));
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const targetAddress = target.address();

  const redirector = createServer((request, response) => {
    request.resume();
    response.writeHead(307, {
      Location:
        `http://127.0.0.1:${targetAddress.port}/redirect-target`,
    });
    response.end();
  });
  await new Promise((resolve, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => redirector.close(resolve)));
  const redirectAddress = redirector.address();

  const result = await spawnAndCollect(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-Uri",
      `http://127.0.0.1:${redirectAddress.port}/redirect`,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "5000",
    ],
    {
      env: {
        ...process.env,
        CODEX_COORDINATOR_BEARER_TOKEN: bearerToken,
      },
    },
  );

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(redirectedRequests, 0);
});

test("migration wrapper suppresses authenticated error response bodies", async (t) => {
  const bearerToken = "migration-error-token-".padEnd(40, "x");
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    request.resume();
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: "hostile response",
      echoedAuthorization: authorization,
      nested: { secret: bearerToken },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await spawnAndCollect(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-Uri",
      `http://127.0.0.1:${address.port}/v1/migration/transition`,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "5000",
    ],
    {
      env: {
        ...process.env,
        CODEX_COORDINATOR_BEARER_TOKEN: bearerToken,
      },
    },
  );

  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes(bearerToken), false);
  assert.equal(result.stderr.includes(bearerToken), false);
  assert.match(result.stderr, /migration request failed/i);
});

test("migration wrapper rejects array-shaped success responses", async (t) => {
  const bearerToken = "migration-array-token-".padEnd(40, "x");
  const scalarResponse = {
    priorMode: "legacy-active",
    mode: "shadow-observe",
    evidenceHash: SHA_A,
  };
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/top-level-array") {
      response.end(JSON.stringify([
        scalarResponse,
        scalarResponse,
      ]));
      return;
    }
    response.end(JSON.stringify({
      priorMode: ["legacy-active", "legacy-active"],
      mode: ["shadow-observe", "shadow-observe"],
      evidenceHash: [SHA_A, SHA_A],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  for (const endpoint of [
    "array-fields",
    "top-level-array",
  ]) {
    const result = await spawnAndCollect(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        MUTEX_SCRIPT,
        "-Uri",
        `http://127.0.0.1:${address.port}/${endpoint}`,
        "-ExpectedMode",
        "legacy-active",
        "-NextMode",
        "shadow-observe",
        "-EvidenceHash",
        SHA_A,
        "-TimeoutMilliseconds",
        "5000",
      ],
      {
        env: {
          ...process.env,
          CODEX_COORDINATOR_BEARER_TOKEN: bearerToken,
        },
      },
    );

    assert.notEqual(result.code, 0, endpoint);
    assert.equal(result.stdout.trim(), "", endpoint);
    assert.equal(result.stderr.includes(bearerToken), false, endpoint);
    assert.match(result.stderr, /migration request failed/i, endpoint);
  }
});

test("migration wrapper requires canonical mode casing", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-ExpectedMode",
      "Legacy-Active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-TimeoutMilliseconds",
      "500",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_COORDINATOR_BEARER_TOKEN:
          "migration-canonical-token-".padEnd(40, "x"),
      },
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ExpectedMode is not a registered/i);
});

test("migration wrapper bounds bearer token files before reading", async (t) => {
  const containerDir = await mkdtemp(
    path.join(os.tmpdir(), "codex-migration-token-"),
  );
  t.after(() => rm(containerDir, { recursive: true, force: true }));
  const tokenPath = path.join(containerDir, "oversized-token.txt");
  await writeFile(tokenPath, "x".repeat(4_097), "utf8");
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      MUTEX_SCRIPT,
      "-ExpectedMode",
      "legacy-active",
      "-NextMode",
      "shadow-observe",
      "-EvidenceHash",
      SHA_A,
      "-BearerTokenFile",
      tokenPath,
      "-TimeoutMilliseconds",
      "500",
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /token file.*4096 bytes/i);
});
