import assert from "node:assert/strict";
import test from "node:test";

import { cleanRemotePath, patternToRegExp, resolveSocketPattern } from "../lib/tunnel.js";

test("patternToRegExp only treats * and ? as wildcards", () => {
  const re = patternToRegExp("*.sock");
  assert.ok(re.test("30289.sock"));
  assert.ok(!re.test("30289.json"));
  const dotted = patternToRegExp("a.b.sock");
  assert.ok(dotted.test("a.b.sock"));
  assert.ok(!dotted.test("axb.sock"));
  assert.ok(patternToRegExp("?23.sock").test("123.sock"));
});

test("resolveSocketPattern picks the newest match from ls -t output", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "44409.sock\n30289.sock\nnotes.txt\n", stderr: "" };
  };
  const resolved = await resolveSocketPattern({
    sshCommand: "ssh",
    sshArgs: ["-o", "BatchMode=yes"],
    sshTarget: "user@build-01",
    pattern: "/run/user/1000/cc-socks/*.sock",
    runner,
  });
  assert.equal(resolved, "/run/user/1000/cc-socks/44409.sock");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls[0].args.at(-1), "ls -t /run/user/1000/cc-socks");
  assert.equal(calls[0].args.at(-2), "user@build-01");
});

test("resolveSocketPattern reports a useful error when nothing matches", async () => {
  const runner = async () => ({ stdout: "notes.txt\n", stderr: "" });
  await assert.rejects(
    () =>
      resolveSocketPattern({
        sshTarget: "user@build-01",
        pattern: "/run/user/1000/cc-socks/*.sock",
        runner,
      }),
    /no file matches.*1 entries/,
  );
});

test("resolveSocketPattern rejects a pattern without a directory", async () => {
  await assert.rejects(() => resolveSocketPattern({ sshTarget: "h", pattern: "*.sock" }), /needs a directory/);
});

test("cleanRemotePath removes the stale socket with a plain rm -f", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "", stderr: "" };
  };
  const ok = await cleanRemotePath({
    sshTarget: "user@build-01",
    path: "/tmp/dsh-peer-cc.sock",
    runner,
  });
  assert.equal(ok, true);
  assert.equal(calls[0].args.at(-1), "rm -f /tmp/dsh-peer-cc.sock");
  assert.equal(calls[0].args.at(-2), "user@build-01");
});

test("cleanRemotePath swallows failures so the forward can report the real error", async () => {
  const runner = async () => {
    throw new Error("ssh: connect failed");
  };
  const messages = [];
  const ok = await cleanRemotePath({ sshTarget: "h", path: "/tmp/x.sock", runner, logger: (m) => messages.push(m) });
  assert.equal(ok, false);
  assert.match(messages.join("\n"), /could not remove stale/);
});