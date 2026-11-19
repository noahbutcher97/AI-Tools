import { matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";
import { readScheduleGrant } from "./run-handoff.mjs";
import { reportJob } from "./completion-broker.mjs";
import { scheduleBinding } from "./schedule-watch.mjs";

export async function subscribeWatch(to, condition, identity, { root = installationRoot(), port } = {}) {
  if (!matches(UUID, to) || !matches(UUID, condition) || identity?.id !== to || identity.provider !== "codex") {
    return { ok: false, state: "denied" };
  }
  try {
    const grant = readScheduleGrant(root, scheduleBinding(to, condition), to, condition);
    await reportJob(grant, "activate_schedule", { session: to }, { port });
    return { ok: true, state: "subscribed", condition, target: to };
  } catch { return { ok: false, state: "unconfirmed" }; }
}
