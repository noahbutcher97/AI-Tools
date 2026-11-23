import { isDeepStrictEqual } from "node:util";

const scopeFields = ["machine", "provider", "thread", "store", "writer"];

function ordinaryInputs(scope, row, receipt) {
  // finalized means the independent source accounted for *all* causes of
  // this terminal turn, including any steer or notice. A start ACK cannot
  // certify that by itself. Never accept origin labels from the sample.
  if (row.inputsComplete !== true || !Array.isArray(row.inputs) || !row.inputs.length ||
      !isDeepStrictEqual(receipt?.scope, scope) || receipt.turn !== row.turn_id ||
      receipt.finalized !== true || !Array.isArray(receipt.inputs) ||
      receipt.inputs.length !== row.inputs.length) return false;
  const observed = new Set(row.inputs);
  if (observed.size !== row.inputs.length) return false;
  for (const item of receipt.inputs) {
    if (item?.origin !== "ordinary" || typeof item.id !== "string" || !item.id ||
        !observed.delete(item.id)) return false;
  }
  return true;
}

// Qualification only. The caller supplies its independently authorized local
// readers, protected cursor fixture and candidate recorder. There is no send path.
export function createCandidateObserver(scope, { authorize, readSample, readFinalCauses, cursors, record }) {
  if (!scopeFields.every(key => typeof scope?.[key] === "string" && scope[key])) throw Error("Incomplete observation scope");
  scope = Object.freeze({ ...scope });
  const cursorKey = JSON.stringify(scopeFields.map(key => scope[key]));
  let continuous = false;
  return function poll() {
    const prior = cursors.get(cursorKey);
    const wasContinuous = continuous;
    continuous = false; // Disconnection, read failures and restart all require a fresh baseline.
    if (authorize(scope) !== true) return;
    const sample = readSample(scope);
    if (!isDeepStrictEqual(sample?.scope, scope) || !["busy", "idle"].includes(sample.writerState)) return;
    const row = sample.turn;
    if (typeof row?.turn_id !== "string" || !row.turn_id || !Number.isSafeInteger(row.rollout_ordinal) ||
        row.rollout_ordinal < 0 || !["inProgress", "completed"].includes(row.status)) return;
    const completed = row.status === "completed";
    if (completed !== (row.completed_at != null)) return;
    const current = { ordinal: row.rollout_ordinal, turn: row.turn_id, completed, writerState: sample.writerState };
    const sameTurn = prior?.turn === current.turn;
    if (prior) {
      const sameOrdinal = current.ordinal === prior.ordinal;
      if (current.ordinal < prior.ordinal || sameOrdinal !== sameTurn || (sameTurn && prior.completed && !completed)) return;
    }
    // The writer may report idle one poll after the indexed completion. Bind
    // the busy observation to this turn and discard it across observation gaps.
    const sawBusy = sameTurn && wasContinuous && prior.pendingIdle === true;
    current.pendingIdle = current.writerState === "busy" && (!completed || sawBusy);
    const ended = completed && wasContinuous && prior && (!sameTurn || !prior.completed);
    const becameIdle = completed && sawBusy && current.writerState === "idle";
    let eligible = false;
    if (ended || becameIdle) {
      if (authorize(scope) !== true) return;
      eligible = ordinaryInputs(scope, row, readFinalCauses(scope, row.turn_id));
      if (authorize(scope) !== true) return;
      if (!eligible) current.pendingIdle = false;
    }
    cursors.set(cursorKey, current);
    continuous = true;
    if (!eligible) return;
    if (ended) record("turn-completed");
    if (becameIdle && authorize(scope) === true) record("busy-to-idle");
  };
}
