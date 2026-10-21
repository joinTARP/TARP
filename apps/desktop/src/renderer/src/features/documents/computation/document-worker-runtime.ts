import { DocumentEvaluator } from "@jointarp/module/document-evaluator";

import type { DocumentWorkerRequest, DocumentWorkerResponse } from "./document-worker-protocol";
import { createSESCompiler } from "./ses-compiler";

const evaluator = new DocumentEvaluator(createSESCompiler);
let generation = -1;
let queue = Promise.resolve();
const send = (response: DocumentWorkerResponse) => globalThis.postMessage(response);

/** 串行处理同步与读取，避免异步文档入口在不同版本间交错。 */
globalThis.onmessage = ({ data }: MessageEvent<DocumentWorkerRequest>) => {
  queue = queue.then(async () => {
    const { id, command } = data;
    try {
      let document;
      if (command.op === "sync") {
        if (command.full) evaluator.setSnapshot(command.revision, command.items);
        else evaluator.updateSnapshot(command.revision, command.items, command.removedPaths);
        generation = data.generation;
      } else {
        if (data.generation !== generation) throw new Error("文档资料版本已变化");
        document = await (command.op === "draft"
          ? evaluator.evaluateDocument(command.item)
          : command.op === "name"
            ? evaluator.readDocumentName(command.path)
            : evaluator.readDocument(command.path));
      }
      send({ id, generation: data.generation, document });
    } catch (error) {
      send({
        id,
        generation: data.generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
send({ ready: true });
