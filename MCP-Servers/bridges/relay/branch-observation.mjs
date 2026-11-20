import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { runProvider } from "./provider-process.mjs";
import { matches, UUID } from "./delivery-protocol.mjs";

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
  return queryBranch(profile, endpoint, ref, signal, run);
}

async function queryBranch(profile, endpoint, ref, signal, run, basicCredential) {
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
    if (basicCredential) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http." + endpoint + ".extraHeader";
      env.GIT_CONFIG_VALUE_0 = "Authorization: Basic " + basicCredential.toString("base64");
    }
    const { code, stdout } = await run(profile.image, args, { env, cwd: profile.cwd, signal, timeoutMs: 9000, maxBytes: 4096 });
    if (code !== 0 || typeof stdout !== "string") throw Error();
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t([^\r\n]+)\r?\n$/.exec(stdout);
    if (!match || match[0] !== stdout || match[2] !== ref) throw Error();
    return match[1];
  } catch { throw Error("branch observation unavailable"); }
  finally { delete env.GIT_CONFIG_VALUE_0; }
}

// Setup validates ownership and denies writes by desktop sessions throughout
// the executable search directories. Recheck the live administrative pins so
// profile removal and a provider update take effect on the next observation.
async function verifyGitPins(root, profile, signal) {
  const files = [[path.join(root, "completion-git.json"), profile.profileHash, 1024],
    [profile.image, profile.imageHash, 64 << 20], [path.join(profile.execPath, "git-remote-https.exe"), profile.transportHash, 64 << 20]];
  for (const [file, expected, limit] of files) {
    signal?.throwIfAborted();
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw Error("branch observation unavailable");
    const handle = await fs.promises.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw Error("branch observation unavailable");
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        size += chunk.length;
        if (size > stat.size) throw Error("branch observation unavailable");
        hash.update(chunk);
      }
      if (size !== stat.size || hash.digest("hex") !== expected) throw Error("branch observation unavailable");
    } finally { await handle.close(); }
  }
}

export async function sampleInstalledBranch(root, profile, grant, signal, { canObserve, run = runProvider, credentialRecord } = {}) {
  let secret;
  try {
    const { endpoint, ref, credential } = grant;
    if (!validBranchResource(endpoint, ref) || ![profile?.image, profile?.execPath, profile?.cwd, profile?.windows]
      .every(value => typeof value === "string" && path.win32.isAbsolute(value))) throw Error();
    // The broker supplies a pre-bound reader for a protected record. Session
    // input can select neither a file path nor the function that opens it.
    function checkAuthority() {
      signal?.throwIfAborted();
      if (canObserve() !== true) throw Error();
      if (credential === null) return;
      if (!matches(UUID, credential) ||
          credentialRecord?.id !== credential || credentialRecord.endpoint !== endpoint ||
          credentialRecord.ref !== ref || typeof credentialRecord.readSealed !== "function" ||
          typeof credentialRecord.unseal !== "function") throw Error();
    }
    checkAuthority();
    await verifyGitPins(root, profile, signal);
    checkAuthority();
    if (credential !== null) {
      // The protected adapter opens and closes the record synchronously here.
      const sealed = credentialRecord.readSealed();
      if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length > 8192) throw Error();
      checkAuthority();
      secret = await credentialRecord.unseal(sealed);
      checkAuthority();
      if (!Buffer.isBuffer(secret) || secret.length > 4096) throw Error();
      const colon = secret.indexOf(0x3a);
      if (colon < 1 || colon === secret.length - 1 ||
          !secret.every(byte => byte >= 33 && byte <= 126)) throw Error();
      // Reading the record may yield. Reconfirm the machine profile and
      // binaries, then check the live grant immediately before process launch.
      await verifyGitPins(root, profile, signal);
      checkAuthority();
    }
    return await queryBranch(profile, endpoint, ref, signal, run, secret);
  } catch { throw Error("branch observation unavailable"); }
  finally {
    if (Buffer.isBuffer(secret)) secret.fill(0);
  }
}
