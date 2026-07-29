import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_TYPES,
  MIGRATION_MODES,
  SCHEMA_VERSION,
  assertPeerId,
  loadCoordinatorConfig,
  validateEvent,
  validateMonitor,
  validateProviderResult,
} from "./contracts.mjs";

const workspaceRoot = "D:/UnrealProjects/5.6/OperationPhoenix";
const runtimeRoot =
  "C:/Users/posne/AppData/Local/CodexCoordinator/workspaces/operation-phoenix";

function asPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: "operation-phoenix",
    workspaceRoot,
    runtimeRoot,
    monitorProposalSource: "Local/Operations/Monitoring/combat-lane-watchdog",
    networkPolicy: "disabled",
    filesystemPolicy: "workspace",
    runtimeVersions: {
      node: "22.20.0",
      powershell: "7.6.3",
    },
    ...overrides,
  };
}

function validEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: "event-1",
    timestampUtc: "2026-07-28T00:00:00.000Z",
    source: "test",
    type: "runtime.started",
    payload: {},
    ...overrides,
  };
}

function validMonitor(overrides = {}) {
  return {
    monitorId: "lane-b-candidate",
    kind: "perforce-candidate",
    enabled: true,
    ownerPeerId: 0,
    reason: "Verify an explicitly admitted candidate.",
    activatedUtc: "2026-07-28T00:00:00.000Z",
    expiresUtc: "2026-07-29T00:00:00.000Z",
    expectedPaths: ["OnSight/Source/Example.cpp"],
    frozenHashes: {
      "OnSight/Source/Example.cpp":
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    evidencePolicy: "sha256",
    samplingTier: "scheduled",
    recursiveFileLimit: 2_000,
    version: 1,
    ...overrides,
  };
}

test("contract constants are frozen and carry the v1 migration modes", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(MIGRATION_MODES, [
    "legacy-active",
    "shadow-observe",
    "cutover-prepared",
    "unified-active",
    "rollback-prepared",
  ]);
  assert.equal(Object.isFrozen(MIGRATION_MODES), true);
  assert.equal(Object.isFrozen(EVENT_TYPES), true);
});

test("peer IDs are 0 through 100 integers", () => {
  assert.equal(assertPeerId(0), 0);
  assert.equal(assertPeerId(1), 1);
  assert.equal(assertPeerId(100), 100);
  for (const value of [-1, 101, "1", 1.5]) {
    assert.throws(() => assertPeerId(value), /peer/i);
  }
});

test("contract provider results accept only typed v1 statuses", () => {
  const values = [
    { status: "observed", value: { head: 3438 } },
    { status: "unavailable", diagnostic: "offline" },
    { status: "timed-out", diagnostic: "30 second limit" },
    { status: "invalid", diagnostic: "malformed result" },
  ];
  for (const value of values) {
    assert.deepEqual(asPlainJson(validateProviderResult(value)), value);
  }
  assert.throws(
    () => validateProviderResult({ status: "failed" }),
    /provider status/i,
  );
  assert.throws(
    () => validateProviderResult({ status: "observed" }),
    /value/i,
  );
  assert.throws(
    () => validateProviderResult({ status: "unavailable", extra: true }),
    /unknown/i,
  );
  assert.throws(
    () => validateProviderResult({ status: "observed", value: undefined }),
    /value|JSON/i,
  );
  assert.throws(
    () =>
      validateProviderResult({
        status: "observed",
        value: "x",
        byteLength: 262_145,
      }),
    /256|byte/i,
  );
  const original = { status: "observed", value: { head: 3438 } };
  const accepted = validateProviderResult(original);
  original.value.head = 9999;
  assert.equal(accepted.value.head, 3438);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.value), true);
});

test("contract event validation rejects unknown types and schema fields", () => {
  assert.deepEqual(asPlainJson(validateEvent(validEvent())), validEvent());
  assert.throws(
    () => validateEvent(validEvent({ type: "future.event" })),
    /event type/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ schemaVersion: 2 })),
    /schema/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ sequence: 0 })),
    /sequence/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ extra: true })),
    /unknown/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ eventId: "event-1\nforged" })),
    /event ID|control/i,
  );
  assert.throws(
    () =>
      validateEvent(
        validEvent({ timestampUtc: "2026-02-30T00:00:00.000Z" }),
      ),
    /timestamp|UTC/i,
  );
  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  assert.throws(
    () => validateEvent(validEvent({ payload: cyclicPayload })),
    /cyclic|JSON/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ payload: { invalid: Number.NaN } })),
    /finite|JSON/i,
  );
  assert.throws(
    () => validateEvent(validEvent({ payload: { invalid: new Map() } })),
    /plain|JSON/i,
  );
  const original = validEvent({ payload: { generationId: "g-1" } });
  const accepted = validateEvent(original);
  original.payload.generationId = "forged";
  assert.equal(accepted.payload.generationId, "g-1");
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.payload), true);
});

