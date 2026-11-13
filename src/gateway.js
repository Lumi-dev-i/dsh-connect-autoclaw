/**
 * AutoClaw 模型网关客户端。
 *
 * 端点：POST {baseUrl}/chat/completions（OpenAI 兼容 SSE）。
 * 请求头与 system 消息需满足网关的接入契约（见各常量与 buildGatewayHeaders）。
 */
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_APP_ID, DEFAULT_APP_KEY, readAppVersion } from "./credentials.js";

/** 网关要求 system 消息包含的声明文案（接入契约的一部分）。 */
export const GATEWAY_SYSTEM_FINGERPRINT =
  "You are AutoClaw. Answer the user directly and concisely";

export const DEFAULT_BASE_URL =
  "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";

/** 构造一次请求的完整网关头。 */
export function buildGatewayHeaders({ accessToken, model, appId, appKey, version, sessionId, queryId }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  const sign = createHash("md5").update(`${appId}&${ts}&${appKey}`).digest("hex");
  return {
    "X-Authorization": `Bearer ${accessToken}`,
    "X-Product": "autoclaw",
    "X-Version": version,
    "X-Tm": process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux",
    "X-Auth-Appid": appId,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": sign,
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Trace-Id": requestId,
    "X-Request-Id": requestId,
    "X-Request-Model": model,
    "X-Client-Type": "pc",
    x_trace_id: "autoclaw-desktop",
    "X-Session-Id": sessionId,
    "X-Query-Id": queryId,
    "X-Agent-Id": "main",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/** 把契约要求的声明文案放到 system 消息最前面。 */
export function withFingerprint(systemText) {
  return systemText.length === 0
    ? GATEWAY_SYSTEM_FINGERPRINT
    : `${GATEWAY_SYSTEM_FINGERPRINT}\n\n${systemText}`;
}

/**
 * 发起一次流式对话请求。
 * @returns {Promise<AsyncGenerator<any>>} OpenAI SSE 事件解析器
 */
export async function openChatStream({
  baseUrl = DEFAULT_BASE_URL,
  credentials,
  model,
  body,
  appId = DEFAULT_APP_ID,
  appKey = DEFAULT_APP_KEY,
  version = readAppVersion(),
  signal,
}) {
  const sessionId = randomUUID();
  const headers = buildGatewayHeaders({
    accessToken: credentials.accessToken,
    model,
    appId,
    appKey,
    version,
    sessionId,
    queryId: randomUUID(),
  });
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GatewayError(response.status, text);
  }
  if (response.body === null) throw new GatewayError(response.status, "网关返回了空响应体");
  return parseSse(response.body);
}

export class GatewayError extends Error {
  constructor(status, bodyText) {
    const detail = summarize(bodyText);
    super(`AutoClaw 网关返回 ${status}${detail.length === 0 ? "" : `：${detail}`}`);
    this.name = "GatewayError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function summarize(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = JSON.parse(trimmed);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.msg;
    if (typeof message === "string" && message.length > 0) {
      const code = parsed?.code ?? parsed?.error?.code;
      return code === undefined ? message : `${message}（code=${String(code)}）`;
    }
  } catch {
    /* 非 JSON 错误体直接截断使用 */
  }
  return trimmed.slice(0, 300);
}

/** 把 SSE 字节流解析成 OpenAI 事件对象，遇 [DONE] 结束。 */
async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = readFrame(frame);
      if (event === "done") return;
      if (event !== undefined) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
  const tail = readFrame(buffer);
  if (tail !== undefined && tail !== "done") yield tail;
}

function readFrame(frame) {
  const datas = [];
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    datas.push(line.slice(5).trimStart());
  }
  if (datas.length === 0) return undefined;
  const data = datas.join("\n");
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
