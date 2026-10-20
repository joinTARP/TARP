import type { AgentDetail } from "../../shared/agent-details";

/** 活动回合保留完整详情；结束后仅保留最近八回合、合计至多 2 MiB 的内存回退。 */
export class RunDetails {
  private runs = new Map<string, Map<string, AgentDetail>>();
  private recent = new Map<string, number>();

  get(messageId: string) {
    return this.runs.get(messageId);
  }
  set(messageId: string, detail: AgentDetail) {
    let details = this.runs.get(messageId);
    if (!details) {
      details = new Map();
      this.runs.set(messageId, details);
    }
    details.set(detail.id, detail);
  }
  finish(messageId: string) {
    const details = this.runs.get(messageId);
    if (!details) return;
    const bytes = Buffer.byteLength(JSON.stringify([...details.values()]));
    this.recent.set(messageId, bytes);
    let total = [...this.recent.values()].reduce((sum, size) => sum + size, 0);
    for (const [id, size] of this.recent) {
      if (this.recent.size <= 8 && total <= 2 * 1024 * 1024) break;
      this.recent.delete(id);
      this.runs.delete(id);
      total -= size;
    }
  }
}
