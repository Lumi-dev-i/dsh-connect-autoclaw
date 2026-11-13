/**
 * 把 DSH 的 provider 中立请求转成 AutoClaw 网关的 OpenAI 兼容 body，
 * 再把网关的 SSE 增量转成 DSH 的 chunk 协议。
 */
import { randomUUID } from "node:crypto";
import { withFingerprint } from "./gateway.js";

/** 从消息块里取纯文本。 */
function textOf(blocks) {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/** 拼装 OpenAI 的 tools 数组。 */
function toolsOf(options) {
  if (!Array.isArray(options.tools) || options.tools.length === 0) return undefined;
  return options.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * 构造网关请求体。
 * @param options - DSH GenerateOptions
 * @param model - 目录条目
 */
export function buildRequestBody(options, model) {
  const messages = [];
  const systemText = typeof options.system === "string" ? options.system : "";
  messages.push({ role: "system", content: withFingerprint(systemText) });

  for (const message of options.messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text.length > 0) messages.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "developer") {
      const text = textOf(message.content);
      if (text.length > 0) messages.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "user") {
      const content = userContent(message.content);
      if (content !== undefined) messages.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const reasoning = message.content
        .filter((block) => block.type === "reasoning")
        .map((block) => block.text)
        .join("");
      const text = textOf(message.content);
      const calls = message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        }));
      if (text.length === 0 && calls.length === 0 && reasoning.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text,
        ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
      });
      continue;
    }
    if (message.role === "tool") {
      const content = textOf(message.content) || JSON.stringify(message.content);
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content });
    }
  }

  const effort = options.reasoningEffort;
  const maxTokens = options.maxTokens ?? model?.maxTokens;
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
    ...(effort === undefined || effort === "off" ? {} : { reasoning_effort: effort }),
    ...(toolsOf(options) === undefined ? {} : { tools: toolsOf(options) }),
  };
}

/** user 消息内容：纯文本发字符串，带图片发 OpenAI 多段结构。 */
function userContent(blocks) {
  const images = blocks.filter((block) => block.type === "image");
  const text = textOf(blocks);
  if (images.length === 0) return text.length === 0 ? undefined : text;
  const parts = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const image of images) {
    const url = imageURLOf(image);
    if (url !== undefined) parts.push({ type: "image_url", image_url: { url } });
  }
  if (parts.length === 0) return undefined;
  return parts;
}

function imageURLOf(block) {
  const data = block.data ?? block.base64 ?? block.source?.data;
  const mediaType = block.mediaType ?? block.mimeType ?? block.source?.media_type ?? "image/png";
  if (typeof data === "string" && data.length > 0) {
    return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
  }
  if (typeof block.url === "string" && block.url.length > 0) return block.url;
  return undefined;
}

/**
 * 网关 SSE → DSH chunk 流。
 *
 * 索引约定：推理块用 0，正文块用 1，工具调用从 2 起按网关给的 index 偏移。
 */
export async function* toChunks(events, { model }) {
  let textIndex;
  let reasoningIndex;
  const toolIndexes = new Map();
  let nextBlock = 0;
  let finishReason = "stop";
  let sawToolCall = false;
  let usage;

  for await (const event of events) {
    const choice = event?.choices?.[0];
    const delta = choice?.delta;
    if (delta !== undefined) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextBlock++;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
        }
        yield { type: "reasoning-delta", index: reasoningIndex, text: reasoning };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textIndex === undefined) {
          textIndex = nextBlock++;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          sawToolCall = true;
          const wire = Number.isInteger(call.index) ? call.index : toolIndexes.size;
          let slot = toolIndexes.get(wire);
          if (slot === undefined) {
            slot = { index: nextBlock++, id: call.id ?? `call-${randomUUID()}` };
            toolIndexes.set(wire, slot);
          } else if (call.id !== undefined && call.id.length > 0) {
            // 网关把 id 放在后续增量时才出现的实现也能对上同一块。
            slot.id = call.id;
          }
          const args = call.function?.arguments;
          const isFirst = slot.arguments === undefined;
          slot.arguments = (slot.arguments ?? "") + (typeof args === "string" ? args : "");
          yield {
            type: "tool-call-delta",
            index: slot.index,
            id: slot.id,
            ...(call.function?.name === undefined ? {} : { name: call.function.name }),
            // 首帧只认领块与名字，正文参数一并给出，避免空帧丢参数。
            argumentsDelta: isFirst ? slot.arguments : typeof args === "string" ? args : "",
          };
        }
      }
    }
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
    if (event?.usage !== undefined && event.usage !== null) usage = event.usage;
  }

  if (usage !== undefined) {
    const inputTokens = Number(usage.prompt_tokens ?? 0) + Number(usage.prompt_cache_miss_tokens ?? 0);
    const outputTokens = Number(usage.completion_tokens ?? 0);
    if (Number.isFinite(inputTokens) || Number.isFinite(outputTokens)) {
      yield {
        type: "usage",
        usage: {
          inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
          outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
          ...(Number.isFinite(Number(usage.prompt_cache_hit_tokens))
            ? { cacheReadTokens: Number(usage.prompt_cache_hit_tokens) }
            : {}),
        },
      };
    }
  }

  const kind =
    sawToolCall || finishReason === "tool_calls"
      ? "tool-calls"
      : finishReason === "length"
        ? "max-tokens"
        : "stop";
  yield { type: "finish", reason: { kind } };
}
