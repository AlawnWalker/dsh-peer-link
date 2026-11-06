import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";

import { createInbox } from "../lib/inbox.js";
import { buildMessage } from "../lib/protocol.js";

function sendLine(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => socket.end(payload));
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}

test("inbox parses envelopes, dedupes by msg_id and drops junk", async () => {
  const received = [];
  const inbox = createInbox({ name: "t", host: "127.0.0.1", port: 0, onMessage: (m) => received.push(m) });
  const port = await inbox.start();
  assert.ok(port > 0);

  const first = buildMessage({ from: "uds:/tmp/a", fromName: "peer-a", text: "one", msgId: "same-id" });
  const second = buildMessage({ from: "uds:/tmp/a", fromName: "peer-a", text: "two", msgId: "other-id" });

  await sendLine(port, first);
  await sendLine(port, first); // duplicate msg_id
  await sendLine(port, second);
  await sendLine(port, "garbage that is not json\n");

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(received.length, 2);
  assert.deepEqual(received.map((m) => m.text), ["one", "two"]);
  const state = inbox.snapshot();
  assert.equal(state.received, 4);
  assert.equal(state.parsed, 2);
  assert.equal(state.dropped, 2);
  await inbox.stop();
});

test("inbox survives a message split across two connections' chunks", async () => {
  const received = [];
  const inbox = createInbox({ name: "t2", host: "127.0.0.1", port: 0, onMessage: (m) => received.push(m) });
  const port = await inbox.start();

  const line = buildMessage({ from: "uds:/tmp/b", fromName: "peer-b", text: "chunked" });
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.write(line.slice(0, 12));
      setTimeout(() => socket.end(line.slice(12)), 30);
    });
    socket.once("close", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(received.length, 1);
  assert.equal(received[0].text, "chunked");
  await inbox.stop();
});
