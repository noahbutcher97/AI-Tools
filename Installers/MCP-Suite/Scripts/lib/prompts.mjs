// prompts.mjs
// Lightweight TTY prompts (no external deps). Used by the installer when
// running headless (e.g., from a CCD slash command). When the GUI front-end
// (install.ps1) drives the install, it gathers the workspace path via a
// Windows folder picker and passes it as a flag — these prompts handle the
// rest of the credential flow uniformly.
//
// To debug unrecognized key sequences set MCP_DEBUG_KEYS=1 before running
// the installer. The hex bytes of any unhandled key will be printed.

import readline from "readline";
import { spawn } from "child_process";

const ESC = ""; // 0x1B — start of ANSI escape sequences
const CTRL_C = ""; // 0x03

// ───────────────────────────────────────────────────────────────────────
// Plain-text prompt (visible echo)
// ───────────────────────────────────────────────────────────────────────

export function ask(message, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const suffix =
      defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    rl.question(`${message}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = (answer || "").trim();
      resolve(trimmed === "" && defaultValue !== undefined ? defaultValue : trimmed);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Hidden-echo prompt
// ───────────────────────────────────────────────────────────────────────

export function askSecret(message) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      rl.question(`${message}: `, (answer) => {
        rl.close();
        resolve((answer || "").trim());
      });
      return;
    }

    let buffer = "";
    stdout.write(`${message}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      const c = chunk.toString("utf8");

      if (c === CTRL_C) {
        cleanup();
        stdout.write("\n");
        reject(new Error("Cancelled by user (Ctrl-C)"));
        return;
      }
      if (c === "\r" || c === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(buffer);
        return;
      }
      if (c === "\b" || c === "\x7f") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }
      // Ignore other control sequences (arrow keys, etc.)
      if (c.charCodeAt(0) < 0x20) return;

      buffer += c;
      stdout.write("*".repeat(c.length));
    };

    stdin.on("data", onData);
  });
}

// ───────────────────────────────────────────────────────────────────────
// Y/N confirmation
// ───────────────────────────────────────────────────────────────────────

export async function confirm(message, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const ans = ((await ask(`${message}${suffix}`, "")) || "").toLowerCase();
  if (ans === "") return defaultYes;
  return ans.startsWith("y");
}

// ───────────────────────────────────────────────────────────────────────
// Multi-select with arrow-key navigation
// ───────────────────────────────────────────────────────────────────────

// Key matchers — handle multiple terminal forms:
//   VT100:        ESC [ A   (most modern terminals)
//   DEC SS3:      ESC O A   (some BSD/Mac terminals, screen)
//   Modifier:     ESC [ 1;5 A   (with Ctrl/Shift; we ignore the modifier)
//   Win scancode: 0x00 + H/P/I/Q  (some Windows console modes when VT is off)
//   Win special:  0xE0 + H/P     (extended-key prefix in some scancode modes)
const RE_UP    = new RegExp(`^(${ESC}\\[(\\d+(;\\d+)*)?A|${ESC}OA|\\u0000H|\\u00e0H)$`);
const RE_DOWN  = new RegExp(`^(${ESC}\\[(\\d+(;\\d+)*)?B|${ESC}OB|\\u0000P|\\u00e0P)$`);
const RE_HOME  = new RegExp(`^(${ESC}\\[(\\d+(;\\d+)*)?H|${ESC}OH|${ESC}\\[[17]~|\\u0000G|\\u00e0G)$`);
const RE_END   = new RegExp(`^(${ESC}\\[(\\d+(;\\d+)*)?F|${ESC}OF|${ESC}\\[[48]~|\\u0000O|\\u00e0O)$`);
const RE_PGUP  = new RegExp(`^(${ESC}\\[5~|\\u0000I|\\u00e0I)$`);
const RE_PGDN  = new RegExp(`^(${ESC}\\[6~|\\u0000Q|\\u00e0Q)$`);

