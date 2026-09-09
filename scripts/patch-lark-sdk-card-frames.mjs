import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.join(repositoryRoot, "node_modules", "@larksuiteoapi", "node-sdk");
const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));

if (manifest.version !== "1.73.3") {
  throw new Error(`Unsupported @larksuiteoapi/node-sdk version ${manifest.version}; review the card-frame patch`);
}

const oldCondition = "if (type !== MessageType.event) {";
const newCondition = "if (type !== MessageType.event && type !== MessageType.card) {";
let patched = 0;

// Feishu now sends interactive-card callbacks as CARD frames, but SDK 1.73.3
// enumerates that frame type and then silently discards it before dispatch.
for (const relativePath of ["lib/index.js", "es/index.js"]) {
  const filePath = path.join(sdkRoot, relativePath);
  const source = await readFile(filePath, "utf8");
  if (source.includes(newCondition)) continue;

  const occurrences = source.split(oldCondition).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one card-frame guard in ${relativePath}, found ${occurrences}`);
  }
  await writeFile(filePath, source.replace(oldCondition, newCondition), "utf8");
  patched += 1;
}

console.log(patched > 0
  ? "Patched Lark SDK WebSocket card-frame handling."
  : "Lark SDK WebSocket card-frame handling is already patched.");
