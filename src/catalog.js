/**
 * AutoClaw 托管模型目录 → DSH 模型元数据。
 *
 * 优先读 AutoClaw 自己刷新出来的 remote-snapshot.json；读不到时退回
 * 内置快照，保证插件离线也能出现在模型下拉里。
 */
import { readModelSnapshot } from "./credentials.js";

/** 内置目录快照，作为远端快照缺失时的兜底。 */
export const FALLBACK_MODELS = [
  {
    id: "zai_glm-5.3-flash",
    name: "GLM-5.3-Flash",
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ["text", "image"],
    reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "zai_auto",
    name: "Auto",
    contextWindow: 1048576,
    maxTokens: 393216,
    input: ["text", "image"],
    reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "zai_auto-fast",
    name: "Auto-Fast",
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ["text", "image"],
    reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "zaicoding_glm-5.3",
    name: "GLM-5.3",
    contextWindow: 1048576,
    maxTokens: 307200,
    input: ["text"],
    reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "zai_glm-5.3-flashx-legal",
    name: "GLM-5.3-FlashX-Legal",
    contextWindow: 204800,
    maxTokens: 131072,
    input: ["text", "image"],
    reasoningLevels: ["low", "high", "max"],
  },
];

/** 默认模型：唯一在免费额度内可用的路由。 */
export const DEFAULT_MODEL = "zai_glm-5.3-flash";

const EFFORT_NAMES = { low: "低", high: "高", max: "最高" };

/** 把一个目录条目规范化成内部形状。 */
function normalize(entry) {
  if (entry === null || typeof entry !== "object") return undefined;
  const id = typeof entry.id === "string" ? entry.id : undefined;
  if (id === undefined || id.length === 0) return undefined;
  const levels = Array.isArray(entry.reasoningLevels)
    ? entry.reasoningLevels.filter((level) => typeof level === "string" && level.length > 0)
    : [];
  const rawInput = Array.isArray(entry.input)
    ? entry.input.filter((m) => typeof m === "string" && m.length > 0)
    : ["text"];
  // 模态顺序固定为 text 优先，避免目录字段顺序影响 UI 文案。
  const input = rawInput.includes("text")
    ? ["text", ...rawInput.filter((m) => m !== "text")]
    : rawInput;
  return {
    id,
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
    ...(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0
      ? { contextWindow: entry.contextWindow }
      : {}),
    ...(Number.isInteger(entry.maxTokens) && entry.maxTokens > 0 ? { maxTokens: entry.maxTokens } : {}),
    input: input.length === 0 ? ["text"] : input,
    reasoningLevels: levels,
  };
}

/** 读取当前可用的模型目录。 */
export function loadCatalog(accountDir) {
  const snapshot = accountDir === undefined ? undefined : readModelSnapshot(accountDir);
  const raw = Array.isArray(snapshot?.models) ? snapshot.models : undefined;
  if (raw !== undefined) {
    const models = raw.map(normalize).filter((model) => model !== undefined);
    if (models.length > 0) return models;
  }
  return FALLBACK_MODELS;
}

/** 转成 DSH `llm.listModels` 要求的条目。 */
export function toListEntry(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...(model.input.includes("image") ? { inputModalities: ["text", "image"] } : { inputModalities: ["text"] }),
  };
}

/** 转成 DSH `llm.resolveModel` 要求的条目。 */
export function toModelInfo(provider, model) {
  const efforts = model.reasoningLevels.map((level) => ({
    id: level,
    name: EFFORT_NAMES[level] ?? level,
  }));
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.input,
    ...(model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } }),
    ...(model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens }),
    ...(efforts.length === 0
      ? {}
      : {
          reasoning: {
            efforts,
            defaultEffort: model.reasoningLevels.includes("max")
              ? "max"
              : model.reasoningLevels[model.reasoningLevels.length - 1],
          },
        }),
  };
}

/** 按 id 找目录条目。 */
export function findModel(models, id) {
  return models.find((model) => model.id === id);
}
