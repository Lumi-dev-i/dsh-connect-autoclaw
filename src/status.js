/**
 * AutoClaw 账户与积分状态（宿主半边）。
 *
 * 数据来源：
 *   1. 账户信息：本机 account-profile.json（AutoClaw 登录后落盘）
 *   2. 积分钱包：GET {identityOrigin}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
 *      —— 注意鉴权头是 `Authorization: Bearer <token>`（与 chat 网关的 X-Authorization 不同）
 *   3. 即将到期：GET {identityOrigin}/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw
 *
 * 返回结构：
 *   { code:0, data:{ total_balance, wallets:[{public_wallet_type, display_name,
 *      balance, balance_view, display, priority}] } }
 *   { code:0, data:{ expiring_points, total_points, expire_time_value,
 *      expire_time_type, expiring_points_text } }
 */
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_APP_ID, DEFAULT_APP_KEY, readAppVersion } from "./credentials.js";

/** identity_gateway 服务的网关源站（与 chat 网关同源）。 */
export const IDENTITY_ORIGIN = "https://autoglm-acceleration-api.zhipuai.cn";
const WALLETS_PATH = "/agent-assetmgr/api/v2/wallets";
const EXPIRING_PATH = "/agent-assetmgr/api/v1/points/expiring";
const BIZ_APP_ID = "autoclaw";
/** 积分查询的缓存毫秒数：上游按分钟级变化，60s 足够且省额度。 */
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** 读取本机账户资料；读不到就返回 undefined（不抛错，状态行只显示积分部分）。 */
export function readAccountProfile(accountDir) {
  if (accountDir === undefined) return undefined;
  try {
    const raw = JSON.parse(readFileSync(`${accountDir}/account-profile.json`, "utf8"));
    const profile = raw?.profile;
    if (profile === undefined || profile === null) return undefined;
    return {
      accountId: typeof profile.accountId === "string" ? profile.accountId : undefined,
      displayName: typeof profile.displayName === "string" && profile.displayName.length > 0
        ? profile.displayName
        : undefined,
      phone: typeof profile.phone === "string" ? profile.phone : undefined,
      email: typeof profile.email === "string" && profile.email.length > 0 ? profile.email : undefined,
      numericUserId: Number.isSafeInteger(profile.numericUserId) ? profile.numericUserId : undefined,
      accountType: typeof profile.accountType === "string" ? profile.accountType : undefined,
    };
  } catch {
    return undefined;
  }
}

/** identity_gateway 的请求头：Authorization 才是对的（X-Authorization 会被判未登录）。 */
function identityHeaders({ accessToken, appId, appKey, version }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  return {
    "Authorization": `Bearer ${accessToken}`,
    "X-Auth-Appid": appId,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": createHash("md5").update(`${appId}&${ts}&${appKey}`).digest("hex"),
    "X-Product": "autoclaw",
    "X-Version": version ?? readAppVersion(),
    "X-Tm": "mac",
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Client-Type": "pc",
    "X-Trace-Id": requestId,
    "X-Request-Id": requestId,
    "Accept": "application/json",
  };
}

