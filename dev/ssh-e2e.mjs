#!/usr/bin/env node
/**
 * Real SSH end-to-end test.
 *
 *   DSH_PEER_SSH_TEST_HOST=<user@host> node dev/ssh-e2e.mjs
 *
 * The remote host only needs `socat` (no node). The script writes a one-line
 * responder to /tmp, runs `ssh <host> socat UNIX-LISTEN:...` as the fake agent
 * (a foreground child we kill afterwards), starts the plugin with
 * transport=ssh, sends a message, expects the reply to come back through
 * `ssh -R`, then exercises the registration helper and cleans up.
 *
 * Every ssh invocation is a single simple command (no `&&`, `>`, `|`): some
 * launchers run children through a local shell that would consume them, and
 * ssh only exits once its stdin is closed, so an explicit input is always
 * passed.
 */

import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { applyWith } from "../index.js";
import { registerRemotePeer, recordPath, unregisterRemotePeer } from "../lib/register.js";

const run = promisify(execFile);
const HOST = process.env.DSH_PEER_SSH_TEST_HOST ?? "";
const SSH_ARGS = ["-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
const STAMP = `${Date.now()}`;
const AGENT_SOCK = `/tmp/dsh-peer-ssh-e2e-agent-${STAMP}.sock`;
const IN_SOCK = `/tmp/dsh-peer-ssh-e2e-in-${STAMP}.sock`;
const AGENT_SH = `/tmp/dsh-peer-ssh-e2e-agent-${STAMP}.sh`;
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const LOCAL_PORT = await freePort();
const INBOX_PORT = await freePort();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function waitFor(predicate, timeoutMs = 12000, intervalMs = 800) {
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

async function ssh(command, input = "") {
  return run("ssh", [...SSH_ARGS, HOST, command], { input, timeout: 30000, windowsHide: true });
}

async function sshOk(command, input = "", attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await ssh(command, input);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  return false;
}

if (HOST === "") {
  console.error("SKIP: set DSH_PEER_SSH_TEST_HOST=<user@host> to run the SSH end-to-end test");
  process.exit(0);
}

const replyJson = JSON.stringify({
  msgV: 1,
  msg_id: `e2e-${STAMP}`,
  type: "user",
  message: {
    role: "user",
    content: `<cross-session-message from="uds:${AGENT_SOCK}" from-name="ssh-e2e">pong over ssh ${STAMP}</cross-session-message>`,
  },
  priority: "next",
  from: `uds:${AGENT_SOCK}`,
});

const responder = [
  "#!/bin/sh",
  "read line",
  `printf '%s\\n' '${replyJson.replace(/'/g, `'\\''`)}' | socat - UNIX-CONNECT:${IN_SOCK}`,
  "",
].join("\n");

let handle;
let agentProcess;
try {
  // scp instead of `tee`: no stdin pipe and no shell operators.
  const localResponder = join(tmpdir(), `dsh-peer-ssh-responder-${STAMP}.sh`);
  await writeFile(localResponder, responder, "utf8");
  const copied = await run(
    "scp",
    ["-q", ...SSH_ARGS, localResponder, `${HOST}:${AGENT_SH}`],
    { timeout: 20000, windowsHide: true },
  ).then(() => true).catch(() => false);
  check("responder copied", copied);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("responder executable", await sshOk(`chmod +x ${AGENT_SH}`));

  // Foreground socat over an ssh child: no backgrounding, no shell operators.
  agentProcess = spawn(
    "ssh",
    [...SSH_ARGS, HOST, `socat UNIX-LISTEN:${AGENT_SOCK},fork,reuseaddr EXEC:${AGENT_SH}`],
    { stdio: "ignore", windowsHide: true },
  );
  const socketReady = await waitFor(async () => {
    try {
      const { stdout } = await ssh(`test -S ${AGENT_SOCK}`, "");
      return stdout.trim() === "";
    } catch {
      return false;
    }
  }, 10000);
  check("remote agent socket is up", socketReady, `ssh-pid=${agentProcess.pid}`);

  const agent = { id: "session-abcdef12-1111-2222-3333-444455556666", session: { seq: 1 }, injected: [] };
  agent.followup = (message) => agent.injected.push(message);
  const ctx = {
    agents: { list: () => [agent] },
    tools: { register: () => () => {} },
    effect: () => {},
    logger: { info: () => {} },
  };

  handle = applyWith({
    defineTool: (definition) => definition,
    ctx,
    config: {
      remotes: [
        {
          name: "ssh-e2e",
          sshTarget: HOST,
          remoteSocket: AGENT_SOCK,
          localPort: LOCAL_PORT,
          remoteListenPath: IN_SOCK,
          inboxPort: INBOX_PORT,
        },
      ],
    },
  });

  const forwardsUp = await waitFor(() => {
    const state = handle.state()[0];
    return state?.outbound?.status === "up" && state?.inbound?.status === "up";
  }, 15000);
  check("ssh -L and -R forwards are up", forwardsUp, JSON.stringify(handle.state()[0]?.outbound ?? {}));

  const sent = await handle.send("ssh-e2e", "ping over real ssh", { agent });
  check("send succeeded over ssh", sent.sent === true, JSON.stringify(sent));

  const injected = await waitFor(() => agent.injected.length >= 1, 15000);
  check("reply travelled back through ssh -R", injected, `injected=${agent.injected.length}`);
  const text = agent.injected[0]?.content?.[0]?.text ?? "";
  check("reply body matches", text.includes(`pong over ssh ${STAMP}`), text.slice(0, 100));

  const sessionDir = `/tmp/dsh-peer-ssh-e2e-sessions-${STAMP}`;
  const name = `dsh-e2e-${STAMP}`;
  const registered = await registerRemotePeer({ sshTarget: HOST, sessionDir, socketPath: IN_SOCK, name });
  const expected = recordPath(sessionDir, name);
  check("record path is deterministic", registered.path === expected, registered.path);
  let parsedRecord = null;
  try {
    const { stdout } = await ssh(`cat ${expected}`);
    parsedRecord = JSON.parse(stdout);
  } catch {
    parsedRecord = null;
  }
  check("peer record written remotely", parsedRecord?.messagingSocketPath === IN_SOCK);
  const removed = await unregisterRemotePeer({ sshTarget: HOST, sessionDir, name });
  check("peer record removed", removed.removed === true);
} catch (err) {
  check(`unexpected error: ${err?.message ?? err}`, false);
} finally {
  try {
    handle?.stop();
  } catch {
    /* ignore */
  }
  try {
    agentProcess?.kill();
  } catch {
    /* ignore */
  }
  await sshOk(`rm -f ${AGENT_SH} ${AGENT_SOCK} ${IN_SOCK}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
