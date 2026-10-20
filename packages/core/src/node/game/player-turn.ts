function attr(value: string) {
  return value.replaceAll('"', "'").replaceAll("\n", " ");
}

export interface PlayerTurn {
  text: string;
  playerId: string;
  characterName?: string;
}

/** 一条玩家发言。多人时按顺序拼成多块，正文保持原样。 */
function playerTurnMessage(input: PlayerTurn) {
  const character = input.characterName ? ` character="${attr(input.characterName)}"` : "";
  return `<message${character} playerId="${attr(input.playerId)}">\n${input.text}\n</message>`;
}

export function playerTurnPrompt(turns: readonly PlayerTurn[]) {
  return turns.map(playerTurnMessage).join("\n");
}