test("contract monitor validation enforces path, hash, and count bounds", () => {
  assert.deepEqual(asPlainJson(validateMonitor(validMonitor())), validMonitor());
  assert.throws(
    () => validateMonitor(validMonitor({ expectedPaths: ["../outside.txt"] })),
    /workspace|path/i,
  );
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({ expectedPaths: ["C:/Windows/System32/config"] }),
      ),
    /workspace|path/i,
  );
  for (const invalidPath of [
    "C:../outside.txt",
    "Local/file.txt:stream",
    "Local/\0invalid.txt",
    ".. /outside.txt",
    "Local/a.",
    "Local/a ",
    "Local/CON",
    "Local/AUX.txt",
    "Local/COM1.log",
  ]) {
    assert.throws(
      () => validateMonitor(validMonitor({ expectedPaths: [invalidPath] })),
      /workspace|path|drive|colon|control/i,
    );
  }
  assert.throws(
    () => validateMonitor(validMonitor({ expectedPaths: new Array(1) })),
    /sparse|path/i,
  );
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({
          frozenHashes: { "OnSight/Source/Example.cpp": "not-a-sha256" },
        }),
      ),
    /hash/i,
  );
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({
          expectedPaths: Array.from(
            { length: 101 },
            (_, index) => `Content/${index}.uasset`,
          ),
        }),
      ),
    /100|path/i,
  );
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({
          frozenHashes: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [
              `Content/${index}.uasset`,
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ]),
          ),
        }),
      ),
    /100|hash/i,
  );
  assert.throws(
    () => validateMonitor(validMonitor({ recursiveFileLimit: 2_001 })),
    /2,?000|recursive/i,
  );
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({
          frozenHashes: {
            "Local/a.txt":
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "Local\\a.txt":
              "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          },
        }),
      ),
    /duplicate|unique|hash path/i,
  );
  const original = validMonitor();
  const accepted = validateMonitor(original);
  original.expectedPaths[0] = "../outside.txt";
  assert.equal(accepted.expectedPaths[0], "OnSight/Source/Example.cpp");
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.expectedPaths), true);
});

test("contract monitor validation enforces expiry, policy, and version bounds", () => {
  assert.throws(
    () =>
      validateMonitor(
        validMonitor({
          expiresUtc: "2026-07-27T00:00:00.000Z",
        }),
      ),
    /expiry|expires/i,
  );
  assert.throws(
    () => validateMonitor(validMonitor({ evidencePolicy: "full-disk" })),
    /evidence policy/i,
  );
  assert.throws(
    () => validateMonitor(validMonitor({ samplingTier: "continuous" })),
    /sampling tier/i,
  );
  assert.throws(
    () => validateMonitor(validMonitor({ version: 2 })),
    /version/i,
  );
  const withoutExpiry = validMonitor();
  delete withoutExpiry.expiresUtc;
  assert.equal(validateMonitor(withoutExpiry).expiresUtc, undefined);
});

test("contract config loader rejects unknown keys and versions below floors", () => {
  const loaded = loadCoordinatorConfig(validConfig());
  assert.equal(loaded.workspaceId, "operation-phoenix");
  assert.throws(
    () => loadCoordinatorConfig(validConfig({ surprise: true })),
    /unknown/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({
          runtimeVersions: { node: "18.17.9", powershell: "7.6.3" },
        }),
      ),
    /node.*18\.18\.0/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({
          runtimeVersions: { node: "22.20.0", powershell: "7.3.9" },
        }),
      ),
    /powershell.*7\.4/i,
  );
  for (const node of ["18.18.0 trailing", "18.18.0-rc.1"]) {
    assert.throws(
      () =>
        loadCoordinatorConfig(
          validConfig({
            runtimeVersions: { node, powershell: "7.6.3" },
          }),
        ),
      /node.*version|semantic/i,
    );
  }
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({
          runtimeVersions: { node: "22.20.0", powershell: "7.4.0-rc.1" },
        }),
      ),
    /powershell.*version|semantic/i,
  );
});

