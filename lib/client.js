window.__ModuleLoader__.load({
	id: "dsh-connect-autoclaw",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** 浮层要 portal 到 body：composer 在底部，父级 overflow 会裁掉 fixed/absolute 面板。 */
		let react_dom;
		try {
			react_dom = require("react-dom");
		} catch {
			react_dom = undefined;
		}

		//#region 常量
		/** 宿主半边 registerStatusRoute 的固定路径。 */
		const STATUS_PATH = "/plugins/dsh-connect-autoclaw/status";
		const REFRESH_MS = 120_000;
		/** 只有当前会话选中的 provider 是它时才显示状态框。 */
		const GATE_PROVIDER = "autoclaw";
		const PANEL_WIDTH = 244;
		//#endregion

		//#region 格式化
		const numberFormat = new Intl.NumberFormat("zh-CN");
		/** 与上游 balance_view 一致的缩写（13276 → 1.3w）。 */
		function shortBalance(value) {
			if (!Number.isSafeInteger(value)) return undefined;
			if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, "")}w`;
			return numberFormat.format(value);
		}
		function accountLabel(account) {
			if (account === undefined || account === null) return undefined;
			if (typeof account.displayName === "string" && account.displayName !== "") return account.displayName;
			if (typeof account.phone === "string") return account.phone;
			if (typeof account.email === "string") return account.email;
			if (typeof account.accountId === "string") return account.accountId.slice(0, 12);
			return undefined;
		}
		/** 到期文案去掉与「积分」重复的单位：`2,919积分将于3天内到期` → `2,919 将于3天内到期`。 */
		function expiringLine(text) {
			if (typeof text !== "string") return undefined;
			return text.replace(/^([\d,]+)\s*积分/, "$1 ");
		}
		function clockOf(ms) {
			if (!Number.isFinite(ms)) return undefined;
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		//#endregion

		//#region 选中模型判定
		/**
		 * 读当前会话选中的 provider。
		 *
		 * `useProjection` 是 session 槽位组件的标准 keyed hook
		 * （dsh-client-ui-session 的 BUILTIN_SOURCE：projection → session.projections.faceOf(key)），
		 * `modelSelection` 快照形如 `{ next, lastUsed }`，每项 `{ provider, model, reasoningEffort }`。
		 */
		function selectedProviderOf(useProjection) {
			if (typeof useProjection !== "function") return undefined;
			let selection;
			try {
				selection = useProjection("modelSelection");
			} catch {
				return undefined;
			}
			const model = selection?.next ?? selection?.lastUsed;
			return typeof model?.provider === "string" && model.provider !== "" ? model.provider : undefined;
		}
		//#endregion

		//#region 数据订阅
		/**
		 * 只在**需要显示**时轮询宿主路由。
		 *
		 * 门控不通过时连 fetch 都不启动；页签隐藏时暂停；切回 AutoClaw 时先用上一次快照立即出图。
		 * `refresh()` 带 `?refresh=1` 让宿主绕过自己的快照缓存，且不受页签隐藏限制。
		 */
		function useStatusSnapshot(active) {
			const [snapshot, setSnapshot] = react.useState(undefined);
			const [refreshing, setRefreshing] = react.useState(false);
			const [nonce, setNonce] = react.useState(0);
			const manual = react.useRef(false);

			react.useEffect(() => {
				if (!active) return;
				let live = true;
				const load = async () => {
					const isManual = manual.current === true;
					if (isManual) {
						manual.current = false;
						setRefreshing(true);
					}
					if (!isManual && document.visibilityState === "hidden") return;
					try {
						const response = await fetch(isManual ? `${STATUS_PATH}?refresh=1` : STATUS_PATH, {
							headers: { Accept: "application/json" },
							cache: "no-store",
						});
						if (!response.ok) return;
						const body = await response.json();
						if (live && body !== null && typeof body === "object") setSnapshot(body);
					} catch {
						// 宿主路由暂不可达（插件热重载中）：保留上一个快照。
					} finally {
						if (live && isManual) setRefreshing(false);
					}
				};
				load();
				const interval = setInterval(load, REFRESH_MS);
				const onVisible = () => {
					if (document.visibilityState === "visible") load();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					live = false;
					clearInterval(interval);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [active, nonce]);

			const refresh = react.useCallback(() => {
				if (!active) return;
				manual.current = true;
				setNonce((value) => value + 1);
			}, [active]);

			return { snapshot, refreshing, refresh };
		}
		//#endregion

		//#region 浮层定位
		/** 以触发按钮为锚点，向上弹出（composer 在视口底部，向下没有空间）。 */
		function panelPositionOf(element) {
			if (element === null || element === undefined) return undefined;
			const rect = element.getBoundingClientRect();
			const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8));
			return { left, bottom: Math.max(8, window.innerHeight - rect.top + 6) };
		}
		//#endregion

		//#region 状态框组件
		/**
		 * 模型选择器左侧的 AutoClaw 状态条：默认只是一枚窄按钮 `积分 12,919 ▾`，
		 * 点开才显示账户、余额、到期、更新时间。
		 *
		 * 早先是常显一整行（账户 + 余额 + 到期 + 刷新），在 composer 那行里太长，
		 * 会因为 `standardControls` 是 flex 行而挤压模型选择器、把整行撑高。
		 * 现在触发按钮只有 ~90px，浮层按需出现且 portal 到 body。
		 */
		function AutoClawComposerBox({ useProjection }) {
			const provider = selectedProviderOf(useProjection);
			const active = provider === GATE_PROVIDER;
			const { snapshot, refreshing, refresh } = useStatusSnapshot(active);
			const [open, setOpen] = react.useState(false);
			const [position, setPosition] = react.useState(undefined);
			const triggerRef = react.useRef(null);

			/** 开合与定位：打开时按当前 DOM 位置算一次，滚动/缩放就关掉，不做跟手。 */
			react.useEffect(() => {
				if (!open) return;
				const close = () => setOpen(false);
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", close);
				document.addEventListener("keydown", onKey);
				window.addEventListener("scroll", close, true);
				window.addEventListener("resize", close);
				return () => {
					document.removeEventListener("mousedown", close);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("scroll", close, true);
					window.removeEventListener("resize", close);
				};
			}, [open]);

			if (!active) return null;
			if (snapshot === undefined) return null;

			const account = accountLabel(snapshot.account);
			const wallet = snapshot.wallet;
			const balance = wallet !== undefined && wallet !== null ? wallet.totalBalance : undefined;
			const expiring = wallet !== undefined && wallet !== null ? wallet.expiring : undefined;
			const expiringPoints = expiring !== undefined && expiring !== null ? expiring.points : undefined;
			const expiringText = expiring !== undefined && expiring !== null ? expiringLine(expiring.text) : undefined;
			const updatedAt = clockOf(snapshot.fetchedAt);
			if (account === undefined && balance === undefined) return null;

			const toggle = () => {
				if (open) {
					setOpen(false);
					return;
				}
				setPosition(panelPositionOf(triggerRef.current));
				setOpen(true);
			};

			const triggerTitle = [
				"AutoClaw",
				account,
				Number.isSafeInteger(balance) ? `积分 ${numberFormat.format(balance)}` : undefined,
				typeof expiring?.text === "string" ? expiring.text : undefined,
			].filter((part) => part !== undefined).join(" · ");

			const rows = [];
			if (account !== undefined) rows.push(["账户", account]);
			if (Number.isSafeInteger(balance)) {
				rows.push(["总积分", shortBalance(balance) !== undefined && balance >= 10000
					? `${numberFormat.format(balance)}（${shortBalance(balance)}）`
					: numberFormat.format(balance)]);
			}
			if (typeof expiringText === "string" && expiringPoints > 0) rows.push(["即将到期", expiringText]);
			if (updatedAt !== undefined) rows.push(["更新于", snapshot.stale === true ? `${updatedAt}（缓存）` : updatedAt]);

			const panel = react_jsx_runtime.jsxs("div", {
				style: position === undefined ? { ...S.panel, visibility: "hidden", left: 0, bottom: 0 } : { ...S.panel, left: position.left, bottom: position.bottom },
				role: "dialog",
				"aria-label": "AutoClaw 账户状态",
				onMouseDown: (event) => event.stopPropagation(),
				children: [
					react_jsx_runtime.jsxs("div", { style: S.panelHead, children: [
						react_jsx_runtime.jsx("span", { style: S.panelTitle, children: "AutoClaw" }),
						react_jsx_runtime.jsxs("button", {
							type: "button",
							className: "dsh-connect-autoclaw-refresh",
							"data-spinning": refreshing ? "" : undefined,
							style: S.refresh,
							title: refreshing ? "正在刷新积分…" : "刷新积分",
							"aria-label": "刷新积分",
							disabled: refreshing,
							onMouseDown: (event) => event.preventDefault(),
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								refresh();
							},
							children: [
								react_jsx_runtime.jsx("span", { className: "dsh-connect-autoclaw-refresh-icon", style: S.refreshIcon, children: "⟳" }),
								"刷新",
							],
						}),
					] }),
					react_jsx_runtime.jsx("div", { style: S.panelBody, children: rows.map(([label, value]) => react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsx("span", { style: S.rowLabel, children: label }),
						react_jsx_runtime.jsx("span", { style: S.rowValue, children: value }),
					] }, label)) }),
					react_jsx_runtime.jsx("div", { style: S.panelFoot, children: "智谱奖励积分 · 到期作废后余额相应减少" }),
				],
			});

			return react_jsx_runtime.jsxs(react.Fragment, { children: [
				react_jsx_runtime.jsxs("button", {
					ref: triggerRef,
					type: "button",
					className: "dsh-connect-autoclaw-trigger",
					style: S.box,
					title: triggerTitle,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": "AutoClaw 账户状态",
					onMouseDown: (event) => event.preventDefault(),
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						toggle();
					},
					children: [
						react_jsx_runtime.jsx("span", { style: S.balance, children: Number.isSafeInteger(balance) ? `积分 ${numberFormat.format(balance)}` : "积分" }),
						expiringPoints > 0 ? react_jsx_runtime.jsx("span", { style: S.dotBadge, title: typeof expiring?.text === "string" ? expiring.text : undefined }) : null,
						react_jsx_runtime.jsx("span", { style: S.caret, children: open ? "▴" : "▾" }),
					],
				}),
				open ? (react_dom !== undefined && typeof react_dom.createPortal === "function"
					? react_dom.createPortal(panel, document.body)
					: panel) : null,
			] });
		}
		//#endregion

		//#region 内联样式
		/**
		 * 视觉语言对齐 workbuddy：dsw 设计令牌（--dsw-alias-*、--dsw-specific-menu、
		 * --dsw-radius-lg），深浅色自动跟随，令牌缺失时退中性灰。
		 */
		const S = {
			/** 触发按钮：这一行的宽度是要角，压到 ~90px，且允许被 flex 压缩。 */
			box: {
				appearance: "none",
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				margin: 0,
				padding: "2px 8px",
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				borderRadius: "var(--dsw-radius-lg, 14px)",
				background: "var(--dsw-specific-menu, Canvas)",
				fontSize: "12px",
				lineHeight: "18px",
				color: "var(--dsw-alias-label-secondary, CanvasText)",
				userSelect: "none",
				whiteSpace: "nowrap",
				flex: "0 1 auto",
				minWidth: 0,
				overflow: "hidden",
				cursor: "pointer",
			},
			balance: { flex: "0 1 auto", minWidth: 0, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis" },
			/** 有积分即将到期时的一个小圆点：只提示存在，不占文字宽度。 */
			dotBadge: {
				flex: "none",
				width: "5px",
				height: "5px",
				borderRadius: "50%",
				background: "var(--dsw-alias-label-caution, #d98324)",
			},
			caret: { flex: "none", opacity: 0.55, fontSize: "9px", lineHeight: "18px" },
			panel: {
				position: "fixed",
				zIndex: 1100,
				boxSizing: "border-box",
				width: `${PANEL_WIDTH}px`,
				padding: "10px 12px 8px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				borderRadius: "var(--dsw-radius-lg, 14px)",
				background: "var(--dsw-specific-menu, Canvas)",
				boxShadow: "0 8px 24px rgba(0,0,0,.16)",
				color: "var(--dsw-alias-label-secondary, CanvasText)",
				fontSize: "12px",
				lineHeight: "18px",
			},
			panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" },
			panelTitle: { fontWeight: 600, color: "var(--dsw-alias-label-primary, CanvasText)" },
			panelBody: { display: "grid", gap: "4px" },
			row: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px" },
			rowLabel: { flex: "none", color: "var(--dsw-alias-label-tertiary, CanvasText)" },
			rowValue: {
				flex: "0 1 auto",
				minWidth: 0,
				textAlign: "right",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-label-secondary, CanvasText)",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			panelFoot: {
				marginTop: "8px",
				paddingTop: "6px",
				borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
				fontSize: "11px",
				color: "var(--dsw-alias-label-tertiary, CanvasText)",
			},
			/**
			 * 刷新按钮：早先是 18px 的裸 `⟳`，太小看不见也点不中。现在做成
			 * 带「刷新」文字的胶囊按钮（24px 高、约 62px 宽），命中区一目了然。
			 * 转圈只转图标本身（.refresh-icon），整颗按钮旋转会晃眼；
			 * keyframes 由 ensureAnimation() 注入，内联样式写不了。
			 */
			refresh: {
				appearance: "none",
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				height: "24px",
				padding: "0 10px 0 8px",
				margin: 0,
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				borderRadius: "999px",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, CanvasText)",
				fontSize: "12px",
				lineHeight: "16px",
				fontWeight: 500,
				cursor: "pointer",
				flex: "none",
			},
			refreshIcon: {
				display: "inline-flex",
				fontSize: "13px",
				lineHeight: "16px",
			},
		};
		//#endregion

		//#region 转圈动画
		const ANIMATION_ID = "dsh-connect-autoclaw-animation";
		/**
		 * 内联样式无法声明 `@keyframes`，所以注入一次样式表（按 id 去重）。
		 */
		function ensureAnimation() {
			if (typeof document === "undefined") return;
			if (typeof document.getElementById !== "function" || typeof document.createElement !== "function") return;
			if (document.getElementById(ANIMATION_ID) !== null) return;
			const style = document.createElement("style");
			style.id = ANIMATION_ID;
			style.textContent = "@keyframes dshConnectAutoclawSpin{to{transform:rotate(360deg)}}" +
				".dsh-connect-autoclaw-refresh[data-spinning]{opacity:.65;cursor:progress}" +
				".dsh-connect-autoclaw-refresh[data-spinning] .dsh-connect-autoclaw-refresh-icon{animation:dshConnectAutoclawSpin .9s linear infinite}" +
				/* 悬停 / 展开 / 按下：内联样式写不了伪类，只能靠这张表。 */
				".dsh-connect-autoclaw-trigger{transition:border-color .12s ease,background-color .12s ease}" +
				".dsh-connect-autoclaw-trigger:hover,.dsh-connect-autoclaw-trigger[aria-expanded=\"true\"]{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55));background:var(--dsw-alias-fill-l1,rgba(127,127,127,.08))}" +
				".dsh-connect-autoclaw-refresh{transition:border-color .12s ease,background-color .12s ease,color .12s ease}" +
				".dsh-connect-autoclaw-refresh:hover:not([disabled]){border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55));background:var(--dsw-alias-fill-l1,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,CanvasText)}" +
				".dsh-connect-autoclaw-refresh:active:not([disabled]){background:var(--dsw-alias-fill-l2,rgba(127,127,127,.2))}";
			(document.head ?? document.body)?.appendChild(style);
		}
		//#endregion

		//#region apply：注册槽位
		/**
		 * 客户端入口。**必须声明 `inject = ["slots"]`**：客户端 cordis 与宿主一样，
		 * 未在插件 inject 里声明的服务属性（ctx.slots）会被拒绝访问
		 * （"cannot get property slots without inject"），apply 会整体失败。
		 *
		 * 座椅：`conversation.input.right`（list / session）——渲染在 `standardControls` 行内、
		 * `conversation.input.model` 之前，即**模型选择器的左边**；它是 session 作用域，
		 * 标准 props 带 `useProjection`，门控直读，无需探针。
		 */
		function apply(ctx) {
			ensureAnimation();
			ctx.inject(["slots"], (scope) => {
				try {
					scope.slots.inject("conversation.input.right", () => scope.slots.register({
						name: "conversation.input.right",
						id: "dsh-connect-autoclaw-status",
						order: 10,
						inject: () => ({}),
					}, AutoClawComposerBox));
				} catch (error) {
					console.error("[dsh-connect-autoclaw] composer right slot failed to register (provider unaffected):", error);
				}
			});
		}
		//#endregion

		exports.name = "dsh-connect-autoclaw-client";
		exports.inject = ["slots"];
		exports.apply = apply;
		exports.AutoClawComposerBox = AutoClawComposerBox;
		exports.selectedProviderOf = selectedProviderOf;
		return module.exports;
	}
});
