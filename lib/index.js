/**
 * dsh-connect-autoclaw —— 把本机已登录的 AutoClaw2（智谱 GLM 桌面 Agent）
 * 接入 DeepSeek Harness，成为一个可在模型下拉里选择的 LLM provider。
 *
 * 数据流：
 *   DSH agent loop
 *     → ctx.llm.stream({provider:"autoclaw", model:"zai_glm-5.3-flash"})
 *     → AutoClawAdapter.stream()
 *       1. 解密本机 account-credentials.enc 取 autoglm JWT
 *       2. 读 remote-snapshot.json 得模型目录
 *       3. 构造网关签名头与契约要求的 system 消息
 *       4. POST .../autoclaw-proxy/proxy/autoclaw/chat/completions（SSE）
 *       5. SSE → DSH chunk 协议
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { DEFAULT_APP_ID, DEFAULT_APP_KEY, readAutoClawCredentials, readAppVersion } from "./credentials.js";
import { DEFAULT_MODEL, findModel, loadCatalog, toListEntry, toModelInfo } from "./catalog.js";
import { DEFAULT_BASE_URL, GatewayError, openChatStream } from "./gateway.js";
import { buildRequestBody, toChunks } from "./translate.js";
import { StatusService, registerStatusRoute } from "./status.js";

export const name = "dsh-connect-autoclaw";
export const inject = ["llm"];
/** provider 路由 id：模型下拉里的分组就是它。 */
export const PROVIDER = "autoclaw";
const DISPLAY_NAME = "AutoClaw";

function resolveOptions(config) {
  const baseUrl = typeof config?.baseUrl === "string" && config.baseUrl.length > 0
    ? config.baseUrl
    : DEFAULT_BASE_URL;
  return {
    baseUrl,
    appId: typeof config?.appId === "string" && config.appId.length > 0 ? config.appId : DEFAULT_APP_ID,
    appKey: typeof config?.appKey === "string" && config.appKey.length > 0 ? config.appKey : DEFAULT_APP_KEY,
    defaultModel: typeof config?.defaultModel === "string" && config.defaultModel.length > 0
      ? config.defaultModel
      : DEFAULT_MODEL,
    overrideModels: Array.isArray(config?.models) ? config.models : undefined,
  };
}

/** 每次读都重新取凭据与目录，token 刷新 / 重新登录后无需重载插件。 */
class State {
  #options;
  #version;
  #accountDir;
  #models;

  constructor(options) {
    this.#options = options;
    this.#version = readAppVersion();
  }

  get options() {
    return this.#options;
  }

  get version() {
    return this.#version;
  }

  get accountDir() {
    if (this.#accountDir !== undefined) return this.#accountDir;
    try {
      this.#accountDir = readAutoClawCredentials().accountDir;
    } catch {
      return undefined;
    }
    return this.#accountDir;
  }

  invalidate() {
    this.#models = undefined;
    this.#accountDir = undefined;
  }

  models() {
    if (this.#models !== undefined) return this.#models;
    const dir = this.accountDir;
    this.#models = this.#options.overrideModels ?? loadCatalog(dir);
    return this.#models;
  }

  credentials() {
    try {
      return readAutoClawCredentials();
    } catch (error) {
      throw new LlmError(`autoclaw: ${error.message}`, "MISSING_CREDENTIAL");
    }
  }
}

class AutoClawAdapter extends LlmAdapter {
  #state;

  constructor(state) {
    super();
    this.#state = state;
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME };
  }

  async listModels(provider) {
    return this.#state.models().map((model) => toListEntry(provider, model));
  }

  async resolveModel(provider, model) {
    const entry = findModel(this.#state.models(), model);
    if (entry === undefined) {
      throw new LlmError(`autoclaw: 未知模型 "${model}"`, "UNKNOWN_MODEL");
    }
    return toModelInfo(provider, entry);
  }

  stream(options) {
    return this.#generate(options);
  }

  async *#generate(options) {
    const entry = findModel(this.#state.models(), options.model);
    if (entry === undefined) {
      throw new LlmError(`autoclaw: 未知模型 "${options.model}"`, "UNKNOWN_MODEL");
    }
    const credentials = this.#state.credentials();
    const body = buildRequestBody(options, entry);
    let events;
    try {
      events = await openChatStream({
        baseUrl: this.#state.options.baseUrl,
        credentials,
        model: options.model,
        body,
        appId: this.#state.options.appId,
        appKey: this.#state.options.appKey,
        version: this.#state.version,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError("autoclaw: 请求已取消", "ABORTED", { cause: error });
      }
      if (error instanceof GatewayError) {
        const code = error.status === 401 || error.status === 403 ? "UNAUTHORIZED"
          : error.status === 429 ? "RATE_LIMIT"
            : error.status === 406 ? "INVALID_REQUEST"
              : "TRANSPORT";
        throw new LlmError(`autoclaw: ${error.message}`, code, { cause: error });
      }
      throw new LlmError(`autoclaw: 网关请求失败：${error?.message ?? String(error)}`, "TRANSPORT", { cause: error });
    }

    try {
      yield* toChunks(events, { model: options.model });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError("autoclaw: 流式读取已取消", "ABORTED", { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError(`autoclaw: 流式读取失败：${error?.message ?? String(error)}`, "TRANSPORT", { cause: error });
    }
  }
}

export function apply(ctx, config) {
  const options = resolveOptions(config);
  const state = new State(options);

  ctx.llm.registerAdapter([PROVIDER], new AutoClawAdapter(state));

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
    },
  ]);

  let warned;
  const warnOnce = (error) => {
    const text = error?.message ?? String(error);
    if (warned === text) return;
    warned = text;
    ctx.logger?.warn?.(`[dsh-connect-autoclaw] ${text}`);
  };

  ctx.llm.registerModelDiscovery(settingsNs, async () => {
    try {
      return state.models().map((model) => toListEntry(PROVIDER, model));
    } catch (error) {
      warnOnce(error);
      return [];
    }
  });

  // 输入框下方的账户/积分状态行：宿主提供 /plugins/dsh-connect-autoclaw/status，
  // 浏览器半边（lib/client.js）轮询它并渲染。
  const statusService = new StatusService(state, options);
  registerStatusRoute(ctx, statusService);

  ctx.on("loader/volatile-update", () => {
    state.invalidate();
    statusService.invalidate();
  });
}
