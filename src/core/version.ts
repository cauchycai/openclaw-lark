/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 插件版本号管理
 *
 * 从 package.json 读取版本号并生成显示版本和 User-Agent 字符串。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

interface PackageJsonVersionInfo {
  version?: string;
  openclawFork?: {
    name?: string;
    version?: string;
  };
}

interface PluginVersionInfo {
  upstreamVersion: string;
  forkName?: string;
  forkVersion?: string;
}

/** 缓存的版本信息 */
let cachedVersionInfo: PluginVersionInfo | undefined;
/** 缓存的版本号 */
let cachedVersion: string | undefined;

function readPackageJsonFrom(startDir: string): PackageJsonVersionInfo {
  let dir = startDir;

  while (true) {
    const packageJsonPath = join(dir, 'package.json');
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as PackageJsonVersionInfo;
      if (pkg.version || pkg.openclawFork) return pkg;
    } catch {
      // Keep walking up: bundled runtime chunks may live directly under dist/.
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {};
}

function readVersionInfo(): PluginVersionInfo {
  if (cachedVersionInfo) return cachedVersionInfo;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = readPackageJsonFrom(__dirname);
    cachedVersionInfo = {
      upstreamVersion: pkg.version ?? 'unknown',
      forkName: pkg.openclawFork?.name,
      forkVersion: pkg.openclawFork?.version,
    };
  } catch {
    cachedVersionInfo = { upstreamVersion: 'unknown' };
  }

  return cachedVersionInfo;
}

/**
 * 获取插件版本号（从 package.json 读取）
 *
 * @returns 版本号字符串，如 "2026.2.28.5"；读取失败返回 "unknown"
 */
export function getPluginVersion(): string {
  if (cachedVersion) return cachedVersion;

  cachedVersion = readVersionInfo().upstreamVersion;
  return cachedVersion;
}

/**
 * 获取用户可见的插件版本信息。
 */
export function getPluginVersionDisplay(): string {
  const { upstreamVersion, forkName, forkVersion } = readVersionInfo();
  if (!forkVersion) return upstreamVersion;

  const forkLabel = forkName ? `${forkName} ${forkVersion}` : forkVersion;
  return `upstream ${upstreamVersion} / fork ${forkLabel}`;
}

function getUserAgentVersion(): string {
  const { upstreamVersion, forkName, forkVersion } = readVersionInfo();
  if (!forkVersion) return upstreamVersion;

  const forkPart = [forkName, forkVersion]
    .filter((part): part is string => Boolean(part))
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${upstreamVersion}+${forkPart}`;
}

/**
 * 获取当前运行平台名称
 *
 * @returns `mac` | `linux` | `windows`
 */
export function getPlatform(): string {
  switch (process.platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/**
 * 生成 User-Agent 字符串
 *
 * @returns User-Agent 字符串，格式：`openclaw-lark/{version}/{platform}`
 *
 * @example
 * ```typescript
 * getUserAgent() // => "openclaw-lark/2026.2.28.5/mac"
 * ```
 */
export function getUserAgent(): string {
  return `openclaw-lark/${getUserAgentVersion()}/${getPlatform()}`;
}
