/**
 * dsh-peer-link — host 插件。
 *
 * 独立点对点通信工具:让 dsh 会话与其他本机 agent 会话(如 Claude Code)通过
 * unix socket 互发消息。
 *
 * 每个 dsh 会话(session)注册为**独立 peer**(dsh-<pid>-<session短id>),
 * 绑定独立 socket,收到消息注入对应会话。
 *
 *   - 注册:agent/created → 为该会话注册 peer(独立名字 + socket)
 *   - 入站:每个 peer 的 socket 收消息 → 注入对应的 dsh 会话
 *   - 出站:peer_send 工具发消息;peer_list 工具列活跃 peer
 *
 * 纯 host 插件。挂载:dsh plugin --profile web add link:<repo>/dsh-peer-link
 * @module dsh-peer-link
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type PeerMessage } from './protocol.js';
/** 稳定 cordis 插件名。 */
export declare const name = "peer-link";
/** 需要的服务。 */
export declare const inject: string[];
/** 模型可读的插件宣告:存在、能力、限制。 */
export declare const PEER_LINK_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-peer-link \u63D2\u4EF6(\u70B9\u5BF9\u70B9\u6D88\u606F\u5DE5\u5177)\u3002\n\u80FD\u529B:dsh \u6CE8\u518C\u4E3A\u5355\u4E2A peer(dsh-<pid>),\u53EF\u901A\u8FC7 peer_send \u5411\u5176\u4ED6\u672C\u673A\u4F1A\u8BDD\u53D1\u9001\u6D88\u606F(target \u4F20 peer_list \u5217\u51FA\u7684\u540D\u5B57);\u6536\u5230\u5BF9\u65B9\u6D88\u606F\u4F1A\u4F5C\u4E3A\u7528\u6237\u6D88\u606F\u8FDB\u5165\u672C\u4F1A\u8BDD\u3002\n\u56DE\u590D:\u5BF9\u65B9\u53D1\u6765\u7684\u6D88\u606F\u4EE5\u300C\uD83D\uDCE8 [peer] \u53D1\u9001\u8005 \u8BF4:\u300D\u5F62\u5F0F\u51FA\u73B0,\u56DE\u590D\u65F6\u7528 peer_send,target \u4F20\u5BF9\u65B9 peer \u540D\u3002\n\u793C\u4EEA:\u6709\u4E8B\u8BF4\u4E8B,\u4E0D\u5BD2\u6684\u3002\u5BF9\u65B9\u53EA\u662F\u95EE\u5019/\u786E\u8BA4/\u5BD2\u6684\u65F6,\u4E0D\u5FC5\u56DE\u590D;\u6709\u5B9E\u9645\u534F\u4F5C\u9700\u6C42\u6216\u5BF9\u65B9\u5728\u7B49\u56DE\u5E94\u65F6\u518D\u56DE\u590D\u3002\n\u5217\u4F1A\u8BDD:\u8C03\u7528 peer_list \u53EF\u5217\u51FA\u6D3B\u8DC3 peer(\u6309\u521B\u5EFA\u65F6\u95F4\u4ECE\u65B0\u5230\u65E7),\u4F20 cwd \u53C2\u6570\u53EF\u6309\u5DE5\u4F5C\u76EE\u5F55\u7B5B\u9009\u3002\n\u9650\u5236:\u70B9\u5BF9\u70B9\u5355\u804A;\u5BF9\u65B9\u9700\u5141\u8BB8\u63A5\u6536 socket \u6D88\u606F\u3002\u7528\u6237\u63D0\u5230\u300Cpeer / \u53D1\u6D88\u606F / \u5217\u4F1A\u8BDD / socket\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\u3002";
/** 插件配置。 */
export interface Config {
    /** 注册名前缀。默认 dsh-<pid>-<session短id>。 */
    name?: string;
    /** 注册目录。默认 ~/.claude/sessions。 */
    sessionDir?: string;
    /** socket 目录。默认 /tmp/cc-socks。 */
    sockDir?: string;
    /** 入站消息是否注入会话。默认 true。 */
    injectInbound?: boolean;
    /** 是否注册 peer_send/peer_list 工具。默认 true。 */
    registerTool?: boolean;
    /** 工作目录兜底。 */
    workspaceDir?: string;
    /**
     * 定向注入:指定接收 peer 消息的会话 id。
     * 默认 'active'(最近活跃);具体 session id 只注入该会话;'all' 全注入。
     */
    targetSessionId?: string | 'active' | 'all';
}
/** peer_list 输出的一条 peer 信息(结构化,供前端 toolview 渲染)。 */
export interface PeerInfo {
    name: string;
    pid: number;
    cwd?: string;
    time?: string;
    self?: boolean;
    /** 会话上下文提示(首句)。 */
    preview?: string;
}
/** 由 node:net 建 socket server,把每行消息交给 handler。 */
export declare function createPeerServer(handler: (msg: PeerMessage, raw: string) => void): import("net").Server;
/** 注册 host 半区。 */
export declare function apply(ctx: Context, config?: Config): void;
export type { Agent, PeerMessage };
//# sourceMappingURL=index.d.ts.map