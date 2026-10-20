import type { ChatService } from "@tarp/core/node";
import { deleteSession, setSessionStatus } from "@tarp/core/node/sessions/session-store";

/** 本地冒险状态、运行连接与资料窗口的关闭顺序由宿主统一协调。 */
export class LocalSessionLifecycle {
  constructor(
    private readonly root: string,
    private readonly chat: Pick<ChatService, "closeRoom">,
    private readonly closeReference: (roomId: string) => void,
  ) {}

  async end(roomId: string) {
    const room = await setSessionStatus(this.root, roomId, "ended");
    try {
      await this.chat.closeRoom(roomId);
    } finally {
      this.closeReference(roomId);
    }
    return room;
  }

  reopen(roomId: string) {
    return setSessionStatus(this.root, roomId, "active");
  }

  async remove(roomId: string) {
    try {
      await this.chat.closeRoom(roomId);
    } finally {
      this.closeReference(roomId);
    }
    await deleteSession(this.root, roomId);
  }
}
