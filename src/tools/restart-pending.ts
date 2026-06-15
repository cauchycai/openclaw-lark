/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Persists in-flight bot restart notifications across process restarts.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_RESTART_PENDING_PATH = '/sandbox/.openclaw/workspace/openclaw-lark.restart-pending.json';
export const RESTART_PENDING_ENV = 'OPENCLAW_LARK_RESTART_PENDING';

/** Ignore stale pending files older than this. */
export const RESTART_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

/** Suppress duplicate restart triggers while one is already in flight. */
export const RESTART_IN_FLIGHT_COOLDOWN_MS = 3 * 60 * 1000;

export interface RestartPendingState {
  operatorOpenId: string;
  messageId: string;
  accountId: string;
  triggeredAt: number;
}

export function resolveRestartPendingPath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[RESTART_PENDING_ENV]?.trim();
  return fromEnv || DEFAULT_RESTART_PENDING_PATH;
}

export async function readRestartPending(
  path: string = resolveRestartPendingPath(),
): Promise<RestartPendingState | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    const operatorOpenId = typeof value.operatorOpenId === 'string' ? value.operatorOpenId.trim() : '';
    const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
    const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : '';
    const triggeredAt = typeof value.triggeredAt === 'number' ? value.triggeredAt : NaN;
    if (!operatorOpenId || !messageId || !accountId || !Number.isFinite(triggeredAt)) return undefined;
    return { operatorOpenId, messageId, accountId, triggeredAt };
  } catch {
    return undefined;
  }
}

export async function writeRestartPending(
  state: RestartPendingState,
  path: string = resolveRestartPendingPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), 'utf8');
}

export async function clearRestartPending(path: string = resolveRestartPendingPath()): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing file is fine.
  }
}

export function isRestartInFlight(
  state: RestartPendingState | undefined,
  now = Date.now(),
  cooldownMs = RESTART_IN_FLIGHT_COOLDOWN_MS,
): boolean {
  if (!state) return false;
  return now - state.triggeredAt < cooldownMs;
}

export function isRestartPendingFresh(
  state: RestartPendingState | undefined,
  now = Date.now(),
  maxAgeMs = RESTART_PENDING_MAX_AGE_MS,
): boolean {
  if (!state) return false;
  return now - state.triggeredAt < maxAgeMs;
}