test("contract config loader fails closed on workspace and runtime overlap", () => {
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({ runtimeRoot: `${workspaceRoot}/Local/Runtime` }),
      ),
    /overlap/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({
          workspaceRoot: "C:/",
          runtimeRoot: "C:/runtime",
        }),
      ),
    /overlap|drive root/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({
          workspaceRoot: "C:/workspace/",
          runtimeRoot: "C:/workspace/runtime",
        }),
      ),
    /overlap/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({ workspaceRoot: `${runtimeRoot}/workspace` }),
      ),
    /overlap/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({ runtimeRoot: "\\drive-relative-runtime" }),
      ),
    /absolute|drive|root/i,
  );
  assert.throws(
    () =>
      loadCoordinatorConfig(
        validConfig({ runtimeRoot: "\\\\server\\share\\runtime" }),
      ),
    /absolute|drive|network|root/i,
  );
  assert.throws(
    () => loadCoordinatorConfig(validConfig({ networkPolicy: "enabled" })),
    /network policy/i,
  );
  for (const invalidRoot of [
    "C:/",
    "C:/runtime:stream",
    "C:/runtime\0tail",
    "C:/workspace./runtime",
    "C:/workspace /runtime",
    "C:/NUL/runtime",
  ]) {
    assert.throws(
      () => loadCoordinatorConfig(validConfig({ runtimeRoot: invalidRoot })),
      /root|path|control|alias|segment|device/i,
    );
  }
});

test("contract optional properties cannot serialize away as undefined", () => {
  assert.throws(
    () => validateEvent(validEvent({ correlationId: undefined })),
    /correlation|undefined|string|JSON/i,
  );
  assert.throws(
    () =>
      validateProviderResult({
        status: "unavailable",
        diagnostic: undefined,
      }),
    /diagnostic|undefined|string|JSON/i,
  );
  assert.throws(
    () => validateMonitor(validMonitor({ graceSeconds: undefined })),
    /grace|undefined|integer|JSON/i,
  );
});

test("contract objects require own enumerable data properties only", () => {
  const hidden = validConfig();
  Object.defineProperty(hidden, "surprise", {
    value: true,
    enumerable: false,
  });
  assert.throws(() => loadCoordinatorConfig(hidden), /enumerable|unknown/i);

  const symbol = validEvent();
  symbol[Symbol("surprise")] = true;
  assert.throws(() => validateEvent(symbol), /symbol|unknown/i);

  const accessor = validConfig();
  Object.defineProperty(accessor, "workspaceId", {
    get() {
      return "operation-phoenix";
    },
    enumerable: true,
  });
  assert.throws(() => loadCoordinatorConfig(accessor), /data property|accessor/i);

  const inherited = validConfig();
  delete inherited.schemaVersion;
  Object.defineProperty(Object.prototype, "schemaVersion", {
    value: 1,
    configurable: true,
  });
  try {
    assert.throws(() => loadCoordinatorConfig(inherited), /own|schemaVersion/i);
  } finally {
    delete Object.prototype.schemaVersion;
  }
});

test("contract config returns a normalized immutable clone", () => {
  const original = validConfig({
    workspaceRoot: "D:\\UnrealProjects\\5.6\\OperationPhoenix\\",
  });
  const accepted = loadCoordinatorConfig(original);
  original.workspaceId = "forged";
  original.runtimeVersions.node = "0.0.0";
  assert.equal(accepted.workspaceId, "operation-phoenix");
  assert.equal(accepted.runtimeVersions.node, "22.20.0");
  assert.equal(
    accepted.workspaceRoot,
    "D:\\UnrealProjects\\5.6\\OperationPhoenix",
  );
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.runtimeVersions), true);
});

test("contract JSON bounds and immutable clones ignore inherited toJSON hooks", () => {
  const oversizedPayload = {
    content: "x".repeat(1024 * 1024),
  };
  Object.defineProperty(Object.prototype, "toJSON", {
    value() {
      return null;
    },
    configurable: true,
  });
  try {
    assert.throws(
      () => validateEvent(validEvent({ payload: oversizedPayload })),
      /byte|limit|exceeds/i,
    );
  } finally {
    delete Object.prototype.toJSON;
  }

  const accepted = validateEvent(
    validEvent({ payload: { nested: ["preserved"] } }),
  );
  assert.doesNotThrow(() => validateEvent(accepted));
  Object.defineProperty(Object.prototype, "toJSON", {
    value() {
      return null;
    },
    configurable: true,
  });
  try {
    assert.equal(
      JSON.stringify(accepted),
      '{"schemaVersion":1,"sequence":1,"eventId":"event-1","timestampUtc":"2026-07-28T00:00:00.000Z","source":"test","type":"runtime.started","payload":{"nested":["preserved"]}}',
    );
  } finally {
    delete Object.prototype.toJSON;
  }
});
