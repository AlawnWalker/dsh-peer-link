/**
 * Outbound/inbound transport for one remote peer.
 *
 * ssh transport (default)
 *   outbound child: `ssh -N -L <bindHost>:<localPort>:<remoteSocket> <target>`
 *   inbound  child: `ssh -N -R <remoteListenPath>:<bindHost>:<inboxPort> <target>`
 *   Sending is a plain TCP connect to localPort (one connection per message),
 *   which ssh turns into a connection to the remote agent socket.
 *
 * tcp transport
 *   outbound: connect(remoteHost, remotePort) per message, no child process.
 *
 * `remoteSocket` may contain a wildcard (`/run/user/1000/cc-socks/*.sock`).
 * The newest match is resolved on the remote host before every (re)connect, so
 * agents that change their socket path on restart keep working.
 */

import { execFile, spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
const STARTUP_GRACE_MS = 1200;
const STDERR_LIMIT = 4000;

/** Options that are safe for both forwarding and one-shot commands. */
function sshOptArgs(extra) {
  return [
    "-o",
    "BatchMode=yes",
    // Never multiplex: a ~/.ssh/config with ControlMaster auto makes ssh try to
    // create a control socket, which fails in confined launchers
    // ("getsockname failed: Not a socket") and kills the forward.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...extra,
  ];
}

/**
 * Forwarding options. `-N` must NOT be used for the one-shot resolution
 * command, so the two argument sets are kept separate.
 */
function baseSshArgs(extra) {
  return [
    "-N",
    ...sshOptArgs(extra),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

/** Bind `:0` on loopback to learn a free port, then release it. */
export function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Turn `*.sock` into a regexp (only `*` and `?` are special). */
export function patternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/**
 * Resolve a wildcard socket path on the remote host by listing its directory
 * newest-first. One plain `ls -t <dir>` — no shell operators, so it is safe as
 * a single ssh command argument.
 *
 * @returns {Promise<string>} the newest matching path
 */
export async function resolveSocketPattern({
  sshCommand = "ssh",
  sshArgs = [],
  sshTarget,
  pattern,
  timeoutMs = 15000,
  runner,
} = {}) {
  const slash = String(pattern).lastIndexOf("/");
  if (slash < 0) throw new Error(`remoteSocket wildcard needs a directory: ${pattern}`);
  const dir = pattern.slice(0, slash);
  const filePattern = pattern.slice(slash + 1);
  const execute = runner ?? ((command, args, options) => run(command, args, options));
  const { stdout } = await execute(sshCommand, [...sshArgs, sshTarget, `ls -t ${dir}`], {
    input: "",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const names = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matcher = patternToRegExp(filePattern);
  const hit = names.find((name) => matcher.test(name));
  if (!hit) throw new Error(`no file matches ${pattern} (saw ${names.length} entries)`);
  return `${dir}/${hit}`;
}

/**
 * Remove a stale socket on the remote side before binding `-R`.
 *
 * sshd refuses to bind an existing path ("remote port forwarding failed for
 * listen path"), and StreamLocalBindUnlink is a *server* option, so the client
 * has to clear the path itself. Failure here is not fatal: the forward attempt
 * that follows reports the real error.
 */
export async function cleanRemotePath({
  sshCommand = "ssh",
  sshArgs = [],
  sshTarget,
  path,
  timeoutMs = 15000,
  runner,
  logger,
} = {}) {
  const execute = runner ?? ((command, args, options) => run(command, args, options));
  try {
    await execute(sshCommand, [...sshArgs, sshTarget, `rm -f ${path}`], {
      input: "",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    logger?.(`[peer-ssh] could not remove stale ${path}: ${err?.message ?? err}`);
    return false;
  }
}
class Forward {
  constructor({ kind, buildLaunch, delayMs, maxDelayMs, logger }) {
    this.kind = kind;
    this.buildLaunch = buildLaunch;
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
    this.logger = logger;
    this.child = null;
    this.timer = null;
    this.stopping = false;
    this.state = { status: "idle", pid: null, restarts: 0, lastError: "", since: null, command: "" };
  }

  start() {
    this.stopping = false;
    void this.#spawnOnce();
  }

  async #spawnOnce() {
    this.state.status = "starting";
    this.state.since = Date.now();
    let launch;
    try {
      launch = await this.buildLaunch();
    } catch (err) {
      this.state.lastError = err?.message ?? String(err);
      this.state.status = "down";
      this.logger?.(`[peer-ssh] ${this.kind} launch failed: ${this.state.lastError}`);
      this.#scheduleRestart();
      return;
    }
    if (this.stopping) return;
    let child;
    try {
      child = spawn(launch.command, launch.args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      this.state.lastError = err?.message ?? String(err);
      this.state.status = "down";
      this.#scheduleRestart();
      return;
    }
    this.child = child;
    this.state.pid = child.pid ?? null;
    this.state.command = `${launch.command} ${launch.args.join(" ")}`;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    const graceTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null) {
        this.state.status = "up";
        this.state.lastError = "";
      }
    }, STARTUP_GRACE_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(graceTimer);
      this.child = null;
      this.state.pid = null;
      if (this.stopping) {
        this.state.status = "stopped";
        return;
      }
      this.state.status = "down";
      this.state.lastError = (stderr.trim() || `exited code=${code} signal=${signal ?? ""}`).slice(-500);
      this.logger?.(`[peer-ssh] ${this.kind} down: ${this.state.lastError}`);
      this.#scheduleRestart();
    });
    child.once("error", (err) => {
      this.state.lastError = err?.message ?? String(err);
    });
  }

  #scheduleRestart() {
    if (this.stopping) return;
    const attempt = this.state.restarts;
    const delay = Math.min(this.delayMs * 2 ** attempt, this.maxDelayMs);
    this.state.restarts = attempt + 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopping) void this.#spawnOnce();
    }, delay);
    this.timer.unref?.();
  }

  stop() {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.state.status = "stopped";
    this.state.pid = null;
  }
}

