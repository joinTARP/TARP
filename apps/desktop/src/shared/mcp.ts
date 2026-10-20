/** 设置页只读取服务状态；连接令牌始终留在主进程。 */
export interface McpStatus {
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "stopping" | "error";
  url: string | null;
  lastRequestAt: string | null;
  error: string | null;
}
