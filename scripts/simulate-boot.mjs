/**
 * 模拟 DSH 启动的 bundle 装配：读本包的 dsh.bundle.patch，
 * 用 dsh-app-boot 的 applyPatches 语义把 insert 应用到根树，
 * 再把每个条目真正 import + apply 一次，确认 provider 挂上。
 */
import { readFileSync } from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";

/** 与 cordis-plugin-loader 的 unwrapExports 完全一致：模块若带 default，会被整体替换成 default。 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}


const root = process.argv[2] ?? ".";
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const patchText = readFileSync(`${root}/cordis.patch.yml`, "utf8");

// 极简解析：只认 `- insert:` 下的 `- id:/name:` 列表
const entries = [...patchText.matchAll(/^\s*- id:\s*(\S+)\s*\n\s*name:\s*(\S+)\s*$/gm)].map((m) => ({ id: m[1], name: m[2] }));
console.log("bundle patch declares:", JSON.stringify(entries));
if (entries.length === 0) throw new Error("bundle patch 没有声明任何 insert 条目");

const ctx = new Context();
ctx.plugin(LlmRuntime);
await new Promise((r) => setTimeout(r, 50));

for (const entry of entries) {
  const mod = await import(entry.name);
  ctx.plugin(unwrapExports(mod), {});
  console.log("mounted:", entry.id);
}
await new Promise((r) => setTimeout(r, 200));

const llm = ctx.get("llm");
const providers = llm.listProviders();
console.log("providers after boot:", JSON.stringify(providers));
const models = await llm.listModels("autoclaw");
console.log("autoclaw models:", models.map((m) => m.id).join(", "));
if (!providers.some((p) => p.id === "autoclaw") || models.length === 0) throw new Error("provider 未正确挂载");
console.log("BOOT SIMULATION OK");
