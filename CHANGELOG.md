# Changelog

所有显著变更记录在本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-14

### Added
- 账户 / 积分状态条：模型选择器左侧窄按钮，点开浮层显示账户、总积分、即将到期、更新时间。
- 浮层内 `⟳ 刷新` 按钮，支持强制刷新（绕过宿主 60s 快照缓存）。
- 状态条只在当前会话选中 AutoClaw 模型时出现；门控关闭时不发起任何网络请求。
- 宿主状态路由支持 `?refresh=1` 强制绕过缓存。

### Changed
- 状态条从常显整行收敛为「点开才看」的浮层，不再挤压输入区控件。

### Fixed
- 修复模块装载契约与槽位注册的若干问题。
- 修复积分接口的会话失效误报。

## [0.2.0] - 2026-11-14

### Added
- AutoClaw 作为 DSH LLM provider：模型目录、对话补全（OpenAI SSE）、工具调用。
- 宿主状态路由 `/plugins/dsh-connect-autoclaw/status`（Host + Origin 回环校验）。
