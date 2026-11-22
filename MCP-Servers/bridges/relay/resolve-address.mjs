import { randomUUID } from "node:crypto";
import { INVENTORY_SURVEY_MS, loadDirectory, requestHost } from "./fleet.mjs";
import { resolveLocalAddress } from "./local-address.mjs";
import { validLookupFrame, validLookupReply } from "./lookup-protocol.mjs";

const details = {
  resolved: "The named host found one exact match.",
  invalid_selector: "Check the literal ID, adapter key and canonical host label.",
  directory_unavailable: "The enrolled host directory is unavailable. Check the local relay setup.",
  unknown_host: "Check the enrolled host labels with relay list --all-hosts --json.",
  installation_changed: "Machine or reader settings changed. Run the lookup again.",
  ambiguous: "Multiple sessions match on that host. Repeat the lookup with --adapter KEY on the CLI or the adapter field in relay_resolve. Use the reader key for the intended client. If both entries share a reader, check them on that host.",
  incomplete_inventory: "An applicable reader could not finish. Specify the known adapter or check its inventory on the named host.",
  missing: "No exact match on that host. Check the raw ID and its case.",
  unknown_adapter: "The named host has no enabled reader with that adapter key. Check the row's kind on that host.",
  receive_denied: "The receiver refused this lookup. Ask the host owner to check that remote receive is enabled and that your machine has lookup permission for this exact ID.",
  unavailable: "The remote lookup is unavailable. Check the named host's reader settings and retry.",
  lookup_refused: "The receiver rejected the lookup frame. It may use an older relay. Run relay resolve locally on the named host or check that its receiver supports version 3 lookup.",
  offline: "The host is unreachable. Check its network connection and enrolled endpoint before retrying.",
  timeout: "The remote lookup timed out. Check host reachability and retry.",
  authentication_failed: "The host refused the relay credential. Check enrollment with the host owner.",
  host_key_error: "The host key did not match its enrolled pin. Verify the host identity with the owner.",
  ssh_unavailable: "The local SSH client is unavailable. Check the relay installation.",
  receive_failed: "The receiver did not complete this lookup. Check the receiver on the named host.",
  invalid_response: "The receiver returned an invalid lookup reply. Check the receiver version and host enrollment.",
};

function refused(state) {
  return { ok: false, state, detail: details[state] };
}

export async function resolveAddress(selector) {
  const local = await resolveLocalAddress(selector);
  if (local.state !== "nonlocal_host") return local;

  const { host, id, adapter } = selector;
  const request = { v: 3, op: "lookup", requestId: randomUUID(), host, id };
  if (adapter !== undefined) request.adapter = adapter;
  if (!validLookupFrame(request)) return refused("invalid_selector");

  let directory;
  try { directory = loadDirectory(); }
  catch { return refused("directory_unavailable"); }
  if (directory.local === host) return refused("installation_changed");
  const entry = directory.hosts.find(row => row.host === host);
  if (!entry) return refused("unknown_host");

  let response;
  // A single exact survey can use its full deadline after SSH startup.
  try { response = await requestHost(entry, request, 5000 + INVENTORY_SURVEY_MS); }
  catch { return refused("receive_failed"); }
  if (response.error) return refused(response.error);
  const { reply } = response;
  if (!validLookupReply(reply, request, directory.local)) return refused("invalid_response");
  if (reply.state !== "resolved") return refused(reply.state);
  return { ok: true, state: "resolved", target: reply.target, detail: details.resolved };
}
