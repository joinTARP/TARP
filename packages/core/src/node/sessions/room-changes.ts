/** 跨数据库连接的提交通知。只保存唤醒和代数，不缓存文档或网络 patch。 */
const rooms = new Map<string, { generation: number; owners: number; listeners: Set<() => void> }>();

function entry(directory: string) {
  let room = rooms.get(directory);
  if (!room) {
    room = { generation: 0, owners: 0, listeners: new Set() };
    rooms.set(directory, room);
  }
  return room;
}
export function roomGeneration(directory: string) {
  return rooms.get(directory)?.generation ?? 0;
}
export function notifyRoomChanged(directory: string) {
  const room = rooms.get(directory);
  if (!room) return;
  room.generation++;
  for (const listener of room.listeners) listener();
}
function releaseUnused(directory: string) {
  const room = rooms.get(directory);
  if (room && !room.owners && !room.listeners.size) rooms.delete(directory);
}
/** 连接和订阅共同持有代数；没有消费者的房间不保留通知记录。 */
export function retainRoomChanges(directory: string) {
  const room = entry(directory);
  room.owners++;
  return () => {
    room.owners--;
    releaseUnused(directory);
  };
}
export function onRoomChanged(directory: string, listener: () => void) {
  const room = entry(directory);
  room.listeners.add(listener);
  return () => {
    room.listeners.delete(listener);
    releaseUnused(directory);
  };
}
