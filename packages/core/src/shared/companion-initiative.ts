import { z } from "zod";

/** 预设档位的提示词会原样写入这名队友的系统提示，自定义档使用队友设置里保存的文本。 */
export const companionInitiativePrompts = {
  reserved: "很少主动开口，仅被直接交谈、轮到自己行动或同伴面临明确危险时回应，其余沉默。",
  natural:
    "场景涉及自身经验或目标、队伍讨论计划、被交谈或有人遇险时可以参与；轮到自己时声明行动。无新贡献则沉默，真人正作重要决定时仅在被点名或必须警告时开口。",
  active:
    "玩家声明行动时，判断是否需要配合、准备或提醒风险，有明确帮助就提交自己的行动；更常对场景、线索和计划表达看法，无新贡献则沉默，不抢答每句话。",
  eager:
    "主动推动冒险：玩家声明行动时可以配合，也可以依据自己的目标提出并提交新的探索、交涉或准备行动；主持裁定后可以继续追查和行动，不必因刚刚发言而退让。只声明意图，不编造结果、不替其他玩家决定；没有值得推进的事情时沉默。",
} as const;

export const companionInitiativeOptions = [
  {
    id: "reserved",
    label: "克制",
    summary: "很少开口，只在被交谈、遇险或自己的行动轮回应。",
  },
  {
    id: "natural",
    label: "自然",
    summary: "场面相关时参与，没有新的贡献就保持沉默。",
  },
  {
    id: "active",
    label: "积极",
    summary: "玩家行动后主动判断配合，补充准备、提醒或自己的行动。",
  },
  {
    id: "eager",
    label: "活跃",
    summary: "主动推动冒险，裁定后可继续行动，不因连续参与而冷却。",
  },
  {
    id: "custom",
    label: "自定义",
    summary: "自行设定队友何时发言、如何参与讨论。",
  },
] as const;

const companionInitiativeLevelSchema = z.enum(["reserved", "natural", "active", "eager", "custom"]);
export const companionInitiativeSchema = z.object({
  level: companionInitiativeLevelSchema.prefault("natural"),
  /** 仅自定义档生效；切换到预设档时保留，便于改回来。 */
  prompt: z.string().trim().max(2000).prefault(""),
});
export type CompanionInitiative = z.infer<typeof companionInitiativeSchema>;
export const defaultCompanionInitiative: CompanionInitiative = { level: "natural", prompt: "" };

export function companionInitiativeText(settings: CompanionInitiative) {
  if (settings.level === "custom")
    return settings.prompt.trim() || companionInitiativePrompts.natural;
  return companionInitiativePrompts[settings.level];
}