/** One remote peer: outbound sender + inbound listener plumbing. */
export class RemoteTransport {
  constructor(remote, options = {}) {
    this.remote = remote;
    this.logger = options.logger;
    this.delayMs = options.restartDelayMs ?? 1000;
    this.maxDelayMs = options.maxRestartDelayMs ?? 30000;
    this.outbound = null;
    this.inbound = null;
    this.resolvedSocket = "";
    this.localPort = remote.localPort ?? 0;
  }

  get isSsh() {
    return this.remote.transport !== "tcp";
  }

  #sshExtra() {
    const extra = [...(this.remote.sshArgs ?? [])];
    if (this.remote.sshTarget.port) extra.push("-p", this.remote.sshTarget.port);
    return extra;
  }

  async #outboundSocket() {
    const configured = this.remote.remoteSocket;
    if (!configured.includes("*")) {
      this.resolvedSocket = configured;
      return configured;
    }
    const resolved = await resolveSocketPattern({
      sshCommand: this.remote.sshCommand,
      sshArgs: sshOptArgs(this.#sshExtra()),
      sshTarget: this.remote.sshTarget.raw,
      pattern: configured,
    });
    this.resolvedSocket = resolved;
    this.logger?.(`[peer-ssh] ${this.remote.name}: resolved ${configured} -> ${resolved}`);
    return resolved;
  }

  start() {
    if (!this.isSsh) return;
    const target = this.remote.sshTarget.raw;
    this.outbound = new Forward({
      kind: `outbound(${this.remote.name})`,
      buildLaunch: async () => {
        const socket = await this.#outboundSocket();
        if (this.localPort === 0) this.localPort = await freePort(this.remote.bindHost);
        return {
          command: this.remote.sshCommand,
          args: [
            ...baseSshArgs(this.#sshExtra()),
            "-L",
            `${this.remote.bindHost}:${this.localPort}:${socket}`,
            target,
          ],
        };
      },
      delayMs: this.delayMs,
      maxDelayMs: this.maxDelayMs,
      logger: this.logger,
    });
    this.inbound = new Forward({
      kind: `inbound(${this.remote.name})`,
      buildLaunch: async () => {
        await cleanRemotePath({
          sshCommand: this.remote.sshCommand,
          sshArgs: sshOptArgs(this.#sshExtra()),
          sshTarget: target,
          path: this.remote.remoteListenPath,
          logger: this.logger,
        });
        return {
          command: this.remote.sshCommand,
          args: [
            ...baseSshArgs(this.#sshExtra()),
            "-R",
            `${this.remote.remoteListenPath}:${this.remote.bindHost}:${this.remote.inboxPort}`,
            target,
          ],
        };
      },
      delayMs: this.delayMs,
      maxDelayMs: this.maxDelayMs,
      logger: this.logger,
    });
    this.outbound.start();
    this.inbound.start();
  }

  stop() {
    this.outbound?.stop();
    this.inbound?.stop();
  }

  snapshot() {
    const map = (f) =>
      f
        ? { status: f.state.status, pid: f.state.pid, restarts: f.state.restarts, lastError: f.state.lastError }
        : { status: this.isSsh ? "idle" : "n/a", pid: null, restarts: 0, lastError: "" };
    return {
      outbound: map(this.outbound),
      inbound: map(this.inbound),
      resolvedSocket: this.resolvedSocket,
      localPort: this.localPort,
    };
  }

  /** Resolves true once both forwards report `up` (ssh only). */
  async waitReady(timeoutMs = 8000) {
    if (!this.isSsh) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = this.snapshot();
      if (snap.outbound.status === "up" && snap.inbound.status === "up") return true;
      if (snap.outbound.status === "down" && snap.inbound.status === "down") return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  /**
   * Deliver one NDJSON line to the remote agent endpoint.
   * @param {string} line
   */
  async send(line) {
    const remote = this.remote;
    const endpoint = this.isSsh
      ? { host: remote.bindHost, port: this.localPort || remote.localPort }
      : { host: remote.remoteHost, port: remote.remotePort };
    await new Promise((resolve, reject) => {
      const socket = connect(endpoint.port, endpoint.host);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`send timeout to ${endpoint.host}:${endpoint.port}`));
      }, 8000);
      socket.once("connect", () => {
        socket.write(line, () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
