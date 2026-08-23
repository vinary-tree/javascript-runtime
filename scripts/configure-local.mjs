import { componentRoots, writeLocalCargoConfig } from "./local-layout.mjs";

const path = writeLocalCargoConfig();
console.log(`wrote development-only Cargo overlay: ${path}`);
for (const [component, root] of Object.entries(componentRoots)) {
  console.log(`${component}: ${root}`);
}