export async function multiSelect(message, items) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const canRawMode = stdin.isTTY && typeof stdin.setRawMode === "function";
  if (!canRawMode) return multiSelectFallback(message, items);

  return new Promise((resolve, reject) => {
    const state = items.map((it) => ({ ...it, checked: !!it.checked }));
    const CONTINUE_INDEX = state.length;
    const TOTAL_ITEMS = state.length + 1;
    const HEADER_LINES = 2; // message + hint
    let cursor = 0;
    let lastLineCount = 0;

    const redraw = () => {
      let out = "";
      if (lastLineCount > 0) out += `${ESC}[${lastLineCount}A`;
      out += `${ESC}[2K${message}\n`;
      out += `${ESC}[2K${ESC}[2m(arrows or j/k to move; Space to toggle; Enter on Continue to proceed; Ctrl-C to cancel)${ESC}[0m\n`;
      state.forEach((it, idx) => {
        const cur  = idx === cursor ? `${ESC}[36m>${ESC}[0m` : " ";
        const mark = it.checked ? `${ESC}[32m[x]${ESC}[0m` : "[ ]";
        const desc = it.description ? `  ${ESC}[2m-- ${it.description}${ESC}[0m` : "";
        out += `${ESC}[2K${cur} ${mark} ${it.name}${desc}\n`;
      });
      const sel = cursor === CONTINUE_INDEX;
      const arrow = sel ? `${ESC}[36m>${ESC}[0m` : " ";
      const label = sel ? `${ESC}[1;36m>> Continue with selected <<${ESC}[0m` : ">> Continue with selected <<";
      out += `${ESC}[2K${arrow}     ${label}\n`;
      stdout.write(out);
      lastLineCount = HEADER_LINES + TOTAL_ITEMS;
    };

    const cleanup = () => {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      const key = chunk.toString("utf8");

      if (key === CTRL_C) {
        cleanup();
        stdout.write("\n");
        reject(new Error("Cancelled by user (Ctrl-C)"));
        return;
      }
      if (key === "k" || RE_UP.test(key)) {
        cursor = (cursor - 1 + TOTAL_ITEMS) % TOTAL_ITEMS;
        redraw();
        return;
      }
      if (key === "j" || RE_DOWN.test(key)) {
        cursor = (cursor + 1) % TOTAL_ITEMS;
        redraw();
        return;
      }
      if (RE_HOME.test(key) || RE_PGUP.test(key)) {
        cursor = 0;
        redraw();
        return;
      }
      if (RE_END.test(key) || RE_PGDN.test(key)) {
        cursor = TOTAL_ITEMS - 1;
        redraw();
        return;
      }
      if (key === " ") {
        if (cursor < state.length) {
          state[cursor].checked = !state[cursor].checked;
          redraw();
        }
        return;
      }
      if (key === "\r" || key === "\n") {
        if (cursor === CONTINUE_INDEX) {
          cleanup();
          stdout.write("\n");
          resolve(state.filter((it) => it.checked).map((it) => it.name));
        } else {
          state[cursor].checked = !state[cursor].checked;
          redraw();
        }
        return;
      }

      // Optional debug: see what bytes any unhandled key produces
      if (process.env.MCP_DEBUG_KEYS) {
        const hex = Buffer.from(key, "utf8").toString("hex");
        process.stderr.write(`\n[debug] unhandled key: hex=${hex} raw=${JSON.stringify(key)}\n`);
        redraw();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    redraw();
  });
}

async function multiSelectFallback(message, items) {
  const state = items.map((it) => ({ ...it, checked: !!it.checked }));
  for (;;) {
    console.log(`\n${message}`);
    state.forEach((it, idx) => {
      const mark = it.checked ? "x" : " ";
      const desc = it.description ? `  -- ${it.description}` : "";
      console.log(`  ${idx + 1}. [${mark}] ${it.name}${desc}`);
    });
    const ans = (await ask("Toggle by number(s) e.g. '1,3', empty to continue", "")).trim();
    if (ans === "") break;
    const nums = ans.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    for (const n of nums) {
      const idx = n - 1;
      if (idx >= 0 && idx < state.length) state[idx].checked = !state[idx].checked;
    }
  }
  return state.filter((it) => it.checked).map((it) => it.name);
}

// ───────────────────────────────────────────────────────────────────────
// Browser opener
// ───────────────────────────────────────────────────────────────────────

export function openInBrowser(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      console.error(`Refusing to open non-http URL: ${url}`);
      return false;
    }
  } catch {
    console.error(`Invalid URL: ${url}`);
    return false;
  }

  let cmd, args;
  if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    // shell:false is the default; args are array-passed.
    // nosemgrep: javascript.lang.security.audit.detect-child-process.detect-child-process
    spawn(cmd, args, { detached: true, stdio: "ignore", shell: false }).unref();
    return true;
  } catch (e) {
    console.error(`Could not open browser: ${e.message}`);
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Pretty section helpers (used by install.mjs for consistent UI)
// ───────────────────────────────────────────────────────────────────────

export function printSection(title) {
  console.log(`\n${ESC}[1;36m${title}${ESC}[0m`);
}
export function printStep(title) {
  console.log(`\n  ${ESC}[1m${title}${ESC}[0m`);
}
export function printInfo(message) {
  console.log(`  ${ESC}[2m${message}${ESC}[0m`);
}
export function printOk(message) {
  console.log(`  ${ESC}[32mOK:${ESC}[0m ${message}`);
}
export function printErr(message) {
  console.log(`  ${ESC}[31mERR:${ESC}[0m ${message}`);
}
export function printWarn(message) {
  console.log(`  ${ESC}[33mWARN:${ESC}[0m ${message}`);
}
