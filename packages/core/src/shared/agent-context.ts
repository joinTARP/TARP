/** 本机只读会话快照；分组与内容块均保持 Pi 上下文注入顺序。 */
export interface AgentContextBlock {
  kind: "text" | "thinking" | "tool" | "image";
  title: string;
  text: string;
  imageUrl?: string;
}
export interface AgentContextGroup {
  title: string;
  blocks: AgentContextBlock[];
}
export interface AgentContext {
  readAt: string;
  groups: AgentContextGroup[];
}
