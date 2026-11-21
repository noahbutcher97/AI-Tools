import fs from "node:fs";
import path from "node:path";
import { createLocalInventory } from "./client.mjs";
import { exactKeys, HOST, matches } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";

function readOptional(root, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

const resolutionDetails = {
  resolved: "Exact local match. This lookup did not send a notice.",
  invalid_selector: "Use the literal session ID and, if needed, its adapter and local host label.",
  unknown_adapter: "This local reader is not enabled. Check the adapter keys in list --json.",
  missing: "No exact local match. Check the raw ID and its case in list --scope all --json.",
  incomplete_inventory: "Local inventory is incomplete. Check reader coverage or specify the known adapter.",
  ambiguous: "Multiple sessions match. In list --scope all --json, the row's kind is its adapter key. Select it if the matches use different adapters.",
  host_unavailable: "The local machine label is unavailable. Check machine enrollment.",
  nonlocal_host: "This lookup runs locally. Run it on the named machine.",
  inventory_unavailable: "Local inventory configuration is unavailable. Check the installed reader settings.",
};

// Only installation code supplies readers and the configuration root. Both
// public faces re-read the enabled set for each request.
export function createLocalAddresses({ root = installationRoot, additionalAdapters = [] } = {}) {
  function readers(dir) {
    const config = readOptional(dir, "inventory-adapters.json");
    if (config === undefined) return createLocalInventory(additionalAdapters);
    if (!exactKeys(config, ["enabled"]) || !Array.isArray(config.enabled)) {
      throw new Error("invalid inventory configuration");
    }
    return createLocalInventory(additionalAdapters, config.enabled);
  }

  async function list(options) {
    let inventory;
    try {
      inventory = readers(root());
    } catch {
      return { complete: false, inventory: [], targets: [], warnings: ["Local inventory configuration unavailable."] };
    }
    return inventory(options);
  }

  async function lookup(selector) {
    if (!selector || typeof selector !== "object" || !Object.hasOwn(selector, "id") ||
        Object.keys(selector).some(key => !["host", "id", "adapter"].includes(key))) {
      return { ok: false, state: "invalid_selector" };
    }
    const { id } = selector;
    const host = Object.hasOwn(selector, "host") ? selector.host : undefined;
    const adapter = Object.hasOwn(selector, "adapter") ? selector.adapter : undefined;
    if (host !== undefined && !matches(HOST, host)) return { ok: false, state: "invalid_selector" };
    let dir;
    let localHost;
    try {
      dir = root();
      // Local-only use also works before fleet enrollment. An invalid machine
      // record must never supply the identity in a resolved address.
      const machine = readOptional(dir, "machine.json");
      if (machine !== undefined && (!exactKeys(machine, ["host"]) || !matches(HOST, machine.host))) {
        return { ok: false, state: "host_unavailable" };
      }
      localHost = machine?.host ?? null;
    } catch {
      return { ok: false, state: "host_unavailable" };
    }
    if (host !== undefined && !localHost) return { ok: false, state: "host_unavailable" };
    if (host !== undefined && localHost !== host) return { ok: false, state: "nonlocal_host" };
    let inventory;
    try {
      inventory = readers(dir);
    } catch {
      return { ok: false, state: "inventory_unavailable" };
    }
    const result = await inventory.resolve({ id, adapter });
    if (!result.ok) return result;
    return { ...result, target: { ...result.target, host: localHost } };
  }

  async function resolve(selector) {
    const result = await lookup(selector);
    return { ...result, detail: resolutionDetails[result.state] };
  }

  return { list, resolve };
}

const local = createLocalAddresses();
export const listInstalledTargets = local.list;
export const resolveLocalAddress = local.resolve;
