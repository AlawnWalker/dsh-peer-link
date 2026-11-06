import assert from "node:assert/strict";
import test from "node:test";

import { applyWith, shortIdOf } from "../index.js";
import { parseMessage } from "../lib/protocol.js";

function fakeAgent(id, seq) {
  const injected = [];
  return { id, session: { seq }, injected, followup(message) { injected.push(message); } };
}

function makeCtx(agents) {
  const registered = [];
  return {
    agents: { list: () => agents },
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    effect: () => {},
    logger: { info: () => {} },
    registered,
  };
}

function fakeTransport(remote) {
  const sent = [];
  return {
    sent,
    start() {},
    stop() {},
    snapshot: () => ({
      outbound: { status: "up", pid: 1, restarts: 0, lastError: "" },
      inbound: { status: "up", pid: 2, restarts: 0, lastError: "" },
    }),
    async send(line) { sent.push(line); },
    remote,
  };
}

function fakeInbox(options) {
  return {
    options,
    start: async () => options.port,
    stop: async () => {},
    snapshot: () => ({ listening: true, port: options.port, received: 0, parsed: 0, dropped: 0 }),
  };
}

const REMOTE = {
  name: "cc-build",
  sshTarget: "dev@build-01",
  remoteSocket: "/tmp/cc-socks/1.sock",
  localPort: 17802,
  remoteListenPath: "/tmp/dsh-peer.sock",
  inboxPort: 17801,
};

test("peer_list/peer_send tools are registered with the configured prefix", () => {
  const ctx = makeCtx([]);
  const handle = applyWith({
    defineTool: (definition) => definition,
    ctx,
    config: { remotes: [REMOTE] },
    transportFactory: (remote) => fakeTransport(remote),
    inboxFactory: fakeInbox,
  });
  assert.deepEqual(ctx.registered.map((d) => d.name).sort(), ["remote_peer_list", "remote_peer_send"]);
  handle.stop();
});

test("send wraps the text in the shared envelope and tags the session", async () => {
  const agent = fakeAgent("session-abcdef12-3456-7890-1111-222233334444", 3);
  const ctx = makeCtx([agent]);
  const transport = fakeTransport({});
  const handle = applyWith({
    defineTool: (definition) => definition,
    ctx,
    config: { remotes: [REMOTE] },
    transportFactory: () => transport,
    inboxFactory: fakeInbox,
  });
  const result = await handle.send("cc-build", "hello remote", { agent });
  assert.equal(result.sent, true);
  const parsed = parseMessage(transport.sent[0]);
  assert.equal(parsed?.fromName, "dsh-abcdef12");
  assert.match(parsed?.text ?? "", /@dsh-abcdef12:abcdef12/);
  assert.match(parsed?.text ?? "", /hello remote/);
  assert.match(parsed?.from ?? "", /uds:\/tmp\/dsh-peer\.sock/);
  handle.stop();
});

test("send reports unknown remotes instead of pretending success", async () => {
  const ctx = makeCtx([]);
  const handle = applyWith({
    defineTool: (definition) => definition,
    ctx,
    config: { remotes: [REMOTE] },
    transportFactory: (remote) => fakeTransport(remote),
    inboxFactory: fakeInbox,
  });
  const result = await handle.send("nope", "x");
  assert.equal(result.sent, false);
  assert.match(result.error, /unknown remote/);
  handle.stop();
});

test("inbound messages inject into the tagged session, else the most recent one", () => {
  const older = fakeAgent("session-11111111-0000-0000-0000-000000000000", 1);
  const newer = fakeAgent("session-22222222-0000-0000-0000-000000000000", 9);
  const ctx = makeCtx([older, newer]);
  let onMessage;
  const handle = applyWith({
    defineTool: (definition) => definition,
    ctx,
    config: { remotes: [REMOTE] },
    transportFactory: (remote) => fakeTransport(remote),
    inboxFactory: (options) => {
      onMessage = options.onMessage;
      return fakeInbox(options);
    },
  });

  onMessage({ msgId: "1", from: "uds:/tmp/x", fromName: "cc-build", text: "tagged for older @dsh-x:11111111" });
  assert.equal(older.injected.length, 1);
  assert.equal(newer.injected.length, 0);

  onMessage({ msgId: "2", from: "uds:/tmp/x", fromName: "cc-build", text: "no tag at all" });
  assert.equal(newer.injected.length, 1);
  const text = newer.injected[0]?.content?.[0]?.text ?? "";
  assert.match(text, /📨 \[peer\] cc-build 说:/);
  handle.stop();
});

test("shortIdOf keeps the first 8 hex chars of a session id", () => {
  assert.equal(shortIdOf("session-abcdef12-3456-7890-1111-222233334444"), "abcdef12");
  assert.equal(shortIdOf("plain-name"), "plain-name");
});
