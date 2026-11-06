import assert from "node:assert/strict";
import test from "node:test";

import { buildMessage, createLineSplitter, parseMessage } from "../lib/protocol.js";

test("buildMessage -> parseMessage round-trips the envelope", () => {
  const line = buildMessage({ from: "uds:/tmp/x.sock", fromName: "dsh-abcdef12", text: "hello 世界" });
  assert.ok(line.endsWith("\n"));
  const parsed = parseMessage(line);
  assert.equal(parsed?.from, "uds:/tmp/x.sock");
  assert.equal(parsed?.fromName, "dsh-abcdef12");
  assert.equal(parsed?.text, "hello 世界");
  assert.match(parsed?.msgId ?? "", /^[0-9a-f-]{36}$/);
});

test("attributes with quotes and ampersands survive escaping", () => {
  const line = buildMessage({ from: 'uds:/tmp/a"b&c.sock', fromName: "dsh-a<b>", text: "x" });
  const parsed = parseMessage(line);
  assert.equal(parsed?.from, 'uds:/tmp/a"b&c.sock');
  assert.equal(parsed?.fromName, "dsh-a<b>");
});

test("parseMessage rejects lines that are not peer envelopes", () => {
  assert.equal(parseMessage("not json"), null);
  assert.equal(parseMessage(JSON.stringify({ type: "assistant" })), null);
  assert.equal(parseMessage(JSON.stringify({ type: "user", message: {} })), null);
});

test("plain content without the wrapper is still accepted", () => {
  const line = JSON.stringify({ type: "user", msg_id: "m1", from: "uds:/tmp/y", message: { role: "user", content: "bare text" } });
  const parsed = parseMessage(line);
  assert.equal(parsed?.text, "bare text");
  assert.equal(parsed?.from, "uds:/tmp/y");
  assert.equal(parsed?.msgId, "m1");
});

test("createLineSplitter reassembles messages split across chunks", () => {
  const split = createLineSplitter();
  const line = buildMessage({ from: "uds:/tmp/z", fromName: "peer", text: "split me" });
  const a = line.slice(0, 10);
  const b = line.slice(10);
  assert.deepEqual(split(a), []);
  const lines = split(b);
  assert.equal(lines.length, 1);
  assert.equal(parseMessage(lines[0])?.text, "split me");
});

test("createLineSplitter drops blank lines and keeps the tail", () => {
  const split = createLineSplitter();
  assert.deepEqual(split("\n\n"), []);
  assert.deepEqual(split("{\"a\":1}"), []);
  assert.deepEqual(split("\n"), ['{"a":1}']);
});
