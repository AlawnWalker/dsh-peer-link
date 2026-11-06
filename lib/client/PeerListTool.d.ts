/**
 * peer_list 工具的交互式 toolview。
 *
 * 当模型调用 peer_list 后,前端把结果渲染成 peer 卡片列表:
 *   - 按创建时间逆序排序
 *   - 每项显示名字、目录(缩写)、pid、本机标记
 *   - 只显示活跃 peer(后端已过滤)
 *   - 点击 peer 弹窗输入消息,发送后引导模型用 peer_send 转发
 *   - 顶部搜索框可快速筛选
 *
 * 仅从已记录的 tool 调用/结果派生(与 ui-skill 的 SkillRow 一致),保证可重放。
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
/** peer_list 工具输出的结构化 peer。 */
export interface PeerEntry {
    name: string;
    pid: number;
    cwd?: string;
    time?: string;
    self?: boolean;
    /** 会话上下文提示(最近一条用户消息)。 */
    preview?: string;
}
/** inject 工厂注入的业务面:onSend(target, text) 发消息,onRefresh() 刷新列表。 */
export interface PeerListInject {
    onSend: (target: string, text: string) => void;
    onRefresh: () => void;
}
/**
 * 渲染 peer 列表卡片(可交互)。
 * @param props - toolview 运行时 props + inject 注入的 onSend。
 */
export declare function PeerListTool(props: ToolCallViewProps & Partial<PeerListInject>): import("react").JSX.Element;
//# sourceMappingURL=PeerListTool.d.ts.map