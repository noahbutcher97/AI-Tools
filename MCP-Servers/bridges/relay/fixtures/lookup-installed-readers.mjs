// Copied into a disposable relay distribution as its static reader registry.
import fs from "node:fs";
import { isMainThread } from "node:worker_threads";

export const installedReaders = [{
  kind: "sample",
  enumerate() {
    fs.appendFileSync(new URL("./reader-calls.jsonl", import.meta.url),
      JSON.stringify({ worker: !isMainThread, operation: "enumerate" }) + "\n");
    return { complete: true, targets: [{ id: "Sample:Chat/One" }] };
  },
}];
