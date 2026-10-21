import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

import type { GameRoomSummary } from "@jointarp/core/shared/session";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

const homeRooms = { rooms: [] as GameRoomSummary[] };
mock.module("./use-adventure-actions", () => ({
  useAdventureActions: () => ({
    rooms: { data: { rooms: homeRooms.rooms, issues: [] }, isPending: false },
    pendingAction: null,
    setPendingAction: () => {},
    manage: { isPending: false },
    chooseAction: () => {},
  }),
}));
const { HistoryAdventureList } = await import("./HistoryAdventureList");
const { RoomList } = await import("./RoomList");

function room(
  partial: Partial<GameRoomSummary> & Pick<GameRoomSummary, "id" | "name">,
): GameRoomSummary {
  return {
    moduleName: "后山古墓",
    status: "ended",
    createdAt: "2024-01-01T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    endedAt: "2026-09-12T12:00:00.000Z",
    ...partial,
  };
}

async function render(value: ReactNode) {
  const stream = await renderToReadableStream(value);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

async function renderList(
  props: Omit<ComponentProps<typeof HistoryAdventureList>, "onAction">,
  home = false,
) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () =>
      home ? <RoomList /> : <HistoryAdventureList {...props} onAction={() => {}} />,
  });
  const gameRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/game/$roomId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      gameRoute,
      createRoute({ getParentRoute: () => rootRoute, path: "/history", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

test("历史冒险页按状态和年份分组，已结束的冒险按结束时间倒序展示", async () => {
  const filled = await renderList({
    rooms: [
      room({
        id: "old",
        name: "初访营地",
        endedAt: "2024-03-01T12:00:00.000Z",
        updatedAt: "2024-03-01T12:00:00.000Z",
      }),
      room({
        id: "mid",
        name: "春访营地",
        endedAt: "2026-01-02T12:00:00.000Z",
        updatedAt: "2026-01-02T12:00:00.000Z",
      }),
      room({
        id: "live",
        name: "仍在路上",
        status: "active",
        endedAt: undefined,
      }),
      room({ id: "new", name: "夜探古墓", cover: "图片/封面.webp" }),
    ],
    issues: ["存档损坏"],
    error: "读取失败",
  });
  assert.ok(filled.includes("仍在路上"));
  assert.ok(filled.includes("进行中"));
  assert.ok(filled.includes("继续"));
  assert.ok(filled.includes("夜探古墓"));
  assert.ok(
    filled.includes(
      'src="tarp://document/room-module%3Anew?path=&amp;image=%E5%9B%BE%E7%89%87%2F%E5%B0%81%E9%9D%A2.webp"',
    ),
  );
  assert.ok(filled.includes("初访营地"));
  assert.ok(filled.includes("重新开启"));
  assert.ok(filled.includes("2026年9月12日结束"));
  assert.ok(filled.includes("2024"));
  assert.ok(filled.includes("读取失败"));
  assert.ok(filled.includes("存档损坏"));
  const sections = [...filled.matchAll(/<section aria-label="([^"]+)">([\s\S]*?)<\/section>/g)];
  assert.deepEqual(
    sections.map(([, label]) => label),
    ["进行中", "2026年", "2024年"],
  );
  assert.match(sections[0]![2]!, /仍在路上/);
  assert.match(sections[1]![2]!, /夜探古墓[\s\S]*春访营地/);
  assert.match(sections[2]![2]!, /初访营地/);

  const empty = await renderList({ rooms: [], issues: [] });
  assert.ok(empty.includes("还没有冒险"));
  assert.ok(empty.includes("进行中和已结束的冒险都会留在这里"));
});

test("首页房间较多时只展示最近七个冒险，其余通过全部冒险入口查看", async () => {
  homeRooms.rooms = Array.from({ length: 20 }, (_, index) =>
    room({
      id: `active-${index}`,
      name: `进行中房间-${index}`,
      status: "active",
      endedAt: undefined,
      updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }),
  );
  homeRooms.rooms.push(room({ id: "ended", name: "已结束的房间" }));
  const html = await renderList({ rooms: [], issues: [] }, true);
  assert.ok(html.includes("进行中房间-19"));
  assert.ok(html.includes("进行中房间-13"));
  assert.ok(!html.includes("进行中房间-12"));
  assert.equal((html.match(/href="\/game\/active-/g) ?? []).length, 7);
  assert.ok(!html.includes("已结束的房间"));
  assert.ok(!html.includes("搜索进行中的冒险"));
  assert.ok(html.includes("全部冒险"));
  assert.ok(html.includes('href="/history"'));

  homeRooms.rooms = homeRooms.rooms.slice(0, 1);
  const single = await renderList({ rooms: [], issues: [] }, true);
  assert.ok(single.includes("继续冒险"));
  assert.ok(!single.includes("下一页冒险"));
});
