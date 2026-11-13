/**
 * 构建：lib/ 直接是源码的 ESM 拷贝（无打包步骤，DSH 直接跑 node ESM）。
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");
const lib = join(root, "lib");

rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
for (const entry of readdirSync(src)) {
  if (!entry.endsWith(".js")) continue;
  copyFileSync(join(src, entry), join(lib, entry));
}
console.log(`built ${readdirSync(lib).length} files into lib/`);
