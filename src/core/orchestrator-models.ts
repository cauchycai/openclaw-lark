/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * EagleLab orchestrator API: API key resolution, SSO JWT, and model catalog.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getResolvedConfig } from './lark-client';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/orchestrator-models');

export const EAGLELAB_API_KEY_ENV = 'EAGLELAB_API_KEY';
/** Turing model API base; used only to infer live vs test for cowork orchestrator URL. */
export const EAGLELAB_API_BASE_ENV = 'EAGLELAB_API_BASE';
/** Override the orchestrator root URL entirely (e.g. for dev/staging environments). */
export const CLAW_ORCHESTRATOR_URL_ENV = 'CLAW_ORCHESTRATOR_URL';
const LIVE_COWORK_URL = 'https://live-cowork.tcljd.com';
const TEST_COWORK_URL = 'https://test-cowork.tcljd.com';

/** In-memory catalog/JWT cache TTL (not persisted to disk). */
export const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;

const SANDBOX_PROFILE_PATHS = [
  '/sandbox/.profile',
  '/sandbox/.bashrc',
  path.join(os.homedir(), '.profile'),
  path.join(os.homedir(), '.bashrc'),
];

export interface ModelCatalogEntry {
  /** Orchestrator model_id, e.g. turing-claw/glm */
  modelId: string;
  /** API `name`, e.g. glm-5.1 or Turing Default Model */
  name: string;
  /** Button label with cost, e.g. kimi-k2.6 · 1.0x cost */
  label: string;
  /** Full OpenClaw ref, e.g. eaglelab/turing-claw/glm */
  ref: string;
  /** Whether this is the configured default / primary model */
  isPrimary?: boolean;
}

interface OrchestratorModelRecord {
  model_id?: string;
  name?: string;
  enabled?: boolean;
  is_primary?: boolean;
  cost_multiplier?: number;
}

interface OrchestratorModelsResponse {
  models?: OrchestratorModelRecord[];
}

interface SsoResponse {
  access_token?: string;
}

let jwtCache: { token: string; expiresAt: number } | undefined;

function buildShellExportPattern(varName: string): RegExp {
  return new RegExp(`^\\s*export\\s+${varName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#;]+))`, 'u');
}

export function parseShellExportVar(content: string, varName: string): string | undefined {
  const pattern = buildShellExportPattern(varName);
  for (const line of content.split('\n')) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = normalizeSecret(match[1] ?? match[2] ?? match[3]);
    if (value) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\$\{[^}]+\}$/u.test(trimmed)) return undefined;
  return trimmed;
}

export function parseEaglelabApiKeyFromShellExport(content: string): string | undefined {
  return parseShellExportVar(content, EAGLELAB_API_KEY_ENV);
}

