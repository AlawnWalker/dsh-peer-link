/**
 * Peer 注册表:把 dsh 会话注册进 ~/.claude/sessions 注册表,
 * 并扫描注册表发现可投递的活跃 peer。
 *
 *   - 注册:写 ~/.claude/sessions/<pid>.json(peerProtocol:1, kind:interactive, messagingSocketPath)
 *   - 发现:扫注册表目录读所有 *.json
 *
 * @module dsh-peer-link/peer-registry
 */
export declare const SESSION_DIR: string;
export declare const SOCK_DIR = "/tmp/cc-socks";
/**
 * 从 dsh 的 workspace 存储(~/.dsh/storages/workspace.json)读最近更新的 workspace 路径。
 * dsh host 是多会话宿主,没有单一 cwd;用最近活跃的 workspace 作为 peer 注册 cwd 的兜底。
 * 不存在/不可读返回 undefined。
 */
export declare function resolveDshWorkspaceCwd(): Promise<string | undefined>;
/** 一条注册记录。 */
export interface PeerRecord {
    readonly pid: number;
    readonly sessionId: string;
    readonly name: string;
    readonly socketPath: string;
    readonly kind: string;
    readonly peerProtocol: number;
    /** 工作目录(cwd),来自注册文件。 */
    readonly cwd?: string;
    /** 创建时间戳(ms),来自注册文件的 startedAt。 */
    readonly startedAt?: number;
}
/**
 * 写注册文件,让 Claude 能发现本 peer。返回注册文件路径。
 * @param pid - 进程 pid。
 * @param sockPath - socket 路径。
 * @param name - 注册名(如 dsh-<pid> 或 dsh-<pid>-<session短id>)。
 * @param sessionDir - 注册目录。
 * @param cwd - 工作目录。
 * @param sessionId - 会话 id;缺省用 name。
 * @param fileKey - 注册文件名键;缺省用 pid。多个 peer 同进程时需传不同 key 避免覆盖。
 */
export declare function register(pid: number, sockPath: string, name: string, sessionDir?: string, cwd?: string, sessionId?: string, fileKey?: string): Promise<string>;
/** 退出时清理注册文件和 socket。fileKey 对应注册时的 fileKey。 */
export declare function unregister(pid: number, sockPath: string, sessionDir?: string, fileKey?: number | string): Promise<void>;
/**
 * 从注册文件路径解析 pid。
 * 文件名形如 <pid>.json 或 <pid>-<session短id>.json。
 */
export declare function pidOf(regPath: string): number | undefined;
/** 读取一条注册文件,非法/不存在返回 null。 */
export declare function readPeer(regPath: string): Promise<PeerRecord | null>;
/**
 * 探测 peer 的 socket 是否真实可连接(存活)。
 * Claude 探活用空连接;这里只 connect 一下,能连上说明进程在监听。
 */
export declare function isPeerAlive(socketPath: string, timeoutMs?: number): Promise<boolean>;
/**
 * 扫描注册表目录,返回所有可解析**且 socket 存活**的注册记录。
 * 按 startedAt 从新到旧排序;缺 startedAt 的排最后。
 */
export declare function listPeers(sessionDir?: string, aliveOnly?: boolean): Promise<PeerRecord[]>;
/**
 * 从 peer 的 Claude 会话历史(~/.claude/projects/<cwd编码>/<sessionId>.jsonl)
 * 提取一条用户消息,作为会话上下文提示。
 *
 * 策略:先读文件头部找**第一条**用户消息(首句 = 会话主题,最能看懂 peer
 * 在做什么);若头部找不到(如全是系统注入),回退读尾部找**最近一条**用户消息。
 */
export declare function readPeerPreview(rec: PeerRecord): Promise<string | undefined>;
//# sourceMappingURL=peer-registry.d.ts.map