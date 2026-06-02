/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Default values and resolution logic for the Feishu card footer configuration.
 *
 * Each boolean flag controls whether a particular metadata item is displayed
 * in the card footer (e.g. elapsed time, model name).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { FeishuFooterConfig } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default footer configuration.
 *
 * By default all metadata items are hidden. Balance usage is only shown when
 * explicitly enabled in config.
 */
export const DEFAULT_FOOTER_CONFIG: Required<FeishuFooterConfig> = {
  status: false,
  elapsed: false,
  tokens: false,
  cache: false,
  context: false,
  model: false,
  balanceUsage: false,
};

export const DEFAULT_RUNTIME_FOOTER_CONFIG_PATH = '/sandbox/.openclaw/workspace/openclaw-lark.footer.json';
export const RUNTIME_FOOTER_CONFIG_ENV = 'OPENCLAW_LARK_FOOTER_CONFIG';

export interface FooterConfigResolveOptions {
  runtimeConfigPath?: string | null;
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function pickFooterBooleans(value: unknown): FeishuFooterConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const footer = (input.footer && typeof input.footer === 'object' && !Array.isArray(input.footer)
    ? input.footer
    : input) as Record<string, unknown>;
  const result: FeishuFooterConfig = {};

  for (const key of ['status', 'elapsed', 'tokens', 'cache', 'context', 'model', 'balanceUsage'] as const) {
    if (typeof footer[key] === 'boolean') {
      result[key] = footer[key];
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function readRuntimeFooterConfig(options: FooterConfigResolveOptions = {}): FeishuFooterConfig | undefined {
  const env = options.env ?? process.env;
  const runtimeConfigPath =
    options.runtimeConfigPath === undefined
      ? (env[RUNTIME_FOOTER_CONFIG_ENV]?.trim() || DEFAULT_RUNTIME_FOOTER_CONFIG_PATH)
      : options.runtimeConfigPath;

  if (!runtimeConfigPath || !existsSync(runtimeConfigPath)) {
    return undefined;
  }

  try {
    return pickFooterBooleans(JSON.parse(readFileSync(runtimeConfigPath, 'utf8')));
  } catch {
    return undefined;
  }
}

function mergeFooterConfig(
  cfg: FeishuFooterConfig | undefined,
  runtimeCfg: FeishuFooterConfig | undefined,
): Required<FeishuFooterConfig> {
  const resolved = {
    status: cfg?.status ?? DEFAULT_FOOTER_CONFIG.status,
    elapsed: cfg?.elapsed ?? DEFAULT_FOOTER_CONFIG.elapsed,
    tokens: cfg?.tokens ?? DEFAULT_FOOTER_CONFIG.tokens,
    cache: cfg?.cache ?? DEFAULT_FOOTER_CONFIG.cache,
    context: cfg?.context ?? DEFAULT_FOOTER_CONFIG.context,
    model: cfg?.model ?? DEFAULT_FOOTER_CONFIG.model,
    balanceUsage: cfg?.balanceUsage ?? DEFAULT_FOOTER_CONFIG.balanceUsage,
  };
  if (!runtimeCfg) return resolved;
  return {
    status: runtimeCfg.status ?? resolved.status,
    elapsed: runtimeCfg.elapsed ?? resolved.elapsed,
    tokens: runtimeCfg.tokens ?? resolved.tokens,
    cache: runtimeCfg.cache ?? resolved.cache,
    context: runtimeCfg.context ?? resolved.context,
    model: runtimeCfg.model ?? resolved.model,
    balanceUsage: runtimeCfg.balanceUsage ?? resolved.balanceUsage,
  };
}

/**
 * Merge footer configuration with defaults and an optional runtime config file.
 *
 * Precedence: runtime file > OpenClaw config > defaults. The default runtime
 * file path lives in the sandbox workspace so it can survive TuringClaw sandbox
 * restarts that regenerate `/sandbox/.openclaw/openclaw.json`.
 */
export function resolveFooterConfig(
  cfg?: FeishuFooterConfig,
  options?: FooterConfigResolveOptions,
): Required<FeishuFooterConfig> {
  return mergeFooterConfig(cfg, readRuntimeFooterConfig(options));
}
