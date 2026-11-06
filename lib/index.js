/**
 * dsh-peer-link v0.1.0 — 本地 + 跨机器 统一 peer 通信。
 *
 * 本机部分(原 0.2.0):
 *   - 每个打开着的 dsh 会话注册为独立 peer:`dsh-<会话短id>`,
 *     Windows 命名管道 `\\.\pipe\LOCAL\dsh-<pid>-<短id>`,其它平台 unix socket。
 *   - 入站按端点归属注入对应会话,不需要正文标签。
 *
 * 跨机器部分(合并自 dsh-peer-ssh):
 *   - 每个 remote 是一台机器上的一个 agent 端点。
 *   - 出站:ssh -N -L 本地 TCP → 远端 socket(或直接 TCP)。
 *   - 入站:ssh -N -R 远端 socket → 本地 inbox(TCP,回环),收到后注入本地会话。
 *
 * 工具:peer_list(本地 peers + remotes)、peer_send(目标是本地 peer 名或 remote 名)。
 * @module dsh-peer-link
 */
import { createServer, connect } from 'node:net';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildReply, parsePeerMessage, udsPathOf } from './protocol.js';
import { listPeers, readPeerPreview, register, resolveDshWorkspaceCwd, SESSION_DIR, SOCK_DIR, unregister } from './peer-registry.js';
import { normalizeConfig as normalizeRemoteConfig, replyAddress } from './remote/config.js';
import { createInbox } from './remote/inbox.js';
import { buildMessage } from './remote/protocol.js';
import { RemoteTransport } from './remote/tunnel.js';
import { registerRemotePeer, unregisterRemotePeer } from './remote/register.js';
/** 稳定 cordis 插件名。 */
export const name = 'peer-link';
/** 需要的服务。 */
export const inject = ['agents', 'tools', 'systemPrompt'];
/** system-prompt 段序。 */
const SECTION_ORDER = 150;
/** 模型可读的插件宣告:存在、能力、限制。 */
export const PEER_LINK_GUIDANCE = `本机已安装 dsh-peer-link 插件(点对点消息工具:本地按会话分端点 + 跨机器 SSH 端点)。
本地:每个打开着的 dsh 会话注册为独立 peer,名字形如 dsh-<会话短id>;对方消息按端点直接进入本会话,正文不需要任何标签。
跨机器:配置的每个 remote(如 cc-wsl)代表另一台机器上的一个 agent 端点;peer_send 直接发给 remote 名即可。
回复:对方消息以「📨 [peer] 发送者 说:」出现;用 peer_send 回复,target 传 peer_list 里列出的 peer 名 / remote 名(或管道、socket 路径)。
礼仪:有事说事,不寒暄。对方只是问候/确认/寒暄时,不必回复;有实际协作需求或对方在等回应时再回复。
列会话:peer_list 同时列出本地 peers(cwd 过滤有效)和 remotes(含隧道/inbox 状态)。
限制:本地只有打开着的会话才有端点;remote 需要 SSH 通路可用。失败会显式报错,不会假装成功。`;
/** 由 node:net 建 socket server,把每行消息交给 handler。 */
export function createPeerServer(handler) {
    return createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line === '')
                    continue; // 空行 = 探测
                const msg = parsePeerMessage(line);
                if (msg)
                    handler(msg, line);
                else
                    console.warn('[peer-link] 忽略非 user 消息:', line.slice(0, 100));
            }
        });
        conn.on('error', () => { });
    });
}
/** 注册 host 半区。 */
export function apply(ctx, config) {
    const pid = process.pid;
    const resolvedConfig = config ?? {};
    const sessionDir = resolvedConfig.sessionDir ?? SESSION_DIR;
    const sockDir = resolvedConfig.sockDir ?? SOCK_DIR;
    // 名字前缀保持稳定(不含 pid):dsh-<短id>
    const baseName = resolvedConfig.name ?? 'dsh';
    /** sessionId → endpoint */
    const endpoints = new Map();
    /** 从 session id 派生出短 id。 */
    function shortIdOf(agentId) {
        const raw = String(agentId ?? '').replace(/^session-/, '');
        return /^[0-9a-f-]{20,}$/.test(raw) ? raw.slice(0, 8) : raw;
    }
    /** 端点地址:Windows 命名管道,其它平台 unix socket。 */
    function sockPathFor(shortId) {
        return process.platform === 'win32'
            ? String.raw`\\.\pipe\LOCAL\dsh-${pid}-${shortId}`
            : `${sockDir}/${pid}-${shortId}.sock`;
    }
    function nameFor(shortId) {
        return `${baseName}-${shortId}`;
    }
    /** 注册文件名键(必须匹配 ^\d+(?:-[0-9a-f]+)?\.json$)。 */
    function fileKeyFor(shortId) {
        return `${pid}-${shortId}`;
    }
    function cwdOf(agent) {
        const header = agent?.session ?? {};
        const cwd = header.meta?.cwd ?? header.cwd;
        if (typeof cwd === 'string' && cwd !== '')
            return cwd;
        return resolvedConfig.workspaceDir;
    }
    function agentSeq(agent) {
        const seq = agent?.session?.seq;
        return typeof seq === 'number' ? seq : 0;
    }
    /** 本地会话注入(共享给本地端点与 remote inbox)。 */
    function injectTextToAgent(agent, sender, text, replyHint) {
        const labeled = [
            `📨 [peer] ${sender} 说:`,
            ``,
            String(text ?? '').trim(),
            ``,
            replyHint,
        ].join('\n');
        const message = createUserMessage({
            content: [{ type: 'text', text: labeled }],
            source: { kind: 'user' },
        });
        agent.followup(message);
    }
    // ================= 本地端点 =================
    // ---- 出站:以「发起会话自己的端点」身份发消息 ----
    async function sendAs(sessionId, targetFrom, text, replyToMsgId) {
        const agent = ctx.agents.list().find((a) => a.id === sessionId);
        const endpoint = endpoints.get(sessionId) ?? (agent ? await ensureEndpoint(agent) : undefined);
        const shortId = endpoint?.shortId ?? shortIdOf(sessionId ?? '');
        const fromSock = endpoint?.sockPath ?? sockPathFor(shortId);
        const fromName = endpoint?.name ?? nameFor(shortId);
        const replyContent = [
            `<cross-session-message from="uds:${fromSock}" from-name="${fromName}">`,
            `[会话 ${fromName}]`,
            text.trim(),
            ``,
            `[这是 DSH 会话 "${shortId}" 发给你的消息。回复直接发给 "${fromName}"(或写到 ${fromSock})即可,不需要额外标签。]`,
            `</cross-session-message>`,
        ].join('\n');
        // from 填自己的端点:对端的自环判断拿它和自己的地址比,不会误杀。
        const reply = buildReply({ msgId: replyToMsgId, from: `uds:${fromSock}`, text: replyContent, fromName: undefined }, replyContent);
        const targetPath = udsPathOf(targetFrom) ?? targetFrom;
        await new Promise((resolve, reject) => {
            const out = connect(targetPath);
            const timer = setTimeout(() => {
                out.destroy();
                reject(new Error(`send timeout: ${targetPath}`));
            }, 5000);
            out.on('error', (e) => { clearTimeout(timer); reject(e); });
            out.on('connect', () => {
                out.write(reply, () => { clearTimeout(timer); resolve(); });
                out.end();
            });
        });
    }
    // ---- 入站:消息按端点归属直接注入对应会话 ----
    async function injectInto(endpoint, msg) {
        if (udsPathOf(msg.from) === endpoint.sockPath) {
            console.warn('[peer-link] 忽略来自自身的消息:', msg.text.slice(0, 60));
            return;
        }
        const agent = ctx.agents.list().find((a) => a.id === endpoint.sessionId);
        if (!agent) {
            console.warn(`[peer-link] 会话 ${endpoint.shortId} 已不在,消息丢弃:`, msg.text.slice(0, 80));
            return;
        }
        const sender = msg.fromName ?? await peerDisplayName(msg.from, sessionDir);
        const replyTo = udsPathOf(msg.from) ?? msg.from;
        injectTextToAgent(agent, sender, msg.text, `(回复:peer_send,target 填 "${sender}" 或 "${replyTo}";同名 peer 优先用地址。仅寒暄/确认时无需回复)`);
    }
    // ---- 端点生命周期 ----
    async function ensureEndpoint(agent) {
        const sessionId = agent?.id;
        if (!sessionId)
            return undefined;
        const existing = endpoints.get(sessionId);
        if (existing)
            return existing;
        const shortId = shortIdOf(sessionId);
        const sockPath = sockPathFor(shortId);
        const peerName = nameFor(shortId);
        const fileKey = fileKeyFor(shortId);
        const endpoint = { sessionId, shortId, name: peerName, sockPath, fileKey, server: undefined, cwd: undefined };
        const server = createPeerServer((msg) => {
            if (!(resolvedConfig.injectInbound ?? true))
                return;
            void injectInto(endpoint, msg);
        });
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(sockPath, () => { server.off('error', reject); resolve(); });
            });
        }
        catch (e) {
            console.warn(`[peer-link] 端点监听失败(${peerName} @ ${sockPath}): ${e.message}`);
            try {
                server.close();
            }
            catch { }
            return undefined;
        }
        endpoint.server = server;
        endpoint.cwd = cwdOf(agent) ?? await resolveDshWorkspaceCwd();
        try {
            const regPath = await register(pid, sockPath, peerName, sessionDir, endpoint.cwd, sessionId, fileKey);
            console.log(`[peer-link] ✓ 本地端点就绪 ${peerName} → ${sockPath} (注册 ${regPath})`);
        }
        catch (e) {
            console.warn(`[peer-link] 注册失败 ${peerName}: ${e.message}`);
        }
        endpoints.set(sessionId, endpoint);
        return endpoint;
    }
    async function closeEndpoint(sessionId, why) {
        const endpoint = endpoints.get(sessionId);
        if (!endpoint)
            return;
        endpoints.delete(sessionId);
        try {
            await new Promise((resolve) => endpoint.server.close(() => resolve()));
        }
        catch { }
        try {
            await unregister(pid, endpoint.sockPath, sessionDir, endpoint.fileKey);
        }
        catch (e) {
            console.warn(`[peer-link] 注销失败 ${endpoint.name}: ${e.message}`);
        }
        console.log(`[peer-link] 端点已注销 ${endpoint.name} (${why})`);
    }
    // ================= 跨机器 remotes =================
    const normalizedRemote = normalizeRemoteConfig(resolvedConfig);
    const remoteCfg = normalizedRemote.config;
    const remoteErrors = [...normalizedRemote.errors];
    const remotes = new Map();
    /** remote 入站消息 → 选本地会话:正文带 @dsh-<短id> 精确定位;否则按 targetSessionId。 */
    function pickInboundAgents(agents, text) {
        const match = String(text ?? '').match(/@[\w-]+:([0-9a-f]{6,8})/i);
        if (match) {
            const short = match[1].toLowerCase();
            const hit = agents.find((a) => shortIdOf(a.id).toLowerCase() === short);
            if (hit)
                return [hit];
        }
        const mode = resolvedConfig.targetSessionId ?? 'active';
        if (mode === 'all')
            return [...agents];
        if (mode !== 'active') {
            const hit = agents.find((a) => a.id === mode);
            return hit ? [hit] : [];
        }
        return [...agents].sort((a, b) => agentSeq(b) - agentSeq(a)).slice(0, 1);
    }
    function deliverRemote(entry, message) {
        const agents = ctx.agents.list();
        if (agents.length === 0) {
            entry.state.dropped += 1;
            console.warn(`[peer-link] ${entry.remote.name}: 无活跃会话,入站消息丢弃`);
            return;
        }
        const targets = pickInboundAgents(agents, message.text);
        if (targets.length === 0) {
            entry.state.dropped += 1;
            console.warn(`[peer-link] ${entry.remote.name}: targetSessionId 未命中会话,消息丢弃`);
            return;
        }
        const sender = message.fromName ?? entry.remote.name;
        // 回信给远端:用 remote 自己的应答地址(ssh -R 暴露的 socket)。
        const replyHint = `(回复:peer_send,target 填 "${entry.remote.name}"。仅寒暄/确认时无需回复)`;
        for (const agent of targets) {
            try {
                injectTextToAgent(agent, sender, message.text, replyHint);
                entry.state.injected += 1;
            }
            catch (e) {
                entry.state.dropped += 1;
                console.warn(`[peer-link] ${entry.remote.name}: 注入失败 ${e?.message ?? e}`);
            }
        }
    }
    for (const remote of normalizedRemote.remotes) {
        const entry = { remote, transport: null, inbox: null, state: { injected: 0, dropped: 0 } };
        remotes.set(remote.name, entry);
        entry.transport = new RemoteTransport(remote, {
            logger: (m) => console.log(m),
            restartDelayMs: remoteCfg.restartDelayMs,
            maxRestartDelayMs: remoteCfg.maxRestartDelayMs,
        });
        entry.inbox = createInbox({
            name: remote.name,
            host: remoteCfg.bindHost,
            port: remote.inboxPort,
            onMessage: (message) => deliverRemote(entry, message),
            logger: (m) => console.log(m),
        });
        // inbox 必须先监听:`-R` 需要真实端口(port=0 时由内核分配)。
        Promise.resolve(entry.inbox.start())
            .then((port) => {
            if (typeof port === 'number' && port > 0)
                entry.remote.inboxPort = port;
            try {
                entry.transport.start();
            }
            catch (e) {
                remoteErrors.push(`${remote.name}: transport 启动失败: ${e?.message ?? e}`);
            }
            if (entry.remote.autoRegister) {
                // 把本机 peer 写进远端 ~/.claude/sessions/,让远端 agent 能发现并回信。
                registerRemotePeer({
                    sshArgs: entry.remote.sshArgs,
                    sshTarget: entry.remote.sshTarget.raw,
                    sessionDir: entry.remote.remoteSessionDir,
                    socketPath: entry.remote.remoteListenPath,
                    name: entry.remote.peerName,
                })
                    .then((r) => console.log(`[peer-link] ${remote.name}: 远端注册完成 ${r.path}`))
                    .catch((e) => remoteErrors.push(`${remote.name}: 远端注册失败: ${e?.message ?? e}`));
            }
        })
            .catch((e) => {
            remoteErrors.push(`${remote.name}: inbox 监听失败 ${remoteCfg.bindHost}:${remote.inboxPort}: ${e?.message ?? e}`);
        });
    }
    function remoteSnapshot() {
        return [...remotes.values()].map((entry) => {
            const t = entry.transport?.snapshot?.() ?? { outbound: { status: 'n/a' }, inbound: { status: 'n/a' } };
            const inbox = entry.inbox?.snapshot?.() ?? { listening: false, port: null, received: 0, parsed: 0, dropped: 0 };
            return {
                name: entry.remote.name,
                kind: 'remote',
                transport: entry.remote.transport,
                peerName: entry.remote.peerName,
                replayTo: replyAddress(entry.remote),
                socket: t.resolvedSocket || entry.remote.remoteSocket || '',
                outbound: t.outbound,
                inbound: t.inbound,
                inbox: { listening: inbox.listening, port: inbox.port, received: inbox.received, parsed: inbox.parsed, dropped: inbox.dropped, lastAt: inbox.lastAt, lastError: inbox.lastError },
                injected: entry.state.injected,
                dropped: entry.state.dropped,
            };
        });
    }
    async function remoteSend(remoteName, text, exec) {
        const entry = remotes.get(remoteName);
        if (!entry) {
            const known = [...remotes.keys()].join(', ') || '(none configured)';
            return { sent: false, remote: remoteName, error: `unknown remote; configured: ${known}` };
        }
        const short = shortIdOf(exec?.agent?.id);
        const fromName = short ? `${baseName}-${short}` : baseName;
        const tag = short ? `[会话 @${baseName}-${short}]\n` : '';
        const footer = `\n\n[这是另一台机器上的 DSH 会话通过 SSH 链路发来的消息。回复本会话请写到 ${replyAddress(entry.remote)} 这个 peer 端点。]`;
        const line = buildMessage({
            from: replyAddress(entry.remote),
            fromName,
            text: `${tag}${String(text ?? '').trim()}${footer}`,
        });
        try {
            await entry.transport.send(line);
            return { sent: true, remote: entry.remote.name, to: entry.remote.peerName };
        }
        catch (e) {
            return { sent: false, remote: entry.remote.name, error: e?.message ?? String(e) };
        }
    }
    // ================= 生命周期 =================
    ctx.effect(() => {
        const initial = ctx.agents.list();
        for (const agent of initial)
            void ensureEndpoint(agent);
        console.log(`[peer-link] 初始化:${initial.length} 个本地会话,${remotes.size} 个 remote${remoteErrors.length ? `,${remoteErrors.length} 条配置错误` : ''}`);
        for (const err of remoteErrors)
            console.warn(`[peer-link] remote 配置: ${err}`);
    }, 'peer-link.init');
    ctx.on('agent/created', ({ agent }) => {
        void ensureEndpoint(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => {
        void closeEndpoint(agent.id, 'agent disposed');
    });
    // ================= 工具 =================
    if (resolvedConfig.registerTool ?? true) {
        const peerSend = defineTool({
            name: 'peer_send',
            description: '向另一个会话或另一台机器上的 agent 发送一条消息。' +
                'target 传:peer_list 里的本地 peer 名(如 dsh-5cf25795)、remote 名(如 cc-wsl)、或管道/socket 路径。' +
                '目标不存在或已关闭时返回失败(不会假装成功)。',
            parameters: {
                target: { type: 'string', description: '目标:本地 peer 名 / remote 名 / 管道或 socket 路径' },
                text: { type: 'string', description: '要发送的消息文本' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        sent: { type: 'boolean', required: true },
                        target: { type: 'string' },
                    },
                },
                render: (_args, value) => {
                    if (value.sent) {
                        return textBlocks(value.remote ? `✓ 已发送到 remote ${value.remote}(${value.to})` : `✓ 已发送到 ${value.target}`);
                    }
                    return textBlocks(`✗ 发送失败: ${value.remote ?? value.target}${value.error ? ' — ' + value.error : ''}`);
                },
            },
            execute: async (args, exec) => {
                const target = String(args.target ?? '').trim();
                // 1) remote:显式前缀或直接命中 remote 名
                const remoteName = target.startsWith('remote:') ? target.slice('remote:'.length) : (remotes.has(target) ? target : '');
                if (remoteName) {
                    const result = await remoteSend(remoteName, args.text, exec);
                    return { ...result, target: `remote:${remoteName}` };
                }
                // 2) 本地 peer
                const fromSessionId = exec.agent?.id;
                const livePeers = await listPeers(sessionDir);
                const peer = livePeers.find((p) => p.socketPath === target || p.name === target);
                const isRawPath = target.startsWith('/') || target.startsWith('\\');
                const targetFrom = peer ? `uds:${peer.socketPath}` : (isRawPath ? `uds:${target}` : undefined);
                if (!targetFrom) {
                    const known = [...remotes.keys()].map((n) => `remote:${n}`).join(', ');
                    return { sent: false, target: `unknown target: ${target}${known ? ` (remotes: ${known})` : ''}` };
                }
                const targetPath = udsPathOf(targetFrom) ?? targetFrom;
                for (const ep of endpoints.values()) {
                    if (ep.sockPath === targetPath) {
                        return { sent: false, target: `${targetFrom} (不能发给自己)` };
                    }
                }
                try {
                    await sendAs(fromSessionId ?? '', targetFrom, args.text, '');
                    return { sent: true, target: targetFrom };
                }
                catch (e) {
                    return { sent: false, target: `${targetFrom}: ${e.message}` };
                }
            },
        });
        ctx.effect(() => {
            const dispose = ctx.tools.register(peerSend);
            console.log('[peer-link] ✓ peer_send 已注册(本地 + remote)');
            return () => dispose();
        }, 'peer-link.tool.send');
        const peerList = defineTool({
            name: 'peer_list',
            description: '列出活跃的本地会话(peer)与跨机器 remotes。' +
                '可选参数 cwd:对本地 peers 按工作目录筛选(子串匹配)。当用户问「有哪些会话 / 列 peer / 远端通不通」时使用。',
            parameters: {
                cwd: { type: 'string', description: '按工作目录筛选本地 peers(子串匹配)。空则列出全部。' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        cwd: { type: 'string' },
                        peers: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: true,
                                properties: {
                                    name: { type: 'string', required: true },
                                    pid: { type: 'integer', required: true },
                                    cwd: { type: 'string' },
                                    time: { type: 'string' },
                                    self: { type: 'boolean' },
                                    preview: { type: 'string' },
                                },
                            },
                        },
                        remotes: {
                            type: 'array',
                            items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' } } },
                        },
                    },
                },
                render: (_args, value) => {
                    const lines = [`筛选目录: ${value.cwd || '(全部)'}`];
                    const peers = value.peers ?? [];
                    lines.push(`本地 peers(${peers.length},最新→最旧):`);
                    for (const p of peers) {
                        const tag = p.self ? '(当前会话)' : '';
                        const preview = p.preview ? ` | 最近: ${p.preview}` : '';
                        lines.push(`  - ${p.name} (pid=${p.pid}, ${p.cwd ?? '?'}, ${p.time ?? '?'})${tag}${preview}`);
                    }
                    const remotes = value.remotes ?? [];
                    lines.push('');
                    if (remotes.length === 0) {
                        lines.push('跨机器 remotes: (未配置)');
                    }
                    else {
                        lines.push(`跨机器 remotes(${remotes.length}):`);
                        for (const r of remotes) {
                            const out = r.outbound?.status ?? '?';
                            const inb = r.inbound?.status ?? '?';
                            const inbox = r.inbox?.listening ? `inbox=${r.inbox.port}` : 'inbox=down';
                            const recv = r.inbox?.received ?? 0;
                            lines.push(`  - ${r.name} [${r.transport}] ${out}/${inb} ${inbox} received=${recv} 回复地址=${r.replayTo ?? '?'}`);
                        }
                    }
                    if (value.errors?.length) {
                        lines.push('');
                        lines.push('配置错误:');
                        for (const e of value.errors)
                            lines.push(`  - ${e}`);
                    }
                    return textBlocks(lines.join('\n'));
                },
                presentationMeta: (_args, value) => {
                    return { cwd: value.cwd ?? '', peers: value.peers ?? [], remotes: value.remotes ?? [] };
                },
            },
            execute: async (args, exec) => {
                const filter = (args.cwd ?? '').trim();
                const livePeers = await listPeers(sessionDir);
                const filtered = filter ? livePeers.filter((p) => (p.cwd ?? '').includes(filter)) : livePeers;
                const previews = await Promise.all(filtered.map(async (p) => {
                    try {
                        return await readPeerPreview(p);
                    }
                    catch {
                        return undefined;
                    }
                }));
                const selfSessionId = exec.agent?.id;
                const selfEndpoint = selfSessionId ? endpoints.get(selfSessionId) : undefined;
                const peers = filtered.map((p, i) => {
                    const isSelf = selfEndpoint !== undefined && p.socketPath === selfEndpoint.sockPath;
                    return {
                        name: p.name,
                        pid: p.pid,
                        cwd: p.cwd ?? '',
                        time: p.startedAt ? new Date(p.startedAt).toLocaleString('zh-CN', { hour12: false }) : '',
                        self: isSelf,
                        preview: previews[i] ?? '',
                    };
                });
                return { cwd: filter || '', peers, remotes: remoteSnapshot(), errors: remoteErrors };
            },
        });
        ctx.effect(() => {
            const dispose = ctx.tools.register(peerList);
            console.log('[peer-link] ✓ peer_list 已注册(本地 + remote)');
            return () => dispose();
        }, 'peer-link.tool.list');
        // ---- 兼容 dsh-peer-ssh 的旧工具名(默认关闭;profile 里 legacyRemoteTools: true 打开) ----
        if (resolvedConfig.legacyRemoteTools ?? false) {
            const prefix = resolvedConfig.toolPrefix ?? 'remote_';
            const legacyList = defineTool({
                name: `${prefix}peer_list`,
                description: '兼容 dsh-peer-ssh 的旧工具:只列跨机器 remotes(等同 peer_list 输出的 remotes 部分)。',
                parameters: {},
                output: {
                    schema: { type: 'object', additionalProperties: true },
                    render: (_args, value) => {
                        const list = value?.remotes ?? [];
                        if (list.length === 0)
                            return textBlocks('没有配置任何远端 peer(remotes 为空)。');
                        return textBlocks(list.map((r) => `${r.name}: ${r.outbound?.status ?? '?'}/${r.inbound?.status ?? '?'}` +
                            ` inbox=${r.inbox?.listening ? r.inbox.port : 'down'} received=${r.inbox?.received ?? 0}` +
                            (r.outbound?.lastError ? ` lastError=${String(r.outbound.lastError).split('\n')[0]}` : '')).join('\n'));
                    },
                },
                execute: async () => ({ remotes: remoteSnapshot(), errors: remoteErrors }),
            });
            const legacySend = defineTool({
                name: `${prefix}peer_send`,
                description: '兼容 dsh-peer-ssh 的旧工具:向指定 remote 发消息(等同 peer_send,target 传 remote 名)。',
                parameters: {
                    remote: { type: 'string', description: 'remote 名(见 remote_peer_list)' },
                    text: { type: 'string', description: '消息文本' },
                },
                output: {
                    schema: { type: 'object', additionalProperties: true },
                    render: (_args, value) => textBlocks(value?.sent
                        ? `✓ 已发送到 ${value.remote}(${value.to})`
                        : `✗ 发送失败: ${value?.remote ?? '?'} — ${value?.error ?? 'unknown error'}`),
                },
                execute: async (args, exec) => remoteSend(String(args.remote ?? ''), args.text, exec),
            });
            ctx.effect(() => {
                const disposeList = ctx.tools.register(legacyList);
                const disposeSend = ctx.tools.register(legacySend);
                console.log(`[peer-link] ✓ 兼容工具 ${prefix}peer_list / ${prefix}peer_send 已注册`);
                return () => { disposeList(); disposeSend(); };
            }, 'peer-link.tool.legacy');
        }
    }
    // ================= system prompt =================
    ctx.effect(() => {
        const dispose = ctx.systemPrompt.section({
            name: 'plugin:peer-link',
            order: SECTION_ORDER,
            text: PEER_LINK_GUIDANCE,
        });
        return () => dispose();
    }, 'peer-link.prompt');
    // ================= teardown =================
    ctx.effect(() => {
        return async () => {
            const ids = [...endpoints.keys()];
            for (const id of ids)
                await closeEndpoint(id, 'plugin teardown');
            for (const entry of remotes.values()) {
                try {
                    entry.transport?.stop?.();
                }
                catch { }
                try {
                    await entry.inbox?.stop?.();
                }
                catch { }
                if (entry.remote.autoRegister) {
                    try {
                        await unregisterRemotePeer({
                            sshArgs: entry.remote.sshArgs,
                            sshTarget: entry.remote.sshTarget.raw,
                            sessionDir: entry.remote.remoteSessionDir,
                            name: entry.remote.peerName,
                        });
                    }
                    catch { }
                }
            }
            console.log(`[peer-link] 已清理 ${ids.length} 个本地端点,${remotes.size} 个 remote`);
        };
    }, 'peer-link.teardown');
}
function textBlocks(text) {
    return [{ type: 'text', text }];
}
/**
 * 把 socket 路径转成可读的 peer 名。反查注册表拿真实名字,否则用地址尾段。
 */
async function peerDisplayName(from, sessionDir) {
    const path = udsPathOf(from) ?? from;
    const live = await listPeers(sessionDir, false);
    const rec = live.find((p) => p.socketPath === path);
    if (rec)
        return rec.name;
    const tail = path.split(/[\\/]/).pop() ?? path;
    return tail.replace(/\.sock$/, '') || from;
}
