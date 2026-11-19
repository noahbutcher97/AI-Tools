import assert from "node:assert/strict";
import test from "node:test";
import { sampleAnonymousBranch, validBranchResource } from "./branch-observation.mjs";

const endpoint = "https://" + ["fixture","invalid"].join(".") + "/fixture/repo";
const ref = "refs/heads/fixture";
const profile = { image: "X:/git/bin/git.exe", execPath: "X:/git/helpers", cwd: "X:/watch/empty", windows: "X:/system" };
const revision = "a".repeat(40);

test("anonymous Git observation runs a single configured HTTPS ref query in an isolated environment", async () => {
  let calls = 0;
  const run = async (command, args, options) => {
    calls++;
    assert.equal(command, profile.image);
    assert.deepEqual(args.slice(-6), ["ls-remote","--exit-code","--refs","--",endpoint,ref]);
    assert.deepEqual(args.slice(0,-6), ["-c","protocol.allow=never","-c","protocol.https.allow=always",
      "-c","credential.helper=","-c","credential.interactive=false","-c","http.emptyAuth=false","-c","http.proxy=",
      "-c","http.followRedirects=false","-c","http.sslVerify=true","-c","http.sslBackend=schannel"]);
    assert.deepEqual(Object.keys(options.env).sort(), ["SystemRoot","PATH","GIT_EXEC_PATH","GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL","GIT_TERMINAL_PROMPT","GIT_CEILING_DIRECTORIES"].sort());
    assert.equal(options.env.GIT_EXEC_PATH, profile.execPath);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, "NUL");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.cwd, profile.cwd);
    assert.equal(options.timeoutMs, 9000);
    assert.equal(options.maxBytes, 4096);
    return { code: 0, stdout: revision + "\t" + ref + "\n" };
  };
  assert.equal(await sampleAnonymousBranch(profile, endpoint, ref, undefined, run), revision);
  for (const bad of [endpoint.replace("https:", "http:"), endpoint + "?credential=fixture",
    endpoint.replace("//", "//fixture@"), endpoint + "/../other", endpoint + "%20x", endpoint + "\n"]) {
    await assert.rejects(sampleAnonymousBranch(profile, bad, ref, undefined, run), /unavailable/);
  }
  for (const bad of ["HEAD","refs/tags/fixture",ref+"*",ref+"..x",ref+"\n",ref+"/a.lock"]) {
    assert.equal(validBranchResource(endpoint, bad), false);
  }
  assert.equal(calls, 1);
});

test("only a successful exact ref result exposes a revision", async () => {
  for (const [code, stdout] of [[2,""],[0,revision+"\trefs/heads/other\n"],[0,revision+"\t"+ref+"\n\n"],
    [0,revision+"\t"+ref+"\nextra"],[0,"untrusted"],[1,revision+"\t"+ref+"\n"]]) {
    await assert.rejects(sampleAnonymousBranch(profile, endpoint, ref, undefined, async () => ({ code, stdout })),
      { message: "branch observation unavailable" });
  }
});
