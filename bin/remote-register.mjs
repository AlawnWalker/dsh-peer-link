#!/usr/bin/env node
/**
 * Write / remove the peer record a remote agent uses to discover this DSH.
 *
 *   dsh-peer-link-register --ssh <user@host> --name dsh-win \
 *       --socket /tmp/dsh-peer.sock [--dir ~/.claude/sessions] [--cwd /]
 *
 *   dsh-peer-link-register ... --remove
 *
 * Run it after the plugin's `ssh -R` forward is up (see <prefix>peer_list), or
 * let the plugin do it by setting `autoRegister: true` for the remote.
 */

import process from "node:process";

import { registerRemotePeer, recordPath, unregisterRemotePeer } from "../lib/remote/register.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(
    [
      "usage: dsh-peer-link-register --ssh <user@host> --name <peer-name> --socket <remote-socket-path>",
      "       [--dir <remote sessions dir>] [--cwd <remote cwd>] [--remove]",
    ].join("\n"),
  );
  process.exit(0);
}

const sshTarget = String(args.ssh ?? args.target ?? "");
const name = String(args.name ?? "");
const socketPath = String(args.socket ?? args.sock ?? "");
const sessionDir = String(args.dir ?? "~/.claude/sessions");
const cwd = String(args.cwd ?? "/");
const remove = Boolean(args.remove);

if (sshTarget === "" || name === "") {
  console.error("ERR: --ssh <user@host> and --name <peer-name> are required (--help for usage)");
  process.exit(2);
}

try {
  if (remove) {
    const result = await unregisterRemotePeer({ sshTarget, sessionDir, name });
    console.log(result.removed ? `removed ${result.path}` : `remove failed: ${result.error ?? "unknown"}`);
  } else {
    if (socketPath === "") {
      console.error("ERR: --socket <remote-socket-path> is required when registering");
      process.exit(2);
    }
    const result = await registerRemotePeer({ sshTarget, sessionDir, socketPath, name, cwd });
    console.log(`registered ${name} -> ${result.path}`);
    console.log(`(expected path by name: ${recordPath(sessionDir, name)})`);
  }
} catch (err) {
  console.error(`ERR: ${err?.message ?? err}`);
  process.exit(1);
}
