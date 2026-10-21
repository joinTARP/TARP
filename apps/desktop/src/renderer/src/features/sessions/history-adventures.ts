import type { GameRoom } from "@jointarp/core/shared/session";

const endedDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function formatAdventureOn(iso: string) {
  return endedDate.format(new Date(iso));
}

export function formatEndedOn(iso: string) {
  return `${formatAdventureOn(iso)}结束`;
}

export interface EndedAdventureGroup {
  readonly year: string;
  readonly rooms: GameRoom[];
}

export interface AdventureGroups {
  readonly active: GameRoom[];
  readonly ended: EndedAdventureGroup[];
}

/** 进行中的冒险按最近更新排在前面；已结束的按结束时间倒序，再按年份分段。 */
export function groupAdventures(rooms: readonly GameRoom[]): AdventureGroups {
  const active = rooms
    .filter((room) => room.status === "active")
    .sort((a, b) => activityTime(b) - activityTime(a));
  const endedRooms = rooms
    .filter((room) => room.status === "ended")
    .sort((a, b) => activityTime(b) - activityTime(a));
  const ended: EndedAdventureGroup[] = [];
  for (const room of endedRooms) {
    const year = String(new Date(room.endedAt ?? room.updatedAt).getFullYear());
    const last = ended.at(-1);
    if (last?.year === year) last.rooms.push(room);
    else ended.push({ year, rooms: [room] });
  }
  return { active, ended };
}

function activityTime(room: GameRoom) {
  const iso = room.status === "ended" ? (room.endedAt ?? room.updatedAt) : room.updatedAt;
  return new Date(iso).getTime();
}
