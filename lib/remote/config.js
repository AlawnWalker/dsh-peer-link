/**
 * Config normalisation for dsh-peer-ssh.
 *
 * A "remote" is one agent endpoint on another machine. Two transports:
 *
 *   transport: "ssh"  (default)
 *     outbound: ssh -N -L bindHost:<localPort>:<remoteSocket> <sshTarget>
 *     inbound:  ssh -N -R <remoteListenPath>:<bindHost>:<inboxPort> <sshTarget>
 *
 *   transport: "tcp"
 *     outbound: connect(remoteHost:remotePort)          (agent endpoint over TCP)
 *     inbound:  the same local inbox listener; the peer is expected to reach it
 *               through its own means (tests and LAN setups use this).
 */

export const DEFAULT_CONFIG = Object.freeze({
  bindHost: "127.0.0.1",
  restartDelayMs: 1000,
  maxRestartDelayMs: 30000,
  toolPrefix: "remote_",
  remotes: [],
});

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** Accept `user@host`, bare `host`, or `host:port` (port is passed via -p). */
export function normalizeSshTarget(raw) {
  const target = str(raw);
  if (target === "") return null;
  let host = target;
  let port = "";
  const at = target.lastIndexOf("@");
  const user = at >= 0 ? target.slice(0, at) : "";
  const hostPart = at >= 0 ? target.slice(at + 1) : target;
  const colon = hostPart.lastIndexOf(":");
  if (colon > 0 && !hostPart.startsWith("[")) {
    host = hostPart.slice(0, colon);
    port = hostPart.slice(colon + 1);
  } else {
    host = hostPart;
  }
  if (host === "") return null;
  return { raw: target, user, host, port: port === "" ? "" : String(int(port, 0) || "") };
}

export function normalizeRemote(entry, index, defaults) {
  if (!entry || typeof entry !== "object") return { error: `remotes[${index}] must be an object` };
  const name = str(entry.name) || `remote-${index + 1}`;
  const transport = str(entry.transport) === "tcp" ? "tcp" : "ssh";
  const inboxPort = int(entry.inboxPort, 0);
  if (inboxPort > 65535) return { error: `remotes[${index}] (${name}): inboxPort out of range` };
  const base = {
    name,
    transport,
    peerName: str(entry.peerName) || `dsh-${name}`,
    inboxPort,
    bindHost: str(entry.bindHost) || defaults.bindHost,
    autoRegister: bool(entry.autoRegister, false),
    remoteSessionDir: str(entry.remoteSessionDir) || "~/.claude/sessions",
    sshArgs: Array.isArray(entry.sshArgs) ? entry.sshArgs.map(String) : [],
  };
  if (base.bindHost !== "127.0.0.1" && base.bindHost !== "localhost" && base.bindHost !== "::1") {
    return { error: `remotes[${index}] (${name}): bindHost must be a loopback address` };
  }
  if (transport === "tcp") {
    const host = str(entry.remoteHost);
    const port = int(entry.remotePort, 0);
    if (host === "" || port === 0) {
      return { error: `remotes[${index}] (${name}): remoteHost and remotePort are required for transport=tcp` };
    }
    return { remote: { ...base, remoteHost: host, remotePort: port } };
  }
  const target = normalizeSshTarget(entry.sshTarget);
  if (target === null) return { error: `remotes[${index}] (${name}): sshTarget is required (user@host)` };
  const remoteSocket = str(entry.remoteSocket);
  if (remoteSocket === "") return { error: `remotes[${index}] (${name}): remoteSocket is required` };
  // 0 / omitted = allocate a free local port automatically, so adding a remote
  // never collides with ports already taken by another one.
  const localPort = int(entry.localPort, 0);
  if (localPort !== 0 && localPort > 65535) return { error: `remotes[${index}] (${name}): localPort out of range` };
  const remoteListenPath = str(entry.remoteListenPath);
  if (remoteListenPath === "") return { error: `remotes[${index}] (${name}): remoteListenPath is required` };
  return {
    remote: {
      ...base,
      sshTarget: target,
      remoteSocket,
      localPort,
      remoteListenPath,
      sshCommand: str(entry.sshCommand) || "ssh",
    },
  };
}

/**
 * @returns {{config:object, remotes:object[], errors:string[]}}
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const config = {
    bindHost: str(source.bindHost) || DEFAULT_CONFIG.bindHost,
    restartDelayMs: int(source.restartDelayMs, DEFAULT_CONFIG.restartDelayMs),
    maxRestartDelayMs: int(source.maxRestartDelayMs, DEFAULT_CONFIG.maxRestartDelayMs),
    toolPrefix: typeof source.toolPrefix === "string" ? source.toolPrefix : DEFAULT_CONFIG.toolPrefix,
  };
  const remotes = [];
  const errors = [];
  const list = Array.isArray(source.remotes) ? source.remotes : [];
  const seen = new Set();
  list.forEach((entry, index) => {
    const result = normalizeRemote(entry, index, config);
    if (result.error) {
      errors.push(result.error);
      return;
    }
    if (seen.has(result.remote.name)) {
      errors.push(`remotes[${index}]: duplicate name "${result.remote.name}"`);
      return;
    }
    seen.add(result.remote.name);
    remotes.push(result.remote);
  });
  return { config, remotes, errors };
}

/** The address a remote peer should reply to: the socket `ssh -R` exposes. */
export function replyAddress(remote) {
  if (remote.transport === "tcp") return `tcp:${remote.bindHost}:${remote.inboxPort}`;
  return `uds:${remote.remoteListenPath}`;
}
