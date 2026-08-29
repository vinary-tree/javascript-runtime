import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const referencePath = join(root, "docs", "api-reference.md");
const reference = readFileSync(referencePath, "utf8");
const read = (relative) => readFileSync(join(root, relative), "utf8");

const requiredHeadings = [
  "Terms",
  "Installation and runtime selection",
  "Common usage",
  "Type model",
  "Dictionary API",
  "Liblevenshtein API",
  "WFST APIs",
  "WASI API",
  "Lifecycle and ownership",
  "Errors",
  "Concurrency and snapshots",
  "Performance",
  "Security and compatibility",
];

for (const heading of requiredHeadings) {
  if (!reference.includes(`## ${heading}`)) {
    throw new Error(`docs/api-reference.md omits required section ${heading}`);
  }
}
if (/\b(?:TODO|TBD|FIXME|STUB)\b/i.test(reference)) {
  throw new Error("docs/api-reference.md contains a documentation placeholder");
}

for (const factory of [
  "liblevenshtein.transducer",
  "liblevenshtein.phoneticPattern",
  "liblevenshtein.llrePattern",
  "liblevenshtein.phoneticRules",
  "llingLlang.vectorWfst",
  "llingLlang.compose",
  "duallity.wfst",
]) {
  if (new RegExp(`using\\s+\\w+\\s*=\\s*${factory.replace(".", "\\.")}`).test(reference)) {
    throw new Error(
      `docs/api-reference.md applies using to ${factory}, which does not implement Symbol.dispose`,
    );
  }
}

function interfaceBodies(declarations) {
  const result = new Map();
  for (const match of declarations.matchAll(/^export interface (\w+)[^{]*\{/gm)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < declarations.length && depth > 0) {
      if (declarations[index] === "{") depth += 1;
      if (declarations[index] === "}") depth -= 1;
      index += 1;
    }
    if (depth !== 0) throw new Error(`unterminated interface ${match[1]}`);
    result.set(match[1], declarations.slice(start, index - 1));
  }
  return result;
}

function declaredMembers(body) {
  const fragments = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if ("{([".includes(character)) depth += 1;
    if ("})]".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      fragments.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fragments.push(current);
  const result = new Set();
  for (const fragment of fragments) {
    const declaration = fragment.trim();
    const symbolMethod = declaration.match(/^\[Symbol\.(\w+)\]\s*\(/);
    const method = declaration.match(/^(\w+)\s*[<(]/);
    const property = declaration.match(/^readonly\s+(\w+)\??:/)
      ?? declaration.match(/^(\w+)\??:/);
    if (symbolMethod) result.add(`[Symbol.${symbolMethod[1]}]`);
    else if (method) result.add(method[1]);
    else if (property) result.add(property[1]);
  }
  return result;
}

const namespaceNames = new Map([
  ["LibdictensteinNamespace", "libdictenstein"],
  ["LiblevenshteinNamespace", "liblevenshtein"],
  ["LlingLlangNamespace", "llingLlang"],
  ["DuallityNamespace", "duallity"],
]);
const requiredSymbols = new Set();
for (const declarationFile of ["index.d.ts", "wasi.d.ts"]) {
  const declarations = read(declarationFile);
  for (const match of declarations.matchAll(
    /^export\s+(?:type|interface|const|function)\s+(\w+)/gm,
  )) {
    requiredSymbols.add(match[1]);
  }
  for (const [interfaceName, body] of interfaceBodies(declarations)) {
    requiredSymbols.add(interfaceName);
    const owner = namespaceNames.get(interfaceName) ?? interfaceName;
    for (const member of declaredMembers(body)) {
      requiredSymbols.add(member.startsWith("[")
        ? `${owner}${member}`
        : `${owner}.${member}`);
    }
  }
}

const documented = (symbol) => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\\`${escaped}(?:\\\`|[.([])`).test(reference);
};
const missing = [...requiredSymbols]
  .filter((symbol) => !documented(symbol))
  .sort();
if (missing.length > 0) {
  throw new Error(
    `docs/api-reference.md omits ${missing.length} public declaration(s): ${missing.join(", ")}`,
  );
}

const readme = read("README.md");
if (!readme.includes("docs/api-reference.md")) {
  throw new Error("README.md does not link the complete API reference");
}

console.log(
  `documentation covers ${requiredSymbols.size} exported TypeScript symbols and interface members`,
);
