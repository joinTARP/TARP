/** 游戏文档业务入口；内部按原始读取、计算投影、工具读取和提交分工。 */
export { stateRevision } from "./state-version";
export { listGameFileRecords, type GameFileRecord } from "./game-file-index";
export { gameInstanceResolver, readStateDocument } from "./game-document-source";
export {
  publicGameDocuments,
  gameDocumentViews,
  readGameDocumentSnapshot,
  forgetGameDocumentViews,
  readGameDocumentView,
} from "./game-document-views";
export { resolveGameReadPath, readGamePath, gameFolderIndex } from "./game-document-read";
export {
  writeGameDocument,
  batchUpdateGameDocuments,
  patchGameDocument,
  materializeCharacter,
  updateGameDocument,
  type GameDocumentUpdate,
} from "./game-document-write";
