import { parseConfig, stringifyConfig } from "@tarp/module/node/config-file";

import type { FileCodec } from "./structured-file";

export { configFilePath } from "@tarp/module/node/config-file";

export const configFileCodec: FileCodec = {
  format: "JSON/TOML",
  decode: parseConfig,
  encode: (value, path) => stringifyConfig(value as Record<string, unknown>, path),
};