function readEaglelabApiKeyFromSandboxProfiles(): string | undefined {
  for (const profilePath of SANDBOX_PROFILE_PATHS) {
    if (!profilePath || !existsSync(profilePath)) continue;
    try {
      const value = parseEaglelabApiKeyFromShellExport(readFileSync(profilePath, 'utf8'));
      if (value) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function resolveEaglelabApiKey(cfg?: ClawdbotConfig): string | undefined {
  const fromProcess = normalizeSecret(process.env[EAGLELAB_API_KEY_ENV]);
  if (fromProcess) return fromProcess;

  if (cfg) {
    const resolved = getResolvedConfig(cfg) as ClawdbotConfig & {
      models?: { providers?: Record<string, { apiKey?: string }> };
      env?: Record<string, string>;
    };
    const fromProvider = normalizeSecret(resolved.models?.providers?.eaglelab?.apiKey);
    if (fromProvider) return fromProvider;
    const fromConfigEnv = normalizeSecret(resolved.env?.[EAGLELAB_API_KEY_ENV]);
    if (fromConfigEnv) return fromConfigEnv;
  }

  return readEaglelabApiKeyFromSandboxProfiles();
}

/** Map EAGLELAB_API_BASE (live-turing vs test-turing) → cowork orchestrator root. */
export function resolveOrchestratorUrl(apiBase?: string): string {
  const override = process.env[CLAW_ORCHESTRATOR_URL_ENV]?.trim();
  if (override) return override.replace(/\/+$/, '');
  const normalized = (apiBase ?? process.env[EAGLELAB_API_BASE_ENV] ?? '').trim().toLowerCase();
  if (normalized.includes('test')) {
    return TEST_COWORK_URL;
  }
  return LIVE_COWORK_URL;
}

export function orchestratorApiUrl(orchestratorRoot: string, resourcePath: string): URL {
  const base = orchestratorRoot.replace(/\/+$/u, '');
  const resource = resourcePath.replace(/^\/+/u, '');
  return new URL(`/api/v1/${resource}`, base);
}

export function formatModelLabel(name: string, costMultiplier: number): string {
  const multiplier =
    Number.isInteger(costMultiplier) || costMultiplier % 1 === 0
      ? costMultiplier.toFixed(1)
      : String(costMultiplier);
  return `${name} · ${multiplier}x cost`;
}

function normalizeCostMultiplier(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 1;
}

export async function fetchOrchestratorJwt(apiKey: string, orchestratorRoot: string): Promise<string | undefined> {
  const now = Date.now();
  if (jwtCache && jwtCache.expiresAt > now) {
    return jwtCache.token;
  }

  const url = orchestratorApiUrl(orchestratorRoot, 'auth/sso');
  url.searchParams.set('token', apiKey);

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    log.warn(`orchestrator sso failed: HTTP ${response.status}`);
    return undefined;
  }

  const body = (await response.json()) as SsoResponse;
  const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  if (!token) {
    log.warn('orchestrator sso response missing access_token');
    return undefined;
  }

  jwtCache = { token, expiresAt: now + MODEL_CATALOG_CACHE_TTL_MS };
  return token;
}

function mapOrchestratorModel(record: OrchestratorModelRecord): ModelCatalogEntry | undefined {
  const modelId = typeof record.model_id === 'string' ? record.model_id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!modelId || !name) return undefined;
  if (record.enabled === false) return undefined;

  return {
    modelId,
    name,
    label: formatModelLabel(name, normalizeCostMultiplier(record.cost_multiplier)),
    ref: `eaglelab/${modelId}`,
    isPrimary: record.is_primary === true,
  };
}

export async function listAvailableModelsFromOrchestrator(
  cfg?: ClawdbotConfig,
): Promise<{ entries: ModelCatalogEntry[]; error?: string }> {
  const apiKey = resolveEaglelabApiKey(cfg);
  if (!apiKey) {
    return { entries: [], error: 'missing EAGLELAB_API_KEY' };
  }

  const orchestratorRoot = resolveOrchestratorUrl();
  try {
    const jwt = await fetchOrchestratorJwt(apiKey, orchestratorRoot);
    if (!jwt) {
      return { entries: [], error: 'orchestrator sso failed' };
    }

    const response = await fetch(orchestratorApiUrl(orchestratorRoot, 'models'), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`orchestrator models failed: HTTP ${response.status}`);
      return { entries: [], error: `orchestrator models HTTP ${response.status}` };
    }

    const body = (await response.json()) as OrchestratorModelsResponse;
    const records = Array.isArray(body.models) ? body.models : [];
    const entries = records
      .map((record) => (isRecord(record) ? mapOrchestratorModel(record as OrchestratorModelRecord) : undefined))
      .filter((entry): entry is ModelCatalogEntry => Boolean(entry));

    if (entries.length === 0) {
      return { entries: [], error: 'orchestrator returned no enabled models' };
    }

    log.info(`orchestrator models loaded count=${entries.length} base=${orchestratorRoot}`);
    return { entries };
  } catch (err) {
    log.warn(`orchestrator models fetch failed: ${String(err)}`);
    return { entries: [], error: String(err) };
  }
}

export function clearOrchestratorAuthCache(): void {
  jwtCache = undefined;
}
