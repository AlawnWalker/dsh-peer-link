import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig, normalizeSshTarget, replyAddress } from "../lib/config.js";

const sshRemote = {
  name: "cc-build",
  sshTarget: "dev@build-01",
  remoteSocket: "/tmp/cc-socks/1.sock",
  localPort: 17802,
  remoteListenPath: "/tmp/dsh-peer.sock",
  inboxPort: 17801,
};

test("defaults are applied and a full ssh remote normalises", () => {
  const { config, remotes, errors } = normalizeConfig({ remotes: [sshRemote] });
  assert.deepEqual(errors, []);
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.toolPrefix, "remote_");
  assert.equal(remotes.length, 1);
  const remote = remotes[0];
  assert.equal(remote.transport, "ssh");
  assert.equal(remote.sshTarget.user, "dev");
  assert.equal(remote.sshTarget.host, "build-01");
  assert.equal(remote.peerName, "dsh-cc-build");
  assert.equal(replyAddress(remote), "uds:/tmp/dsh-peer.sock");
});

test("ssh target accepts bare host, user@host and host:port", () => {
  assert.deepEqual(normalizeSshTarget("build-01"), { raw: "build-01", user: "", host: "build-01", port: "" });
  assert.equal(normalizeSshTarget("me@build:2222")?.port, "2222");
  assert.equal(normalizeSshTarget("") , null);
});

test("missing ssh fields are reported per remote", () => {
  const { remotes, errors } = normalizeConfig({ remotes: [{ name: "x" }] });
  assert.equal(remotes.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sshTarget is required/);
});

test("a tcp remote needs host and port and reports a tcp reply address", () => {
  const { remotes, errors } = normalizeConfig({
    remotes: [{ name: "lan", transport: "tcp", remoteHost: "203.0.113.9", remotePort: 17900, inboxPort: 17901 }],
  });
  assert.deepEqual(errors, []);
  assert.equal(remotes[0].remoteHost, "203.0.113.9");
  assert.equal(replyAddress(remotes[0]), "tcp:127.0.0.1:17901");
  const bad = normalizeConfig({ remotes: [{ name: "lan", transport: "tcp" }] });
  assert.equal(bad.errors.length, 1);
});

test("duplicate names and non-loopback binds are rejected", () => {
  const dup = normalizeConfig({ remotes: [sshRemote, { ...sshRemote }] });
  assert.equal(dup.remotes.length, 1);
  assert.match(dup.errors[0], /duplicate name/);
  const open = normalizeConfig({ remotes: [{ ...sshRemote, bindHost: "0.0.0.0" }] });
  assert.equal(open.remotes.length, 0);
  assert.match(open.errors[0], /loopback/);
});

test("ports may be omitted so several remotes never collide", () => {
  const { remotes, errors } = normalizeConfig({
    remotes: [
      { name: "a", sshTarget: "u@h1", remoteSocket: "/run/a/*.sock", remoteListenPath: "/tmp/a.sock" },
      { name: "b", sshTarget: "u@h2", remoteSocket: "/run/b/1.sock", remoteListenPath: "/tmp/b.sock" },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(remotes.length, 2);
  for (const remote of remotes) {
    assert.equal(remote.localPort, 0, "localPort omitted -> auto");
    assert.equal(remote.inboxPort, 0, "inboxPort omitted -> auto");
  }
});

test("an explicit port is kept and out-of-range values are rejected", () => {
  const ok = normalizeConfig({
    remotes: [{ name: "a", sshTarget: "u@h", remoteSocket: "/x/1.sock", remoteListenPath: "/tmp/x.sock", localPort: 18000, inboxPort: 18001 }],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.remotes[0].localPort, 18000);
  const bad = normalizeConfig({
    remotes: [{ name: "a", sshTarget: "u@h", remoteSocket: "/x/1.sock", remoteListenPath: "/tmp/x.sock", localPort: 70000 }],
  });
  assert.match(bad.errors[0], /out of range/);
});