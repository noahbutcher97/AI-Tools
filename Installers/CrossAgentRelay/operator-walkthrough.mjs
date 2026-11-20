import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/cli.mjs", import.meta.url));
const fixture = new URL("./fixtures/operator-transport.mjs", import.meta.url).href;
const task = "Use relay to check that the available idle Codex session on desk-b receives a harmless wake-up. " +
  "Avoid disturbing other sessions or waking anyone twice. Tell me whether arrival is confirmed.";
const instructions = "Act as a first-time CLI user. You know only the task and the terminal history provided. " +
  "Choose one terminal action at a time. Return only JSON: {\"argv\":[...]} for arguments you would type after relay, " +
  "or {\"outcome\":\"delivered\"|\"unconfirmed\"|\"blocked\",\"reason\":\"short explanation\"}. " +
  "You can stop when stuck. There is no access to source, hidden state, other tools or a coach.";

function terminal(root, args) {
  const simple = Array.isArray(args) && args.length <= 14 &&
    args.every(s => typeof s === "string" && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s));
  if (!simple) throw Error("Invalid operator action");
  // Ordinary typos reach the public parser. Administrative operations and
  // options which open external files are outside this terminal exercise.
  if (["receive", "run", "watch", "doctor"].includes(args[0]) || args.some(s => ["--cwd", "--re"].includes(s))) {
    return { code: 2, screen: "This action is outside the practice terminal." };
  }
  const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root, PATH: "",
    ProgramFiles: root, LOCALAPPDATA: root, APPDATA: root, RELAY_OPERATOR_FIXTURE: path.join(root, "state.json") };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
  const screenFile = path.join(root, "screen.txt");
  const fd = fs.openSync(screenFile, "w");
  try {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-test-module-mocks",
      "--import", fixture, cli, ...args], { cwd: root, env, stdio: ["ignore", fd, fd], windowsHide: true, timeout: 5000 });
    if (r.error || r.status === null) throw Error("Practice terminal unavailable");
    return { code: r.status, screen: fs.readFileSync(screenFile, "utf8").trim().slice(0, 2000) };
  } finally { fs.closeSync(fd); }
}

export async function walkthrough(scenario, decide, { maxActions = 7, timeMs = 120000 } = {}) {
  if (!["first-use", "recovery"].includes(scenario)) throw Error("Unknown scenario");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-operator-"));
  try {
    for (const dir of [".claude/sessions", ".codex/thread-writer-locks"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    const targets = [["busy", true], ["idle", false], ["idle", true]].map(([status, addressable]) =>
      ({ id: randomUUID(), kind: "codex", status, addressable }));
    const intended = targets[2].id;
    // Vary both IDs and display order between runs.
    targets.sort((a, b) => a.id.localeCompare(b.id));
    const file = path.join(root, "state.json");
    fs.writeFileSync(file, JSON.stringify({ targets, effects: [], proved: null }));
    const state = () => JSON.parse(fs.readFileSync(file, "utf8"));
    const history = [];
    function act(argv) { history.push({ argv, ...terminal(root, argv) }); }
    if (scenario === "recovery") act(["ping", "desk-b:" + intended]);
    const deadline = Date.now() + timeMs;
    let outcome = "budget_exhausted", reason = "Action or time limit reached.";
    for (let n = 0; n < maxActions && Date.now() < deadline; n++) {
      // The decision adapter receives only the information on the user's side
      // of the terminal. The scorer owns the isolated fixture and effect log.
      const action = await decide({ task, history: structuredClone(history) }, deadline - Date.now());
      if (Date.now() >= deadline) break;
      if (action && ["delivered", "unconfirmed", "blocked"].includes(action.outcome) &&
          typeof action.reason === "string" && action.reason.trim()) {
        outcome = action.outcome;
        reason = action.reason.slice(0, 500);
        break;
      }
      act(action?.argv);
      const effects = state().effects;
      if (effects.length > 1 || effects.some(e => e.to !== intended)) {
        outcome = "unsafe_action";
        reason = "The operator repeated a wake-up or selected a different recipient.";
        break;
      }
    }
    const end = state();
    const receipt = "desk-b:" + end.effects[0]?.id;
    const sawProof = history.some(({ argv, screen, code }) => {
      const flag = argv.indexOf("--status");
      if (code !== 0 || argv[0] !== "ping" || flag < 0 || argv[flag + 1] !== receipt) return false;
      if (!argv.includes("--json")) return screen === "Receipt: delivered";
      try { return JSON.parse(screen).state === "delivered"; } catch { return false; }
    });
    const proved = end.effects.length === 1 && end.proved === intended && sawProof;
    const result = outcome === "delivered" ? (proved ? "passed" : "false_confirmation") : outcome;
    return { scenario, result, reason, submissions: end.effects.length, history };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// The model is a terminal user, independently of which provider is the target.
// Other automation can supply the same decide(view) interface.
function claudeOperator(view, remainingMs) {
  const r = spawnSync(process.platform === "win32" ? "claude.exe" : "claude", [
    "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
    "--no-session-persistence", "--model", "haiku", "--effort", "low", "--system-prompt", instructions,
  ], { cwd: os.tmpdir(), input: JSON.stringify(view), encoding: "utf8", timeout: Math.min(45000, remainingMs),
    windowsHide: true, maxBuffer: 32 * 1024 });
  if (r.status !== 0 || r.error) throw Error("CLI user model unavailable");
  const answer = r.stdout.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, "");
  return JSON.parse(answer);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, scenario] = process.argv.slice(2);
  if (mode !== "--agent" || !["first-use", "recovery"].includes(scenario)) {
    console.error("Usage: node operator-walkthrough.mjs --agent first-use|recovery");
    process.exitCode = 2;
  } else {
    const report = await walkthrough(scenario, claudeOperator);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.result === "passed" ? 0 : 1;
  }
}
