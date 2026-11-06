/**
 * Local inbox for one remote peer.
 *
 * The remote agent writes NDJSON lines to a unix socket that `ssh -R` forwards
 * to this TCP listener (bound to loopback only). Every complete line is parsed
 * with the shared envelope parser and handed to `onMessage`.
 */

import { createServer } from "node:net";
import { createLineSplitter, parseMessage } from "./protocol.js";

const MAX_DEDUPE = 1024;
const DEDUPE_TTL_MS = 120000;

export function createInbox({ name, host = "127.0.0.1", port, onMessage, logger } = {}) {
  const state = {
    listening: false,
    port: port ?? null,
    received: 0,
    parsed: 0,
    dropped: 0,
    lastAt: null,
    lastError: "",
    lastFrom: "",
  };
  const seen = new Map();
  let server = null;

  function remember(msgId) {
    if (msgId === "") return false;
    const now = Date.now();
    const existing = seen.get(msgId);
    if (existing !== undefined && now - existing < DEDUPE_TTL_MS) return true;
    seen.set(msgId, now);
    if (seen.size > MAX_DEDUPE) {
      for (const [key, at] of seen) {
        if (now - at > DEDUPE_TTL_MS || seen.size > MAX_DEDUPE) seen.delete(key);
        if (seen.size <= MAX_DEDUPE / 2) break;
      }
    }
    return false;
  }

  function handleLine(line) {
    state.received += 1;
    const message = parseMessage(line);
    if (!message) {
      state.dropped += 1;
      logger?.(`[peer-ssh] ${name}: ignored a non-envelope line (${line.slice(0, 80)})`);
      return;
    }
    if (remember(message.msgId)) {
      state.dropped += 1;
      return;
    }
    state.parsed += 1;
    state.lastAt = new Date().toISOString();
    state.lastFrom = message.fromName ?? message.from ?? "";
    try {
      onMessage?.(message);
    } catch (err) {
      state.lastError = err?.message ?? String(err);
      logger?.(`[peer-ssh] ${name}: onMessage failed: ${state.lastError}`);
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = createServer((conn) => {
        const split = createLineSplitter();
        conn.setEncoding("utf8");
        conn.on("data", (chunk) => {
          for (const line of split(chunk)) handleLine(line);
        });
        conn.on("error", (err) => {
          state.lastError = err?.message ?? String(err);
        });
      });
      server.once("error", (err) => {
        state.listening = false;
        state.lastError = err?.message ?? String(err);
        reject(err);
      });
      server.listen(port ?? 0, host, () => {
        state.listening = true;
        state.port = server.address()?.port ?? port ?? null;
        resolve(state.port);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      state.listening = false;
      closing.close(() => resolve());
    });
  }

  return { start, stop, state, snapshot: () => ({ ...state }) };
}
