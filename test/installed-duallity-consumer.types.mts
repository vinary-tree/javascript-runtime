import {
  configuredWfst,
  type DuallityCacheStatistics,
  type DuallityWfstOptions,
} from "@vinary-tree/duallity/typescript";
import { libdictenstein } from "@vinary-tree/javascript-runtime";

const options: DuallityWfstOptions = {
  kind: "generalized-standard",
  maximumDistance: 1,
  cachePolicy: "lru",
  cacheCapacity: 2,
  operations: [
    { name: "equal", consumeX: 1, consumeY: 1, weight: 0, applicability: "equal" },
  ],
};

const dictionary = libdictenstein.dynamicDawg();
const configured = configuredWfst(dictionary, "cat", options);
const statistics: DuallityCacheStatistics = configured.cacheStatistics;
const misses: bigint = statistics.misses;
configured.clearCache().setCachePolicy("lru", 3);
const effectivePolicy: string = configured.options.cachePolicy;
void [misses, effectivePolicy];
configured.close();
dictionary.close();
