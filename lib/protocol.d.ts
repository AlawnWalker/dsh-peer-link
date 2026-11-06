/**
 * 点对点 socket 消息协议(NDJSON 明文,逐行)。
 *
 * 线格式:
 *   - 投递:{"msgV":1,"msg_id":"...","type":"user",
 *             "message":{"role":"user","content":"<cross-session-message from=... from-name=...>文本</cross-session-message>"},
 *             "priority":"next","from":"uds:/tmp/cc-socks/xxx.sock"}
 *   - 回复:构造 {"type":"user","message":{"role":"user","content":"..."},"from":对方地址}
 * @module dsh-peer-link/protocol
 */
/** 一条入站消息。 */
export interface PeerMessage {
    /** 原消息 id。 */
    readonly msgId: string;
    /** 原消息的 from(uds:/tmp/cc-socks/xxx.sock),用于回发。 */
    readonly from: string;
    /** 剥掉 <cross-session-message> 包装后的用户可见文本。 */
    readonly text: string;
    /** cross-session-message 的 from-name(对方注册名)。 */
    readonly fromName: string | undefined;
}
/** 解析一行 NDJSON。非法行返回 null。 */
export declare function parsePeerMessage(line: string): PeerMessage | null;
/** 剥掉 <cross-session-message> 包装,返回用户可见文本。 */
export declare function extractText(content: string): string;
/** 取 cross-session-message 的 from-name(对方注册名);无则 undefined。 */
export declare function extractFromName(content: string): string | undefined;
/**
 * 构造回发消息(NDJSON 行)。
 *
 * 注意协议语义:回复消息的 `from` 字段填 `original.from`(原发送方地址),
 * 而不是本方的地址 —— 与投递协议一致(每条消息的 from 是发送方)。
 * connect 目标是 `original.from` 去掉 `uds:` 前缀(见 buildPeerMessage 的调用方)。
 */
export declare function buildReply(original: PeerMessage, text: string): string;
/** 目标 socket 地址(去掉 uds: 前缀);非 uds: 返回 null。 */
export declare function udsPathOf(from: string): string | null;
//# sourceMappingURL=protocol.d.ts.map