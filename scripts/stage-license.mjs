import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
accessSync(join(runtimeRoot, "LICENSE"), constants.R_OK);
