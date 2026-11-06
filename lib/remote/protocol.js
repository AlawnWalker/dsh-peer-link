/**
 * Wire format shared with `dsh-peer-link` and the Claude Code `cc-peer` skill:
 * one NDJSON line per message, the body wrapped in `<cross-session-message>`.
 *
 *   {"msgV":1,"msg_id":"<uuid>","type":"user",
 *    "message":{"role":"user","content":"<cross-session-message from=... from-name=...>TEXT</...>"},
 *    "priority":"next","from":"uds:/tmp/cc-socks/x.sock"}
 *
 * Keeping the same envelope means a remote agent does not need to know that the
 * hop is SSH instead of a local socket.
 */

import { randomUUID } from "node:crypto";

const WRAP_RE = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;
const ATTR_RE = (name) => new RegExp(`${name}="([^"]*)"`);

/** Escape a value for a double-quoted XML attribute inside the envelope. */
export function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build one NDJSON line.
 * @param {{from:string, fromName:string, text:string, msgId?:string}} options
 * @returns {string} JSON + "\n"
 */
export function buildMessage({ from, fromName, text, msgId }) {
  const body = String(text ?? "").trim();
  const content =
    `<cross-session-message from="${escapeAttr(from)}" from-name="${escapeAttr(fromName)}">\n` +
    `${body}\n` +
    `</cross-session-message>`;
  return (
    JSON.stringify({
      msgV: 1,
      msg_id: msgId ?? randomUUID(),
      type: "user",
      message: { role: "user", content },
      priority: "next",
      from,
    }) + "\n"
  );
}

/**
 * Parse one NDJSON line.
 * @param {string} line
 * @returns {{msgId:string, from:string, fromName?:string, text:string}|null}
 */
export function parseMessage(line) {
  let raw;
  try {
    raw = JSON.parse(String(line ?? "").trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.type !== "user") return null;
  const message = raw.message;
  if (!message || typeof message !== "object" || typeof message.content !== "string") return null;
  const content = message.content;
  const wrap = content.match(WRAP_RE);
  const attrs = wrap ? wrap[1] : "";
  const fromNameMatch = attrs.match(ATTR_RE("from-name"));
  const fromMatch = attrs.match(ATTR_RE("from"));
  return {
    msgId: typeof raw.msg_id === "string" ? raw.msg_id : "",
    from: typeof raw.from === "string" ? raw.from : (fromMatch ? decodeEntities(fromMatch[1]) : ""),
    fromName: fromNameMatch ? decodeEntities(fromNameMatch[1]) : undefined,
    text: (wrap ? wrap[2] : content).trim(),
  };
}

/** Minimal entity decoding for the attributes we write ourselves. */
export function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Split a byte stream into complete NDJSON lines. The returned function keeps
 * the tail in a closure; pass every chunk and collect emitted lines.
 * @returns {(chunk: Buffer|string) => string[]}
 */
export function createLineSplitter() {
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = [];
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== "") lines.push(line);
    }
    // Guard against a peer that never sends a newline.
    if (buffer.length > 4 * 1024 * 1024) buffer = "";
    return lines;
  };
}