async function fetchEnvelope(url, headers, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`identity_gateway 响应不是 JSON（HTTP ${response.status}）`);
    }
    if (body?.code !== 0) {
      const message = typeof body?.msg === "string" ? body.msg : `HTTP ${response.status}`;
      throw new Error(`identity_gateway ${message}`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 拉一次钱包快照并归一化；上游失败时抛错，由调用方决定降级。 */
export async function fetchWalletSnapshot({ credentials, appId = DEFAULT_APP_ID, appKey = DEFAULT_APP_KEY, signal }) {
  const headers = identityHeaders({ ...credentials, appId, appKey });
  const query = `?${new URLSearchParams({ biz_app_id: BIZ_APP_ID })}`;
  const [wallets, expiring] = await Promise.all([
    fetchEnvelope(`${IDENTITY_ORIGIN}${WALLETS_PATH}${query}`, headers, signal),
    fetchEnvelope(`${IDENTITY_ORIGIN}${EXPIRING_PATH}${query}`, headers, signal).catch(() => undefined),
  ]);
  const list = Array.isArray(wallets?.wallets) ? wallets.wallets : [];
  return {
    totalBalance: Number.isSafeInteger(wallets?.total_balance) ? wallets.total_balance : undefined,
    wallets: list
      .filter((wallet) => wallet?.display === true)
      .map((wallet) => ({
        type: wallet.public_wallet_type,
        name: wallet.display_name,
        balance: wallet.balance,
        view: wallet.balance_view,
      })),
    expiring: expiring === undefined ? undefined : {
      points: expiring.expiring_points,
      text: expiring.expiring_points_text,
    },
    fetchedAt: Date.now(),
  };
}

/**
 * 带缓存的状态服务。宿主路由每次被浏览器轮询时走这里；
 * 上游失败时回落到缓存旧值并标注 stale，避免页面数字闪烁消失。
 */
export class StatusService {
  #state;
  #options;
  #cache;
  #inflight;

  constructor(state, options) {
    this.#state = state;
    this.#options = options;
  }

  invalidate() {
    this.#cache = undefined;
  }

  async snapshot(signal) {
    const now = Date.now();
    if (this.#cache !== undefined && now - this.#cache.fetchedAt < CACHE_MS) return this.#cache;
    if (this.#inflight !== undefined) return this.#inflight;
    this.#inflight = (async () => {
      try {
        const credentials = this.#state.credentials();
        const wallet = await fetchWalletSnapshot({
          credentials,
          appId: this.#options.appId,
          appKey: this.#options.appKey,
          signal,
        });
        const snapshot = {
          ok: true,
          account: readAccountProfile(this.#state.accountDir),
          wallet,
          fetchedAt: Date.now(),
        };
        this.#cache = snapshot;
        return snapshot;
      } catch (error) {
        if (this.#cache !== undefined) {
          return { ...this.#cache, stale: true, error: error?.message ?? String(error) };
        }
        return {
          ok: false,
          error: error?.message ?? String(error),
          account: readAccountProfile(this.#state.accountDir),
        };
      } finally {
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }
}

// ── 回环防护（与 dsh-connect-workbuddy 的语义一致）────────────────────────

function isIP(value) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return 4;
  if (/^\[[0-9a-fA-F:]+\]$/.test(value)) return 6;
  if (/^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(value) && value.includes(":")) return 6;
  return 0;
}

function isIpLiteral(value) {
  return isIP(value) !== 0;
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function hostnameOfHost(host) {
  const at = host.lastIndexOf(":");
  if (at === -1) return host;
  if (host.includes("]")) return host.slice(0, host.indexOf("]") + 1);
  return host.slice(0, at);
}

function hostMatchesListener(host, localAddress) {
  if (host === undefined || host.trim() === "") return false;
  const hostname = hostnameOfHost(host).toLowerCase();
  if (isLocalHostname(hostname)) return true;
  if (hostname === "0.0.0.0" || hostname === "[::]") return false;
  if (localAddress === undefined || localAddress.trim() === "") return false;
  const local = localAddress.trim().toLowerCase();
  if (!isIpLiteral(local) && !isIpLiteral(`[${local}]`)) return false;
  const bare = (value) => value.startsWith("[") && value.endsWith("]") && isIP(value.slice(1, -1)) === 6
    ? value.slice(1, -1)
    : value;
  return bare(hostname) === bare(local);
}

function originIsLoopback(origin, localAddress) {
  if (origin === undefined || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    if (isLocalHostname(hostname)) return true;
    return hostMatchesListener(hostname, localAddress);
  } catch {
    return false;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** 宿主路由：GET /plugins/dsh-connect-autoclaw/status。仅本机浏览器可访问。 */
export function registerStatusRoute(ctx, service, { path = "/plugins/dsh-connect-autoclaw/status" } = {}) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          json(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) {
          json(res, 403, { ok: false, error: "host-not-trusted" });
          return;
        }
        if (!originIsLoopback(req.headers.origin, req.socket?.localAddress)) {
          json(res, 403, { ok: false, error: "origin-not-trusted" });
          return;
        }
        try {
          /**
           * `?refresh=1` 强制绕过服务端快照缓存（默认 CACHE_MS 内直接复用上一次结果）。
           * 只影响这一次读取：命中后仍然正常写入缓存，后续轮询照旧。
           */
          const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
          if (query.get("refresh") === "1") service.invalidate();
          const snapshot = await service.snapshot(req.signal ?? undefined);
          json(res, 200, snapshot);
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    }), "dsh-connect-autoclaw: /plugins/dsh-connect-autoclaw/status");
  });
}
