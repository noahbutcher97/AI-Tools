import { createHash } from "node:crypto";

import {
  SCHEMA_VERSION,
  canonicalJsonString,
} from "../contracts.mjs";
import {
  createMigrationUuid,
  hashMigrationEvidence,
  initialCoordinatorState,
  reduceCoordinatorEvent,
  requireAllowedMigrationTransition,
  validateMigrationEvidence,
} from "./reducer.mjs";

const rootMutationTails = new Map();

function rootKey(journal) {
  return journal.rootDir.toLowerCase();
}

async function withMigrationMutation(journal, operation) {
  const key = rootKey(journal);
  const prior = rootMutationTails.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  rootMutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (rootMutationTails.get(key) === current) {
      rootMutationTails.delete(key);
    }
  }
}

function requireUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    throw new TypeError(
      `${label} must be a canonical lower-case migration UUID`,
    );
  }
  return value;
}

function reduceCoordinatorEvents(events) {
  return events.reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
}

function foldMigrationEvents(events) {
  const coordinatorState = reduceCoordinatorEvents(events);
  return {
    schemaVersion: SCHEMA_VERSION,
    ...structuredClone(coordinatorState.migration),
  };
}

function validateCandidateEvent(events, candidate) {
  reduceCoordinatorEvent(reduceCoordinatorEvents(events), candidate);
  return candidate;
}

export function hashMigrationState(state) {
  return createHash("sha256")
    .update(
      canonicalJsonString(state, "migration state"),
      "utf8",
    )
    .digest("hex");
}

function assertControllerInputs(journal, evidenceProvider, boundaryHook) {
  if (
    journal === null ||
    typeof journal !== "object" ||
    typeof journal.rootDir !== "string" ||
    typeof journal.readFrom !== "function" ||
    typeof journal.append !== "function"
  ) {
    throw new TypeError("migration state machine requires a durable journal");
  }
  if (typeof evidenceProvider !== "function") {
    throw new TypeError("migration state machine requires an evidence provider");
  }
  if (typeof boundaryHook !== "function") {
    throw new TypeError("migration boundary hook must be a function");
  }
}

function createEvent(sequence, type, payload) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sequence,
    eventId: createMigrationUuid(sequence),
    timestampUtc: new Date().toISOString(),
    source: "core.migration",
    type,
    payload,
  };
}

async function appendWithRetry(journal, buildCandidate) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const events = await journal.readFrom(0);
    const candidate = await buildCandidate(events);
    try {
      await journal.append(candidate, { flush: true });
      return candidate;
    } catch (error) {
      if (
        !(error instanceof RangeError) ||
        !/journal sequence must be/i.test(error.message)
      ) {
        throw error;
      }
      const priorSequence = candidate.sequence - 1;
      const advanced = await journal.readFrom(priorSequence);
      if ((advanced.at(-1)?.sequence ?? priorSequence) <= priorSequence) {
        throw error;
      }
    }
  }
  throw new Error("migration journal contention did not settle");
}

