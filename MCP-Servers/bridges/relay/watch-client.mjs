import { matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";
import { readScheduleGrant } from "./run-handoff.mjs";
import { reportJob } from "./completion-broker.mjs";
import { fileBinding, scheduleBinding } from "./schedule-watch.mjs";

export async function subscribeWatch(to, condition, identity, { root = installationRoot(), port } = {}) {
  if (!matches(UUID, to) || !matches(UUID, condition) || identity?.id !== to || identity.provider !== "codex") {
    return { ok: false, state: "denied" };
  }
  try {
    let grant, op;
    try {
      grant = readScheduleGrant(root, scheduleBinding(to, condition), to, condition);
      op = "activate_schedule";
    } catch {
      grant = readScheduleGrant(root, fileBinding(to, condition), to, condition);
      op = "activate_file";
    }
    await reportJob(grant, op, { session: to }, { port });
    return { ok: true, state: "subscribed", condition, target: to };
  } catch { return { ok: false, state: "unconfirmed" }; }
}
