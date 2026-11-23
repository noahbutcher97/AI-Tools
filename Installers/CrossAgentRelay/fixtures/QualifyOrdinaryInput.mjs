import { randomUUID } from "node:crypto";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readTrialTurns } from "./ReadTurnMetadata.mjs";

// The controller owns one new thread and supplies one ordinary input. Retain
// correlation fields only. The provider's echo does not certify every cause.
export async function qualifyOrdinaryInput(thread, call, listen, readTurns = readTrialTurns) {
  const clientId = randomUUID();
  let input, conflict = false, completedTurn;
  let writerState = "unknown", sawBusy = false, sawFollowingIdle = false, interrupted = false;
  listen((method, params) => {
    if (params?.threadId !== thread) return;
    if (method === "thread/status/changed") {
      writerState = params.status?.type;
      if (writerState === "active") sawBusy = true;
      else if (writerState === "idle" && sawBusy) sawFollowingIdle = true;
      else if (sawBusy) interrupted = true;
    }
    if (method === "turn/completed" && params.turn?.status === "completed") completedTurn = params.turn.id;
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "userMessage") {
      const current = { turn: params.turnId, id: params.item.id, echoed: params.item.clientId === clientId };
      if (params.item.clientId != null && !current.echoed) conflict = true;
      if (input && (input.turn !== current.turn || input.id !== current.id)) conflict = true;
      if (!input || current.echoed) input = current;
    }
  });
  try {
    const started = await call("turn/start", { threadId: thread, clientUserMessageId: clientId,
      input: [{ type: "text", text: "Reply only OK.", text_elements: [] }] });
    const turn = started.turn.id;
    let indexedBusy = false, exactFinalInput = false, indexedComplete = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const rows = readTurns(thread, os.homedir());
      if (rows.length > 1 || (rows.length === 1 && rows[0].turn_id !== turn)) {
        conflict = true;
        break;
      }
      const row = rows[0];
      if (row?.status === "inProgress" && writerState === "active") indexedBusy = true;
      indexedComplete = row?.status === "completed" && row.completed_at != null;
      if (indexedComplete && completedTurn === turn && writerState === "idle") {
        exactFinalInput = Boolean(input?.echoed && input.turn === turn && row.inputsComplete &&
          row.inputs.length === 1 && row.inputs[0] === input.id);
        break;
      }
      await delay(100);
    }
    return { clientIdEchoed: input?.echoed === true, indexedBusy, sawFollowingIdle,
      indexedComplete, exactFinalInput, conflict, interrupted,
      confirmed: exactFinalInput && indexedBusy && sawFollowingIdle && !interrupted && !conflict };
  } finally { listen(undefined); }
}
