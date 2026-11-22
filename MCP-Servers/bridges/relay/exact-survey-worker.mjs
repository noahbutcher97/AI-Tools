import { parentPort, workerData } from "node:worker_threads";
import { createLocalInventory } from "./client.mjs";
import { installedReaders } from "./installed-readers.mjs";

// Only the full receiver opens this worker. Watcher-only bundles also use
// fleet.mjs, but have no inventory reader registry.
if (parentPort) {
  const installed = createLocalInventory(installedReaders, workerData.enabled);
  parentPort.postMessage(await installed.resolve(workerData.selector, workerData.options));
}
