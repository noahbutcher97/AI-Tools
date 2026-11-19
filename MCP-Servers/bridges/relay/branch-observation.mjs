import path from "node:path";
import { runProvider } from "./provider-process.mjs";

// A protected machine profile supplies the installed Git image, its helper
// directory and an empty working directory. A watch can select only the
// repository and exact branch approved in its private resource definition.
export function validBranchResource(endpoint, ref) {
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !endpoint.startsWith("https://") ||
      !/^[\x21-\x7e]+$/.test(endpoint) || /[%\\?#@]/.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    if (url.href !== endpoint || url.protocol !== "https:" || !url.hostname || url.username || url.password ||
        !/^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(url.pathname)) return false;
  } catch { return false; }
  if (typeof ref !== "string" || ref.length > 255 || !ref.startsWith("refs/heads/")) return false;
  return ref.slice(11).split("/").every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) &&
    !part.endsWith(".") && !part.endsWith(".lock") && !part.includes("..") && !/[\r\n]/.test(part));
}

export async function sampleAnonymousBranch(profile, endpoint, ref, signal, run = runProvider) {
  if (!validBranchResource(endpoint, ref) || ![profile?.image, profile?.execPath, profile?.cwd, profile?.windows]
    .every(value => typeof value === "string" && path.win32.isAbsolute(value))) throw Error("branch observation unavailable");
  const args = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
    "-c", "credential.helper=", "-c", "credential.interactive=false", "-c", "http.emptyAuth=false",
    "-c", "http.proxy=", "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
    "-c", "http.sslBackend=schannel", "ls-remote", "--exit-code", "--refs", "--", endpoint, ref];
  const env = { SystemRoot: profile.windows, PATH: path.win32.dirname(profile.image) + ";" + path.win32.join(profile.windows, "System32"),
    GIT_EXEC_PATH: profile.execPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: path.win32.dirname(profile.cwd) };
  try {
    const { code, stdout } = await run(profile.image, args, { env, cwd: profile.cwd, signal, timeoutMs: 9000, maxBytes: 4096 });
    if (code !== 0 || typeof stdout !== "string") throw Error();
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t([^\r\n]+)\r?\n$/.exec(stdout);
    if (!match || match[0] !== stdout || match[2] !== ref) throw Error();
    return match[1];
  } catch { throw Error("branch observation unavailable"); }
}
