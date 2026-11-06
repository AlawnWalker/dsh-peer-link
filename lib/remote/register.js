/**
 * Remote-side registration.
 *
 * A Claude Code agent only sends messages to peers it can discover, so the DSH
 * side needs a record in the remote `~/.claude/sessions/` directory pointing at
 * the unix socket that `ssh -R` created. This module writes and removes that
 * record through SSH + SCP (no daemon on the remote side).
 *
 * Every remote command is a single simple command: no `&&`, `>`, `|` or `&`.
 * Some launchers run child processes through cmd.exe, which would consume those
 * locally, and ssh only exits once its stdin is closed.
 *
 * The fake pid is derived from the peer name, so re-registering overwrites the
 * same file and `--remove` finds it again without extra arguments.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Multiplexing breaks under confined launchers; always pass these. */
export const SAFE_SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

/** Deterministic 9-digit "pid" for a peer name (Claude's filenames are numeric). */
export function pseudoPid(peerName) {
  const digest = createHash("sha256").update(String(peerName)).digest();
  return 900000000 + (digest.readUInt32BE(0) % 100000000);
}

export function recordPath(sessionDir, peerName) {
  const dir = String(sessionDir ?? "~/.claude/sessions").replace(/\/+$/, "");
  return `${dir}/${pseudoPid(peerName)}.json`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sshArgv(sshArgs) {
  const args = Array.isArray(sshArgs) ? [...sshArgs] : [];
  const hasControl = args.some((arg) => String(arg).startsWith("ControlMaster"));
  return hasControl ? args : [...SAFE_SSH_OPTS, ...args];
}

/**
 * Build the record Claude Code reads from `~/.claude/sessions/<pid>.json`.
 * @param {{name:string, socketPath:string, cwd?:string}} options
 */
export function buildRecord({ name, socketPath, cwd = "/" }) {
  const now = Date.now();
  return {
    pid: pseudoPid(name),
    sessionId: `dsh-ssh-${name}`,
    cwd,
    startedAt: now,
    procStart: String(now),
    version: "2.1.226",
    peerProtocol: 1,
    peerFeatures: ["notify_idle", "artifact_yield"],
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: socketPath,
    name,
    nameSource: "user",
    status: "idle",
    updatedAt: now,
    statusUpdatedAt: now,
  };
}

/**
 * sshd throttles bursts of connections (MaxStartups), and a failed setup step
 * is not informative to the caller, so retry a few times with a growing delay.
 */
async function withRetry(fn, attempts = 4, delayMs = 700) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

async function sshRun({ sshCommand = "ssh", sshArgs = [], sshTarget, command }) {
  return withRetry(() =>
    run(sshCommand, [...sshArgv(sshArgs), sshTarget, command], {
      input: "",
      timeout: 20000,
      windowsHide: true,
    }),
  );
}

/**
 * Write the peer record on the remote host.
 * @returns {Promise<{path:string, record:object}>}
 */
export async function registerRemotePeer({
  sshCommand = "ssh",
  sshArgs = [],
  scpCommand = "scp",
  sshTarget,
  sessionDir = "~/.claude/sessions",
  socketPath,
  name,
  cwd = "/",
} = {}) {
  if (!sshTarget) throw new Error("registerRemotePeer: sshTarget is required");
  if (!socketPath) throw new Error("registerRemotePeer: socketPath is required");
  if (!name) throw new Error("registerRemotePeer: name is required");
  const record = buildRecord({ name, socketPath, cwd });
  const path = recordPath(sessionDir, name);

  await sshRun({ sshCommand, sshArgs, sshTarget, command: `mkdir -p ${shQuote(sessionDir)}` });

  const dir = await mkdtemp(join(tmpdir(), "dsh-peer-ssh-record-"));
  const localFile = join(dir, `${record.pid}.json`);
  try {
    await writeFile(localFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await withRetry(() =>
      run(scpCommand, ["-q", ...sshArgv(sshArgs), localFile, `${sshTarget}:${path}`], {
        timeout: 20000,
        windowsHide: true,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  await sshRun({ sshCommand, sshArgs, sshTarget, command: `chmod 600 ${shQuote(path)}` });
  return { path, record };
}

/** Remove the peer record from the remote host (best effort). */
export async function unregisterRemotePeer({
  sshCommand = "ssh",
  sshArgs = [],
  sshTarget,
  sessionDir = "~/.claude/sessions",
  name,
} = {}) {
  if (!sshTarget || !name) return { path: "", removed: false };
  const path = recordPath(sessionDir, name);
  try {
    await sshRun({ sshCommand, sshArgs, sshTarget, command: `rm -f ${shQuote(path)}` });
    return { path, removed: true };
  } catch (err) {
    return { path, removed: false, error: err?.message ?? String(err) };
  }
}
