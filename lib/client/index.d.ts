/**
 * dsh-peer-link — 浏览器半区。
 *
 * 注册 peer_list 工具的交互式 toolview:`tool.call.toolview` keyed slot
 * 的 key 为 'peer_list'。模型调用 peer_list 后,前端渲染成可点击的 peer 卡片列表。
 *
 * 通过 register 的 inject 工厂把 connection 的 api + sessions 的当前会话
 * 封装成 onSend 传给组件:点击 peer 弹窗输入消息后,注入一条消息到当前会话,
 * 让模型用 peer_send 转发给对方。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** 需要的 client 服务。 */
export declare const inject: string[];
/**
 * 注册 peer_list 的自定义 toolview。
 * @param ctx - client root context。
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map