export function createMigrationStateMachine({
  journal,
  evidenceProvider,
  boundaryHook = async () => {},
}) {
  assertControllerInputs(journal, evidenceProvider, boundaryHook);

  async function readMigrationState() {
    return structuredClone(
      foldMigrationEvents(await journal.readFrom(0)),
    );
  }

  async function prepareTransition(expectedMode, nextMode, evidence) {
    requireAllowedMigrationTransition(expectedMode, nextMode);
    const suppliedEvidence = validateMigrationEvidence(
      evidence,
      expectedMode,
      nextMode,
    );
    const suppliedHash = hashMigrationEvidence(suppliedEvidence);
    return withMigrationMutation(journal, async () => {
      const preparedEvent = await appendWithRetry(
        journal,
        async (events) => {
          const state = foldMigrationEvents(events);
          if (state.pendingTransition !== null) {
            throw new Error("a migration transition is already pending");
          }
          if (state.mode !== expectedMode) {
            throw new Error(
              `expected migration mode ${expectedMode} drifted to ${state.mode}`,
            );
          }
          const sequence = events.at(-1)?.sequence ?? 0;
          if (suppliedEvidence.journal.sequence !== sequence) {
            throw new Error(
              "migration journal input boundary drifted before prepare",
            );
          }
          const latestEvidence = validateMigrationEvidence(
            await evidenceProvider(),
            expectedMode,
            nextMode,
          );
          if (
            latestEvidence.journal.sequence !== sequence ||
            hashMigrationEvidence(latestEvidence) !== suppliedHash
          ) {
            throw new Error(
              "migration input boundary drifted before prepare",
            );
          }
          const transitionId = createMigrationUuid(sequence + 1);
          const token = createMigrationUuid(sequence + 1);
          const preparedUtc = new Date().toISOString();
          const candidate = createEvent(
            sequence + 1,
            "migration.transitionPrepared",
            {
              transitionId,
              token,
              priorMode: expectedMode,
              nextMode,
              evidence: suppliedEvidence,
              evidenceHash: suppliedHash,
              preparedUtc,
            },
          );
          await boundaryHook("migration.prepare.beforeAppend", {
            transitionId,
            token,
            sequence: candidate.sequence,
          });
          return validateCandidateEvent(events, candidate);
        },
      );
      const {
        transitionId,
        token,
      } = preparedEvent.payload;
      await boundaryHook("migration.prepare.afterAppend", {
        transitionId,
        token,
        eventId: preparedEvent.eventId,
        sequence: preparedEvent.sequence,
      });
      const state = await readMigrationState();
      if (state.pendingTransition?.token !== token) {
        throw new Error("prepared migration transition was not durably verified");
      }
      return structuredClone(state.pendingTransition);
    });
  }

  async function commitTransition(token) {
    requireUuid(token, "migration transition token");
    return withMigrationMutation(journal, async () => {
      const committedEvent = await appendWithRetry(
        journal,
        async (events) => {
          const state = foldMigrationEvents(events);
          const pending = state.pendingTransition;
          if (pending === null || pending.token !== token) {
            throw new Error("migration transition token is stale or not pending");
          }
          if (
            events.at(-1)?.eventId !== pending.preparedEventId
          ) {
            throw new Error(
              "migration boundary drifted after the prepared event",
            );
          }
          const currentEvidence = validateMigrationEvidence(
            await evidenceProvider(),
            pending.priorMode,
            pending.nextMode,
          );
          const currentSequence = events.at(-1)?.sequence ?? 0;
          if (currentEvidence.journal.sequence !== currentSequence) {
            throw new Error(
              "migration journal boundary drifted before commit",
            );
          }
          const normalizedEvidence = structuredClone(currentEvidence);
          normalizedEvidence.journal.sequence =
            pending.evidence.journal.sequence;
          if (
            hashMigrationEvidence(normalizedEvidence) !==
            pending.evidenceHash
          ) {
            throw new Error(
              "migration input boundary drifted before commit",
            );
          }
          const candidate = createEvent(
            currentSequence + 1,
            "migration.transitionCommitted",
            {
              transitionId: pending.transitionId,
              token: pending.token,
              preparedEventId: pending.preparedEventId,
              priorMode: pending.priorMode,
              nextMode: pending.nextMode,
              evidenceHash: pending.evidenceHash,
            },
          );
          await boundaryHook("migration.commit.beforeAppend", {
            transitionId: pending.transitionId,
            token,
            sequence: candidate.sequence,
          });
          return validateCandidateEvent(events, candidate);
        },
      );
      await boundaryHook("migration.commit.afterAppend", {
        token,
        eventId: committedEvent.eventId,
        sequence: committedEvent.sequence,
      });
      const state = await readMigrationState();
      if (
        state.pendingTransition !== null ||
        state.lastTransition?.token !== token ||
        state.lastTransition.status !== "committed"
      ) {
        throw new Error("committed migration transition was not durably verified");
      }
      return state;
    });
  }

  async function abortTransition(token, reason) {
    requireUuid(token, "migration transition token");
    if (
      typeof reason !== "string" ||
      reason.length < 1 ||
      reason.length > 2_000
    ) {
      throw new TypeError("migration abort reason is invalid");
    }
    return withMigrationMutation(journal, async () => {
      const abortedEvent = await appendWithRetry(
        journal,
        async (events) => {
          const state = foldMigrationEvents(events);
          const pending = state.pendingTransition;
          if (pending === null || pending.token !== token) {
            throw new Error("migration transition token is stale or not pending");
          }
          const candidate = createEvent(
            (events.at(-1)?.sequence ?? 0) + 1,
            "migration.transitionAborted",
            {
              transitionId: pending.transitionId,
              token: pending.token,
              preparedEventId: pending.preparedEventId,
              priorMode: pending.priorMode,
              nextMode: pending.nextMode,
              evidenceHash: pending.evidenceHash,
              reason,
            },
          );
          await boundaryHook("migration.abort.beforeAppend", {
            transitionId: pending.transitionId,
            token,
            sequence: candidate.sequence,
          });
          return validateCandidateEvent(events, candidate);
        },
      );
      await boundaryHook("migration.abort.afterAppend", {
        token,
        eventId: abortedEvent.eventId,
        sequence: abortedEvent.sequence,
      });
      const state = await readMigrationState();
      if (
        state.pendingTransition !== null ||
        state.lastTransition?.token !== token ||
        state.lastTransition.status !== "aborted"
      ) {
        throw new Error("aborted migration transition was not durably verified");
      }
      return state;
    });
  }

  return Object.freeze({
    readMigrationState,
    prepareTransition,
    commitTransition,
    abortTransition,
  });
}
