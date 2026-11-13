# dsh-connect-autoclaw

[![CI](https://github.com/Lumi-dev-i/dsh-connect-autoclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/Lumi-dev-i/dsh-connect-autoclaw/actions/workflows/ci.yml)
[![Release](https://github.com/Lumi-dev-i/dsh-connect-autoclaw/actions/workflows/release.yml/badge.svg)](https://github.com/Lumi-dev-i/dsh-connect-autoclaw/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把本机已登录的 **AutoClaw2**（智谱 GLM 桌面 Agent）变成 **DeepSeek Harness（DSH）** 里一个可在模型下拉中选择的 LLM provider，并附赠一枚「模型选择器左侧」的账户积分状态条。

复用 AutoClaw 自己的本机登录与模型网关：**不需要额外登录、不需要 API Key、token 不出宿主进程**。

## 特性

- **零配置 provider**：装上即用，模型下拉多出 AutoClaw 组（5 个模型，含 1M 上下文的 GLM-5.3-Flash）
- **完整对话**：流式回复、推理档位（low/high/max）、工具调用、token 用量统计
- **账户积分状态条**：只在选中 AutoClaw 时出现，点开浮层看账户 / 余额 / 到期 / 更新时间，支持手动刷新
- **安全设计**：上游请求全部在宿主进程完成，浏览器只拿到脱敏后的 JSON；状态路由有回环校验
- **零依赖**：纯 ESM，`lib/` 由 `src/` 直接拷贝，无打包步骤

## 装好后的效果

模型下拉里多出一组 **AutoClaw**：

| 模型 id | 显示名 | 上下文 | 最大输出 | 输入 | 推理档位 |
|---|---|---|---|---|---|
| `zai_glm-5.3-flash` | GLM-5.3-Flash | 1,048,576 | 131,072 | 文本+图片 | low / high / max |
| `zai_auto` | Auto | 1,048,576 | 393,216 | 文本+图片 | low / high / max |
| `zai_auto-fast` | Auto-Fast | 1,048,576 | 131,072 | 文本+图片 | low / high / max |
| `zaicoding_glm-5.3` | GLM-5.3 | 307,200 | 307,200 | 文本 | low / high / max |
| `zai_glm-5.3-flashx-legal` | GLM-5.3-FlashX-Legal | 204,800 | 131,072 | 文本+图片 | low / high / max |

> `zaicoding_glm-5.3` 需要连续包月会员；日常用 `zai_glm-5.3-flash`（免费档）。

### 账户 / 积分状态条

选中 AutoClaw 模型时，模型选择器左侧出现一枚窄按钮：

```
[ 积分 11,938 • ▾ ]        ← 收起态，约 90px；小圆点 = 有积分即将到期
```

点开是浮层：

```
AutoClaw                      ⟳ 刷新
账户        192****1402
总积分      11,938（1.2w）
即将到期    1,938 将于3天内到期
更新于      04:31:07
──────────────────────────────
智谱奖励积分 · 到期作废后余额相应减少
```

- 门控直读会话的模型选择：切到其它 provider 立即消失，且**不发任何请求**
- 注册在已有控件行内，不占额外高度
- 每 2 分钟自动刷新（页签隐藏时暂停）；`⟳ 刷新` 立即重读
- 任何失败安静降级（保留旧值并标「缓存」），绝不打扰输入区

## 安装

### 方式一：下载 Release 包（推荐）

从 [Releases](https://github.com/Lumi-dev-i/dsh-connect-autoclaw/releases) 下载 `dsh-connect-autoclaw-<version>.tgz`，然后：

```bash
cd ~/.dsh/profiles/desktop

# 1. 解包到 profile 的 node_modules
npm install --prefix . ~/Downloads/dsh-connect-autoclaw-0.3.0.tgz

# 2. 确认 package.json 里：
#    "dsh.profile.bundles": [..., "dsh-connect-autoclaw"]
#    "dependencies": { "dsh-connect-autoclaw": "file:./node_modules/dsh-connect-autoclaw" }
#    （npm install 会自动加 dependencies；bundles 数组需手动确认）

# 3. 重启 DeepSeek Harness
```

### 方式二：从源码安装

```bash
git clone https://github.com/Lumi-dev-i/dsh-connect-autoclaw.git
cd dsh-connect-autoclaw
node scripts/build.mjs                     # src/ → lib/
cp -R . ~/.dsh/profiles/desktop/node_modules/dsh-connect-autoclaw
```

然后在 `~/.dsh/profiles/desktop/package.json` 里：

- `dsh.profile.bundles` 数组追加 `"dsh-connect-autoclaw"`
- `dependencies` 追加 `"dsh-connect-autoclaw": "file:./node_modules/dsh-connect-autoclaw"`

重启 DeepSeek Harness 生效。

## 验收

1. 模型下拉 → 出现 **AutoClaw** 组，含 5 个模型
2. 选 `zai_glm-5.3-flash` 发一句话 → 流式回复正常
3. 带工具的请求（读文件、跑命令）→ 工具调用正常
4. 选中 AutoClaw 时模型选择器左侧出现积分状态条；切走再切回来，状态条消失又出现

命令行自检（不依赖 GUI）：

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-connect-autoclaw
node scripts/verify.mjs            # 真实 LlmRuntime 对话
node scripts/verify.mjs --tools    # 工具调用
```

## 卸载

```bash
cd ~/.dsh/profiles/desktop
# 1. package.json：从 dsh.profile.bundles 和 dependencies 删掉 dsh-connect-autoclaw
# 2. rm -rf node_modules/dsh-connect-autoclaw
# 3. 重启 DeepSeek Harness
```

## 配置

可选配置写在 profile 的 `cordis.patch.yml` 对应条目下：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw` | 网关地址 |
| `appId` / `appKey` | 内置默认值 | 网关签名参数，随客户端版本可能变化 |
| `defaultModel` | `zai_glm-5.3-flash` | 默认模型 |
| `models` | 读快照 | 覆盖模型目录 |

### 与 `dsh-autoclaw` 子代理预设的关系

profile 里的 `preset-autoclaw` + `tool-autoclaw` 是**子代理预设**。本插件提供的是**模型 provider**，两者互补。装好本插件后，把 `tool-autoclaw` 的 `agentOptions` 指到新 provider：

```yaml
agentOptions:
  provider: autoclaw
  model: zai_glm-5.3-flash
```

## 安全与隐私

```
浏览器 状态条
  → GET /plugins/dsh-connect-autoclaw/status        （同源 cookie）
  → 宿主 registerStatusRoute：Host + Origin 均须为本机回环
  → StatusService.snapshot()：调上游 → 60s 缓存
```

- **access token 永不出宿主进程**：浏览器只拿到脱敏 JSON（手机号打码、无 token 字段）
- 状态路由有回环守卫（Host/Origin 校验），非本机来源直接 403
- 本插件不收集、不上传任何数据；所有网络请求都是对智谱官方域名的原生调用

## 前置条件

- macOS + AutoClaw2 已安装并**已登录**（本机存在 AutoClaw 登录凭据）
- DeepSeek Harness（DSH）`0.2.x`+（依赖 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 契约）
- 钥匙串可访问（解锁状态）

## 开发

```bash
git clone https://github.com/Lumi-dev-i/dsh-connect-autoclaw.git
cd dsh-connect-autoclaw
node scripts/build.mjs          # src/ → lib/（纯拷贝，无打包）
node --check lib/client.js      # 语法检查
```

```
src/credentials.js   凭据定位与解密
src/catalog.js       模型目录 → DSH 模型元数据
src/gateway.js       网关客户端（签名头 + SSE + 错误归一）
src/translate.js     DSH 请求 ⇄ OpenAI body，SSE ⇄ DSH chunk
src/status.js        积分状态服务 + 回环校验 + 宿主路由
src/client.js        前端：状态条 + 浮层（槽位注册）
src/index.js         LlmAdapter + apply() 注册
scripts/build.mjs    构建
scripts/verify.mjs   真实 LlmRuntime 端到端自检
```

## 许可

[MIT](LICENSE)。本项目与智谱 / DeepSeek 无隶属关系，仅为个人工具；使用产生的账号风险自负。
