#!/usr/bin/env node
/**
 * End-to-end smoke test without SSH: a fake "remote agent" listens on TCP,
 * receives the outbound message and replies to the plugin's inbox port.
 *
 *   node dev/live-smoke.mjs
 *
 * It exercises the same code paths an SSH remote uses after the forwards are
 * up (envelope build -> send -> inbox -> session injection), so a green run
 * means only the ssh hops are left to verify.
 */

import { createServer, connect } from "node:net";

import { applyWith } from "../index.js";
import { parseMessage } from "../lib/protocol.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const outbound = [];
let inboxPort = 0;

const fakeRemote = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const message = parseMessage(line);
      if (!message) continue;
      outbound.push(message);
      const reply = JSON.stringify({
        msgV: 1,
        msg_id: `reply-${outbound.length}`,
        type: "user",
        message: {
          role: "user",
          content: `<cross-session-message from="uds:/tmp/fake" from-name="cc-fake">pong #${outbound.length}</cross-session-message>`,
        },
        priority: "next",
        from: "uds:/tmp/fake",
      });
      const back = connect(inboxPort, "127.0.0.1");
      back.once("connect", () => back.end(`${reply}\n`));
      back.once("error", () => {});
    }
  });
});

await new Promise((resolve, reject) => {
  fakeRemote.once("error", reject);
  fakeRemote.listen(0, "127.0.0.1", resolve);
});
const fakePort = fakeRemote.address().port;

const agent = { id: "session-abcdef12-1111-2222-3333-444455556666", session: { seq: 1 }, injected: [] };
agent.followup = (message) => agent.injected.push(message);

const ctx = {
  agents: { list: () => [agent] },
  tools: { register: () => () => {} },
  effect: () => {},
  logger: { info: () => {} },
};

const handle = applyWith({
  defineTool: (definition) => definition,
  ctx,
  config: {
    toolPrefix: "remote_",
    remotes: [
      {
        name: "fake",
        transport: "tcp",
        remoteHost: "127.0.0.1",
        remotePort: fakePort,
        inboxPort: 0,
      },
    ],
  },
});

await waitFor(() => {
  const state = handle.state()[0];
  inboxPort = state?.inbox?.port ?? 0;
  return inboxPort > 0;
});
check("inbox listening on a loopback port", inboxPort > 0, `port=${inboxPort}`);
check("transport started without config errors", handle.errors.length === 0, handle.errors.join("; "));

const sent = await handle.send("fake", "ping from dsh-peer-ssh", { agent });
check("send returns sent=true", sent.sent === true, JSON.stringify(sent));
const arrived = await waitFor(() => outbound.length >= 1, 4000);
check("fake remote received the envelope", arrived, `count=${outbound.length}`);
check(
  "outbound envelope carries the sender tag",
  (outbound[0]?.text ?? "").includes("@dsh-abcdef12:abcdef12"),
);

const injected = await waitFor(() => agent.injected.length >= 1);
check("reply reached the inbox and was injected", injected, `injected=${agent.injected.length}`);
const injectedText = agent.injected[0]?.content?.[0]?.text ?? "";
check("injected text uses the peer banner", injectedText.includes("📨 [peer] cc-fake 说:"));
check("injected text carries the body", injectedText.includes("pong #1"));

const unknown = await handle.send("missing", "x");
check("unknown remote fails explicitly", unknown.sent === false && /unknown remote/.test(unknown.error ?? ""));

handle.stop();
fakeRemote.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
