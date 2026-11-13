/**
 * AutoClaw 本机凭据读取与解密。
 *
 * 本机 AutoClaw 登录凭据按 Electron safeStorage 方案加密落盘；
 * 解密密钥存放在系统钥匙串（服务名见 KEYCHAIN_SERVICE）。
 * IV 固定为 16 个空格。
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORT_DIR = join(homedir(), "Library", "Application Support");
const KEYCHAIN_SERVICE = "AutoClaw Safe Storage";
const PBKDF2_SALT = "saltysalt";
const PBKDF2_ROUNDS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20);

/** 凭据目录候选：official / 无后缀（beta、canary 等）。 */
function candidateRoots() {
  const names = ["AutoClaw-official", "AutoClaw"];
  try {
    for (const entry of readdirSync(SUPPORT_DIR)) {
      if (entry.startsWith("AutoClaw") && !names.includes(entry)) names.push(entry);
    }
  } catch {
    /* 目录不存在时只保留默认候选 */
  }
  return names.map((name) => join(SUPPORT_DIR, name, "accounts"));
}

/** 最近修改的账号目录，即当前登录账号。 */
function newestAccountDir() {
  const found = [];
  for (const root of candidateRoots()) {
    if (!existsSync(root)) continue;
    for (const key of readdirSync(root)) {
      const dir = join(root, key);
      const credentials = join(dir, "account-credentials.enc");
      try {
        if (!statSync(dir).isDirectory() || !existsSync(credentials)) continue;
        found.push({ dir, mtime: statSync(credentials).mtimeMs });
      } catch {
        /* 单个账号目录不可读时跳过 */
      }
    }
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].dir;
}

let cachedKey;
/** 从 keychain 读 safeStorage 密码并派生 AES key。 */
function safeStorageKey() {
  if (cachedKey !== undefined) return cachedKey;
  let password;
  try {
    password = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    throw new Error(
      `无法读取钥匙串里的 "${KEYCHAIN_SERVICE}"：请解锁钥匙串后重试（${error.message}）`,
    );
  }
  if (password.length === 0) {
    throw new Error(`钥匙串条目 "${KEYCHAIN_SERVICE}" 为空，AutoClaw 的凭据无法解密`);
  }
  cachedKey = pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ROUNDS, KEY_LENGTH, "sha1");
  return cachedKey;
}

/** 解密一个 safeStorage 密文文件；非 v10 前缀按明文 JSON 处理。 */
function decryptFile(path) {
  const raw = readFileSync(path);
  if (raw.subarray(0, 3).toString("latin1") !== "v10") {
    return JSON.parse(raw.toString("utf8"));
  }
  const decipher = createDecipheriv("aes-128-cbc", safeStorageKey(), IV);
  const plain = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** 读 JSON，缺失或损坏时返回 undefined。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 读取当前账号的网关凭据。
 * @returns {{ accountDir: string, accessToken: string, refreshToken?: string, tokenType?: string }}
 */
export function readAutoClawCredentials() {
  const accountDir = newestAccountDir();
  if (accountDir === undefined) {
    throw new Error(
      "找不到 AutoClaw 账号目录：请先打开 AutoClaw2 并完成登录（查找 *-official/accounts/<key>/account-credentials.enc）",
    );
  }
  const path = join(accountDir, "account-credentials.enc");
  const payload = decryptFile(path);
  const raw = typeof payload.accessToken === "string" ? payload.accessToken : "";
  const accessToken = raw.replace(/^Bearer\s+/i, "").trim();
  if (accessToken.length === 0) {
    throw new Error(`AutoClaw 凭据文件里没有 accessToken：${path}`);
  }
  const refreshRaw = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
  return {
    accountDir,
    accessToken,
    ...(refreshRaw.length === 0
      ? {}
      : { refreshToken: refreshRaw.replace(/^Bearer\s+/i, "").trim() }),
    ...(typeof payload.tokenType === "string" ? { tokenType: payload.tokenType } : {}),
  };
}

/** 读托管模型目录快照（AutoClaw 自己刷新的 remote-snapshot.json）。 */
export function readModelSnapshot(accountDir) {
  return readJson(join(accountDir, "runtime", "model-catalog", "remote-snapshot.json"));
}

/** 读 app 版本，用于 X-Version 头。 */
export function readAppVersion() {
  const plist = "/Applications/AutoClaw2.app/Contents/Info.plist";
  try {
    const out = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], {
      encoding: "utf8",
    }).trim();
    if (out.length > 0) return out;
  } catch {
    /* 退回默认版本号 */
  }
  return "2.4.2";
}

/** 网关 appId/appKey 默认值，配置可覆盖。 */
export const DEFAULT_APP_ID = "100003";
export const DEFAULT_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
