import { matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";
import { readScheduleGrant } from "./run-handoff.mjs";
import { reportJob } from "./completion-broker.mjs";
import { branchBinding, fileBinding, scheduleBinding } from "./schedule-watch.mjs";

export async function subscribeWatch(to, condition, identity, { root = installationRoot(), port } = {}) {
  if (!matches(UUID, to) || !matches(UUID, condition) || identity?.id !== to || identity.provider !== "codex") {
    return { ok: false, state: "denied",
      detail: "Activate the watch from the intended Codex thread, using its shell or its relay_watch MCP tool." };
  }
  try {
    const bindings = [[scheduleBinding, "activate_schedule"], [fileBinding, "activate_file"], [branchBinding, "activate_branch"]];
    for (const [binding, op] of bindings) {
      let grant;
      try { grant = readScheduleGrant(root, binding(to, condition), to, condition); }
      catch { continue; }
      await reportJob(grant, op, { session: to }, { port });
      return { ok: true, state: "subscribed", condition, target: to };
    }
  } catch { /* An uncertain acknowledgement cannot authorize another activation. */ }
  return { ok: false, state: "unconfirmed" };
}
