import fs from "node:fs";
import path from "node:path";
import { exactKeys, HOST, matches } from "./delivery-protocol.mjs";
import { installationRoot, surveyRemoteSelection } from "./fleet.mjs";
import { createLocalAddresses } from "./local-address.mjs";
import { validAmbiguousAdapters, validLookupFrame, validLookupId } from "./lookup-protocol.mjs";
import { readEnabledReceivePolicy } from "./receive-policy.mjs";

function permitsLookup(dir, peer, id) {
  if (!readEnabledReceivePolicy(dir)) return false;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(dir, "lookup-policy.json"), "utf8"));
    return exactKeys(policy, ["v", "grants"]) && policy.v === 1 && Array.isArray(policy.grants) &&
      policy.grants.every(grant => exactKeys(grant, ["peer", "ids"]) && matches(HOST, grant.peer) &&
        Array.isArray(grant.ids) && grant.ids.every(validLookupId)) &&
      policy.grants.some(grant => grant.peer === peer && grant.ids.includes(id));
  } catch { return false; }
}

export function createRemoteLookup({ root = installationRoot,
  resolve = createLocalAddresses({ root, survey: surveyRemoteSelection }).resolve } = {}) {
  return async (request, peer) => {
    if (!validLookupFrame(request) || !matches(HOST, peer) || request.host === peer) return { state: "receive_denied" };
    try {
      const dir = root();
      if (!permitsLookup(dir, peer, request.id)) return { state: "receive_denied" };
      const selector = { host: request.host, id: request.id };
      if (Object.hasOwn(request, "adapter")) selector.adapter = request.adapter;
      const result = await resolve(selector);
      // Authorization can change while an installed reader is running. Even
      // a miss or collision discloses information about the surveyed ID.
      if (root() !== dir || !permitsLookup(dir, peer, request.id)) return { state: "receive_denied" };
      if (result?.ok === true && result.state === "resolved" && result.target?.host === request.host &&
          result.target.id === request.id && matches(HOST, result.target.adapter) &&
          (request.adapter === undefined || result.target.adapter === request.adapter)) {
        return { state: "resolved", target: { host: request.host, adapter: result.target.adapter, id: request.id } };
      }
      if (result?.ok === false && result.state === "ambiguous" && Object.hasOwn(result, "adapters")) {
        return validAmbiguousAdapters(result.adapters, request)
          ? { state: "ambiguous", adapters: [...result.adapters] } : { state: "unavailable" };
      }
      if (result?.ok === false && ["ambiguous", "incomplete_inventory", "missing", "unknown_adapter",
        "installation_changed"].includes(result.state)) return { state: result.state };
    } catch { /* Reader and installation diagnostics stay local. */ }
    return { state: "unavailable" };
  };
}

export const lookupInstalled = createRemoteLookup();
