import { randomBytes, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { writeFileAtomic } from "@jointarp/core/node/storage/write-file-atomic";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { PlaytestService, playtestCreateSchema } from "./playtest";

const roomSchema = z.strictObject({ roomId: z.string().uuid() });

export function createPlaytestMcp(service: PlaytestService) {
  const server = new McpServer({ name: "tarp-playtest", version: "0.1.0" });
  const result = async (operation: () => Promise<object>) => {
    try {
      const value = await operation();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : "预演操作失败" },
        ],
      };
    }
  };
  server.registerTool(
    "playtest_create",
    {
      description:
        "从模组创建隔离的临时 session，应用文档初始值、跳过开局、配置已有 AI 队友，并在客户端打开。background 是所有队友可知的背景；hostBackground 仅供主持。角色必须有模组 AI 队友预设。documents.values 按顶层字段替换，数组整体替换；不能覆盖 computed。",
      inputSchema: playtestCreateSchema,
    },
    (input) => result(() => service.create(input)),
  );
  server.registerTool(
    "playtest_run",
    {
      description:
        "异步驱动已有 AI 队友与主持。每次推进一名队友的决策及至多一次主持裁定；单步用 maxTurns=1。返回后用 inspect 查看真实进度。全员不再提交行动、达到次数、结束或超时即停止。",
      inputSchema: roomSchema.extend({
        maxTurns: z.number().int().min(1).max(100).default(1),
        timeoutSeconds: z.number().int().min(1).max(600).default(180),
      }),
    },
    ({ roomId, maxTurns, timeoutSeconds }) =>
      result(() => service.run(roomId, maxTurns, timeoutSeconds)),
  );
  server.registerTool(
    "playtest_inspect",
    {
      description:
        "读取真实聊天、骰子、文档、活动状态和每步状态快照；默认返回 fixture 指定的文档及队友文档，paths 可选择其他文档。返回开发调试信息，不应原样提供给玩家角色。beforeSequence 用于读取更早的聊天。",
      inputSchema: roomSchema.extend({
        paths: z.array(z.string().min(1)).max(100).optional(),
        beforeSequence: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ roomId, paths, beforeSequence }) =>
      result(() => service.inspect(roomId, paths, beforeSequence)),
  );
  server.registerTool(
    "playtest_pause",
    {
      description: "停止预演循环及当前生成，保留已经保存的状态和聊天。中断的步骤不会自动重试。",
      inputSchema: roomSchema,
    },
    ({ roomId }) => result(() => service.pause(roomId)),
  );
  server.registerTool(
    "playtest_dispose",
    {
      description:
        "停止并删除指定临时预演 session；只接受由 playtest_create 创建的 session。需要保留结果时先调用 inspect。",
      inputSchema: roomSchema,
      annotations: { destructiveHint: true },
    },
    ({ roomId }) => result(() => service.dispose(roomId)),
  );
  return server;
}

/** 由桌面 MCP 生命周期服务启停，凭据只写到私有发现文件。 */
export async function startPlaytestMcp(options: {
  service: PlaytestService;
  directory: string;
  port: number;
  token?: string;
  onRequest?: () => void;
}) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 16) throw new Error("MCP 连接令牌至少需要 16 个字符");
  const clients = new Set<McpServer>();
  let address = "";
  const http = createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(401).end();
        return;
      }
      if (
        request.headers.origin ||
        ![new URL(address).host, `localhost:${new URL(address).port}`].includes(
          request.headers.host ?? "",
        )
      ) {
        response.writeHead(403).end();
        return;
      }
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      options.onRequest?.();
      const server = createPlaytestMcp(options.service);
      clients.add(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        clients.delete(server);
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1", resolve);
  });
  const bound = http.address();
  if (!bound || typeof bound === "string") throw new Error("无法启动 MCP 本地服务");
  address = `http://127.0.0.1:${bound.port}/mcp`;
  const discovery = join(options.directory, "mcp.json");
  try {
    await writeFileAtomic(
      discovery,
      JSON.stringify({ url: address, headers: { Authorization: `Bearer ${token}` } }, null, 2),
      { mode: 0o600 },
    );
  } catch (error) {
    http.closeAllConnections();
    http.close();
    throw error;
  }
  return {
    url: address,
    async close() {
      // 先拒绝新请求，再等待房间取消与一致性收尾。
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      await options.service.close();
      await Promise.allSettled([...clients].map((client) => client.close()));
      http.closeAllConnections();
      await closed;
      await rm(discovery, { force: true });
    },
  };
}
