/** 仅供测试使用的通用场景定义，不依赖示例模组或游戏规则。每次返回独立数据。 */
export function createWorldStateDefinition(characterType = "角色") {
  return {
    designation: "world_state",
    fields: {
      world_time: { type: "text", mutable: true },
      scenes: {
        type: "list",
        mutable: true,
        required: true,
        item: {
          type: "object",
          fields: {
            id: { type: "text", required: true },
            location: { type: "reference", targets: ["地点"], required: true },
            members: {
              type: "list",
              required: true,
              item: { type: "reference", targets: [characterType] },
            },
            activity: { type: "enum", options: ["探索", "战斗", "休息"], required: true },
            round: { type: "number" },
            turn: { type: "reference", targets: [characterType] },
          },
        },
      },
    },
  };
}
