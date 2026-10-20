import { z } from "zod";

/** 本机可选的幕后详情，与公开聊天协议隔离。 */
export const agentDetailSchema = z.object({
  id: z.string(),
  kind: z.enum(["thinking", "tool"]),
  text: z.string(),
  status: z.enum(["running", "complete", "failed"]),
  /** 工具调用参数的 JSON 文本；思考记录没有此字段。 */
  arguments: z.string().optional(),
  /** 工具成功时返回给模型的正文。失败调用没有此字段。 */
  result: z.string().optional(),
  /** 工具失败时返回给模型的错误文本。成功调用没有此字段。 */
  error: z.string().optional(),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

export const roomDisplaySettingsSchema = z.object({
  showReasoning: z.boolean().default(false),
  showAllDocuments: z.boolean().default(false),
});
