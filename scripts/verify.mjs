/**
 * 对着真实 DSH LlmRuntime 内核验证插件：注册、目录、模型信息、流式对话、工具调用。
 *
 * 依赖 DSH profile 里已安装的 @deepseek-ai/dsh-llm 与 dsh-connect-autoclaw，
 * 用法：node scripts/verify.mjs [--tools]
 */
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { BlockAssembler } from "@deepseek-ai/dsh-llm";
import * as plugin from "dsh-connect-autoclaw";

/** 与 cordis-plugin-loader 的 unwrapExports 完全一致：模块若带 default，会被整体替换成 default。 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}


const ctx = new Context();
ctx.plugin(LlmRuntime);
await new Promise((r) => setTimeout(r, 50));
ctx.plugin(unwrapExports(plugin), {});
await new Promise((r) => setTimeout(r, 200));
const llm = ctx.get("llm");

console.log("providers:", JSON.stringify(llm.listProviders()));
console.log("listModels:", (await llm.listModels("autoclaw")).map((m) => m.id).join(", "));
const info = await llm.resolveModelInfo("autoclaw", "zai_glm-5.3-flash");
console.log("resolveModelInfo:", info.name, info.context?.contextWindow, "efforts:", info.reasoning?.efforts.map((e) => e.id).join("/"));
console.log("resolveCallConfig:", JSON.stringify(await llm.resolveCallConfig({ provider: "autoclaw", model: "zai_glm-5.3-flash" })));

const asm = new BlockAssembler();
let finish;
let usage;
const request = {
  provider: "autoclaw",
  model: "zai_glm-5.3-flash",
  system: "用中文回答，最多一句话。",
  messages: [{ role: "user", content: [{ type: "text", text: "用一句话说明你是谁。" }] }],
  reasoningEffort: "low",
  maxTokens: 512,
};
if (process.argv.includes("--tools")) {
  request.messages = [{ role: "user", content: [{ type: "text", text: "查一下北京天气。" }] }];
  request.tools = [{ name: "weather", description: "查询城市天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
}
for await (const chunk of llm.stream(request)) {
  asm.push(chunk);
  if (chunk.type === "finish") finish = chunk.reason;
  if (chunk.type === "usage") usage = chunk.usage;
}
console.log("finish:", JSON.stringify(finish), "usage:", JSON.stringify(usage));
console.log("blocks:", JSON.stringify(asm.blocks().map((b) => (b.type === "tool-call" ? { type: b.type, name: b.name, arguments: b.arguments } : { type: b.type, text: (b.text ?? "").slice(0, 120) }))));
