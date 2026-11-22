import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installationRoot } from "../../MCP-Servers/bridges/relay/fleet.mjs";
import { migrateReceipts } from "../../MCP-Servers/bridges/relay/receipts.mjs";

// The installer owns schema changes. Receive only opens an existing store.
export async function migrateInstalledReceipts(root = installationRoot()) {
  const file = path.join(root, "receipts.sqlite");
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || path.relative(file, fs.realpathSync.native(file)) !== "") {
    throw new Error("Invalid receipt store");
  }
  await migrateReceipts(file);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("Usage: node Migrate-RelayReceipts.mjs");
    process.exitCode = 2;
  } else {
    try {
      await migrateInstalledReceipts();
      console.log("Installed receipt store is ready for bound remote effects.");
    } catch {
      console.error("Could not migrate the installed receipt store. Check the existing installation and setup account access.");
      process.exitCode = 1;
    }
  }
}
