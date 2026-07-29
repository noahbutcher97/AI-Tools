import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function observed(value, overrides = {}) {
  return {
    status: "observed",
    value,
    ...overrides,
  };
}

export async function runProviderOperation({
  operation,
  input,
  generationId,
}) {
  switch (operation) {
    case "success":
      if (input?.markerPath) {
        await appendFile(input.markerPath, "started\n", "utf8");
      }
      return observed({ echo: input?.value ?? null });

    case "exception":
      throw new Error("fixture exception");

    case "exit":
      process.exit(17);
      break;

    case "malformed-json":
      process.stdout.write("{fixture-malformed");
      return observed({ unreachable: true });

    case "malformed-result":
      return { status: "observed" };

    case "infinite-loop":
      while (true) {
        // Intentionally block only the isolated worker.
      }

    case "ignored-cancellation":
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
      break;

    case "oversized-stdout":
      process.stdout.write("x".repeat(input?.bytes ?? 32_768));
      return observed({ unreachable: true });

    case "oversized-stderr":
      process.stderr.write("e".repeat(input?.bytes ?? 32_768));
      return observed({ unreachable: true });

    case "combined-output":
      process.stdout.write("o".repeat(input?.stdoutBytes ?? 6_000));
      process.stderr.write("e".repeat(input?.stderrBytes ?? 6_000));
      return observed({ unreachable: true });

    case "wrong-generation":
      return observed(
        { echo: input?.value ?? null },
        { generationId: "wrong-generation" },
      );

    case "wrong-operation":
      return observed(
        { echo: input?.value ?? null },
        { operation: "different-operation" },
      );

    case "delayed-success":
      await delay(input?.delayMs ?? 75);
      return observed({ delayed: true });

    case "tracked-delay":
      await appendFile(input.markerPath, `start:${input.id}\n`, "utf8");
      await delay(input.delayMs);
      await appendFile(input.markerPath, `end:${input.id}\n`, "utf8");
      return observed({ id: input.id });

    case "child-process-spawn": {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        {
          detached: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      process.stderr.write(`CHILD_PID:${child.pid}\n`);
      await new Promise(() => {});
      break;
    }

    case "detached-child-success": {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.unref();
      return observed({ childPid: child.pid });
    }

    default:
      throw new Error(`unknown fixture operation: ${operation}`);
  }

  return observed({ unreachable: true, generationId });
}
