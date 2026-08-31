/** Deliver Personal Asset Library results as Feishu cards.
 *
 * Curation runs in the sandbox (fat asset-runtime). Orchestrator only
 * registers assets and publishes the terminal event. This channel adapter
 * remembers the Feishu target for a run and renders that event with the
 * existing authenticated card sender.
 *
 * Queue durability: agent_end may run in an embedded plugin context while the
 * polling service runs in the gateway main process. Always persist the queue
 * to a shared state file under the OpenClaw state dir so flush can reload it.
 */
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { writeJsonAtomically } from './atomic-json';
import { getLarkAccount } from '../core/accounts';
import {
  clearOrchestratorAuthCache,
  fetchOrchestratorJwt,
  orchestratorApiUrl,
  resolveEaglelabApiBase,
  resolveEaglelabApiKey,
  resolveOrchestratorUrl,
  resolveUserJwtToken,
} from '../core/orchestrator-models';
import { type AssetSummary } from '../card/builder';
import { patchMainCardWithAssets } from './card-patch';

const POLL_INTERVAL_MS = 400;
/** Allow slow office extract + curator LLM + register retries. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/**
 * How long to wait for StreamingCardController to persist the card ref after
 * agent_end before abandoning. Covers the common race where
 * assets.ready arrives before finalizeCompleteCard finishes.
 */
const CARD_REF_WAIT_MS = 2 * 60 * 1000;
/** Never re-send a card for the same run_id within this window. */
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = 'personal-assets-feishu-notifier.json';
const DELIVERED_FILE = 'personal-assets-feishu-delivered.json';
/** Same state root OpenClaw uses in TuringClaw sandboxes (see restart-pending helper). */
const CANONICAL_STATE_DIR = '/sandbox/.openclaw';

export type { AssetSummary };

interface AssetReadyEvent {
  run_id: string;
  status: 'completed' | 'completed_no_assets' | 'failed';
  assets: AssetSummary[];
  reason?: string;
}

export interface DeliveryTarget {
  runId: string;
  to: string;
  accountId?: string;
  /** Feishu session key — used to look up the finalized card ref for patching. */
  sessionKey?: string;
  createdAt: number;
  /** When the notifier began polling; used only for latency telemetry. */
  queuedAt?: number;
}

interface DeliveredRecord {
  runId: string;
  deliveredAt: number;
}

/** Shared queue file path; works before registerService start (embedded agent_end). */
export function resolveNotifierStateFile(stateDir?: string): string {
  const dir = (stateDir ?? '').trim() || CANONICAL_STATE_DIR;
  return path.join(dir, STATE_FILE);
}

export function resolveDeliveredStateFile(stateDir?: string): string {
  const dir = (stateDir ?? '').trim() || CANONICAL_STATE_DIR;
  return path.join(dir, DELIVERED_FILE);
}


function resolveControlPlane(api?: OpenClawPluginApi): { baseUrl: string; token: string } | null {
  if (!api) return null;
  const baseUrl = resolveOrchestratorUrl(resolveEaglelabApiBase(api.config));
  const token = resolveUserJwtToken(api.config) ?? '';
  const apiKey = resolveEaglelabApiKey(api.config) ?? '';
  return baseUrl && (token || apiKey) ? { baseUrl, token } : null;
}

/**
 * Call the orchestrator with the same auth fallback as model catalog loading.
 * USER_JWT_TOKEN is injected at sandbox boot and can expire while OpenClaw
 * keeps running; EAGLELAB_API_KEY can be exchanged through /auth/sso for a
 * fresh JWT when that happens.
 */
export async function fetchControlPlane(
  api: OpenClawPluginApi,
  resourcePath: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const baseUrl = resolveOrchestratorUrl(resolveEaglelabApiBase(api.config));
  const apiKey = resolveEaglelabApiKey(api.config);
  let jwt = await fetchOrchestratorJwt(apiKey, baseUrl, { cfg: api.config });
  if (!jwt) return null;

  const request = () => fetch(orchestratorApiUrl(baseUrl, resourcePath), {
    ...init,
    headers: {
      ...(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
      Authorization: `Bearer ${jwt}`,
    },
  });

  let response = await request();
  if (response.status === 401 && apiKey) {
    clearOrchestratorAuthCache();
    jwt = await fetchOrchestratorJwt(apiKey, baseUrl, { cfg: api.config, forceSso: true });
    if (jwt) response = await request();
  }
  return response;
}

async function fetchReadyEvent(
  runId: string,
  api?: OpenClawPluginApi,
): Promise<AssetReadyEvent | null> {
  if (!api || !resolveControlPlane(api)) return null;
  const response = await fetchControlPlane(
    api,
    `personal-assets/events/${encodeURIComponent(runId)}`,
  );
  if (!response) return null;
  if (!response.ok) {
    throw new Error(`asset event request failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const event = body && typeof body === 'object' ? (body as Record<string, unknown>).event : null;
  return isAssetReadyEvent(event) ? event : null;
}

async function withPreviewUrls(
  assets: AssetSummary[],
  api?: OpenClawPluginApi,
  accountId?: string,
): Promise<AssetSummary[]> {
  const controlPlane = resolveControlPlane(api);
  if (!controlPlane) return assets;
  const appId = api ? String(getLarkAccount(api.config, accountId).appId ?? '').trim() : '';
  if (!appId) return assets;
  return Promise.all(assets.map(async (asset) => {
    try {
      const response = await fetchControlPlane(
        api!,
        `personal-assets/${encodeURIComponent(asset.id)}/preview-link?app_id=${encodeURIComponent(appId)}`,
        { method: 'POST' },
      );
      if (!response) throw new Error('orchestrator auth failed');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      const url = body && typeof body === 'object' ? (body as Record<string, unknown>).url : undefined;
      return typeof url === 'string' && url.startsWith('https://')
        ? { ...asset, preview_url: url }
        : asset;
    } catch (error) {
      api?.logger.warn(`personal-assets: preview link unavailable for ${asset.id}: ${String(error)}`);
      return asset;
    }
  }));
}

function isAssetReadyEvent(value: unknown): value is AssetReadyEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.run_id === 'string'
    && (event.status === 'completed' || event.status === 'completed_no_assets' || event.status === 'failed')
    && Array.isArray(event.assets);
}

export async function readPending(statePath: string): Promise<DeliveryTarget[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is DeliveryTarget => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Record<string, unknown>;
      return typeof value.runId === 'string' && typeof value.to === 'string' && typeof value.createdAt === 'number';
    });
  } catch {
    return [];
  }
}

export async function writePending(statePath: string, pending: Iterable<DeliveryTarget>): Promise<void> {
  await writeJsonAtomically(statePath, [...pending]);
}

export async function readDeliveredRunIds(deliveredPath: string): Promise<Set<string>> {
  const now = Date.now();
  try {
    const raw: unknown = JSON.parse(await fs.readFile(deliveredPath, 'utf8'));
    if (!Array.isArray(raw)) return new Set();
    const out = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as DeliveredRecord;
      if (typeof row.runId !== 'string' || typeof row.deliveredAt !== 'number') continue;
      if (now - row.deliveredAt > DELIVERED_TTL_MS) continue;
      out.add(row.runId);
    }
    return out;
  } catch {
    return new Set();
  }
}

async function readDeliveredRecords(deliveredPath: string): Promise<DeliveredRecord[]> {
  const now = Date.now();
  try {
    const raw: unknown = JSON.parse(await fs.readFile(deliveredPath, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is DeliveredRecord => {
      if (!item || typeof item !== 'object') return false;
      const row = item as DeliveredRecord;
      return typeof row.runId === 'string'
        && typeof row.deliveredAt === 'number'
        && now - row.deliveredAt <= DELIVERED_TTL_MS;
    });
  } catch {
    return [];
  }
}

export async function markDeliveredRun(deliveredPath: string, runId: string): Promise<void> {
  const trimmed = runId.trim();
  if (!trimmed) return;
  const existing = await readDeliveredRecords(deliveredPath);
  const next = [
    ...existing.filter((row) => row.runId !== trimmed),
    { runId: trimmed, deliveredAt: Date.now() },
  ];
  await writeJsonAtomically(deliveredPath, next);
}

export async function removeDeliveryTarget(statePath: string, runId: string): Promise<void> {
  const existing = await readPending(statePath);
  const next = existing.filter((item) => item.runId !== runId);
  if (next.length === existing.length) {
    return;
  }
  await writePending(statePath, next);
}

/** Merge one delivery target into the on-disk queue (cross-process safe). */
export async function upsertDeliveryTarget(
  statePath: string,
  target: DeliveryTarget,
  options?: { deliveredPath?: string },
): Promise<boolean> {
  if (options?.deliveredPath) {
    const delivered = await readDeliveredRunIds(options.deliveredPath);
    if (delivered.has(target.runId)) {
      return false;
    }
  }
  const existing = await readPending(statePath);
  const next = [...existing.filter((item) => item.runId !== target.runId), target];
  await writePending(statePath, next);
  return true;
}

interface FeishuHookCtx {
  conversationId?: string;
  sessionKey?: string;
  accountId?: string;
}

/** agent:main:feishu:<account>:direct:<ou_...> or ...:group:<oc_...> */
export function resolveFeishuAccountId(ctx: FeishuHookCtx): string {
  const direct = String(ctx.accountId ?? '').trim();
  if (direct) return direct;
  const session = String(ctx.sessionKey ?? '').trim();
  const parts = session.split(':');
  if (parts.length >= 6 && parts[2] === 'feishu') {
    return parts[3].trim();
  }
  return '';
}

function resolveFeishuTo(ctx: FeishuHookCtx): string {
  const direct = String(ctx.conversationId ?? '').trim();
  if (direct) return direct;
  const session = String(ctx.sessionKey ?? '').trim();
  const parts = session.split(':');
  if (parts.length >= 6 && parts[2] === 'feishu') {
    return parts[parts.length - 1].trim();
  }
  return '';
}

function resolveDeliveryAccountId(target: DeliveryTarget): string | undefined {
  return String(target.accountId ?? '').trim() || undefined;
}

/** Register the Feishu-only delivery bridge.  It is inert outside TuringClaw. */
export function registerPersonalAssetsNotifier(api: OpenClawPluginApi): void {
  if (!resolveControlPlane(api)) {
    api.logger.warn(
      'personal-assets: Feishu notifier inactive until COWORK_API_URL and USER_JWT_TOKEN are set',
    );
  }
  const targetsByRun = new Map<string, DeliveryTarget>();
  const pending = new Map<string, DeliveryTarget>();
  let serviceStateDir = '';
  let interval: ReturnType<typeof setInterval> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let flushing = false;

  const stateFile = () => resolveNotifierStateFile(serviceStateDir);
  const deliveredFile = () => resolveDeliveredStateFile(serviceStateDir);

  const persist = async () => {
    try {
      await writePending(stateFile(), pending.values());
    } catch (error) {
      api.logger.warn(`personal-assets: failed to persist Feishu card queue: ${String(error)}`);
    }
  };

  const reloadPending = async () => {
    const delivered = await readDeliveredRunIds(deliveredFile());
    for (const target of await readPending(stateFile())) {
      if (delivered.has(target.runId)) {
        continue;
      }
      pending.set(target.runId, target);
    }
  };

  const isFeishuCtx = (ctx: { channelId?: string; sessionKey?: string }) =>
    ctx.channelId === 'feishu' || String(ctx.sessionKey ?? '').includes(':feishu:');

  const queueRun = async (
    event: { runId?: string },
    ctx: FeishuHookCtx & { runId?: string; channelId?: string },
  ) => {
    if (!isFeishuCtx(ctx)) return;
    const runId = String(event.runId ?? ctx.runId ?? '').trim();
    if (!runId) return;
    const delivered = await readDeliveredRunIds(deliveredFile());
    if (delivered.has(runId)) return;

    const target = targetsByRun.get(runId) ?? {
      runId,
      to: resolveFeishuTo(ctx),
      accountId: resolveFeishuAccountId(ctx) || undefined,
      sessionKey: String(ctx.sessionKey ?? '').trim() || undefined,
      createdAt: Date.now(),
    };
    if (!target.to) {
      api.logger.warn(`personal-assets: no Feishu target for run ${runId}; card skipped`);
      return;
    }
    const queuedTarget = { ...target, queuedAt: target.queuedAt ?? Date.now() };
    targetsByRun.delete(runId);
    pending.set(runId, queuedTarget);
    try {
      const queued = await upsertDeliveryTarget(stateFile(), queuedTarget, {
        deliveredPath: deliveredFile(),
      });
      if (!queued) {
        pending.delete(runId);
        return;
      }
      api.logger.info(`personal-assets: queued Feishu card for run ${runId} → ${queuedTarget.to}`);
      void flush();
    } catch (error) {
      pending.delete(runId);
      api.logger.warn(`personal-assets: failed to persist Feishu card queue for ${runId}: ${String(error)}`);
    }
  };

  api.on('message_received', (event, ctx) => {
    if (!isFeishuCtx(ctx)) return;
    const runId = String(event.runId ?? ctx.runId ?? '').trim();
    const to = resolveFeishuTo(ctx);
    if (!runId || !to) return;
    targetsByRun.set(runId, {
      runId,
      to,
      accountId: resolveFeishuAccountId(ctx) || undefined,
      sessionKey: String(ctx.sessionKey ?? '').trim() || undefined,
      createdAt: Date.now(),
    });
  });

  // Start polling as the harness enters finalization so a ready event can be
  // observed while the final answer card is being persisted. The patch path
  // still requires the run-bound finalized card ref, so this cannot display
  // assets before the answer is complete.
  api.on('before_agent_finalize', (event, ctx) => {
    void queueRun(event, ctx);
  });

  // Keep agent_end as the durable fallback for runtimes that do not emit
  // before_agent_finalize or omit a run id from that hook.
  api.on('agent_end', (event, ctx) => {
    void queueRun(event, ctx);
  });

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    let mutated = false;
    try {
      await reloadPending();
      if (!resolveControlPlane(api)) {
        if (pending.size > 0) {
          api.logger.warn(
            `personal-assets: ${pending.size} Feishu card(s) waiting; COWORK_API_URL or USER_JWT_TOKEN unset`,
          );
        }
        return;
      }
      const delivered = await readDeliveredRunIds(deliveredFile());
      for (const [runId, target] of pending) {
        if (delivered.has(runId)) {
          pending.delete(runId);
          await removeDeliveryTarget(stateFile(), runId);
          mutated = true;
          continue;
        }
        if (Date.now() - target.createdAt > PENDING_TTL_MS) {
          pending.delete(runId);
          await removeDeliveryTarget(stateFile(), runId);
          mutated = true;
          continue;
        }
        try {
          const eventFetchStartedAt = Date.now();
          const event = await fetchReadyEvent(runId, api);
          if (!event) continue;
          const eventReadyAt = Date.now();
          api.logger.info(
            `personal-assets: terminal event ready run=${runId} status=${event.status} `
            + `assets=${event.assets.length} fetch_ms=${eventReadyAt - eventFetchStartedAt} `
            + `queue_to_ready_ms=${eventReadyAt - (target.queuedAt ?? eventFetchStartedAt)}`,
          );
          const previewStartedAt = Date.now();
          const eventWithPreviewUrls = {
            ...event,
            assets: await withPreviewUrls(event.assets, api, resolveDeliveryAccountId(target)),
          };
          const patchStartedAt = Date.now();

          const accountId = resolveDeliveryAccountId(target);
          const needsCardUpdate =
            eventWithPreviewUrls.status === 'failed'
            || (eventWithPreviewUrls.status === 'completed' && eventWithPreviewUrls.assets.length > 0);

          // Scheme B: completed_no_assets is silent (no pending placeholder,
          // no Feishu write). Only completed-with-assets / failed touch the card.
          const patchResult = await patchMainCardWithAssets({
            runId,
            assets: eventWithPreviewUrls.assets,
            status: eventWithPreviewUrls.status,
            failReason: eventWithPreviewUrls.reason,
            cfg: api.config,
            accountId,
            sessionKey: target.sessionKey,
            stateDir: serviceStateDir,
          });

          if (patchResult.ok) {
            if (patchResult.action === 'silent') {
              api.logger.info(`personal-assets: silent for run ${runId} (${eventWithPreviewUrls.status})`);
            } else {
              api.logger.info(
                `personal-assets: ${patchResult.action} asset panel for run ${runId} (${eventWithPreviewUrls.status})`,
              );
            }
          } else if (patchResult.reason === 'waiting_for_card') {
            // Only outcomes that need a Feishu write wait for the card ref.
            if (needsCardUpdate && Date.now() - target.createdAt < CARD_REF_WAIT_MS) {
              continue;
            }
            if (needsCardUpdate) {
              api.logger.warn(
                `personal-assets: card ref still missing for run ${runId} after ${CARD_REF_WAIT_MS}ms; giving up on patch`,
              );
            }
          } else {
            // Never send a standalone fallback card. Assets only belong in the
            // collapsible panel patched into the original answer card.
            api.logger.warn(
              `personal-assets: original card patch failed for run ${runId} status=${eventWithPreviewUrls.status} reason=${patchResult.reason}`,
            );
          }

          await markDeliveredRun(deliveredFile(), runId);
          pending.delete(runId);
          await removeDeliveryTarget(stateFile(), runId);
          mutated = true;
          api.logger.info(
            `personal-assets: terminal event delivered run=${runId} status=${eventWithPreviewUrls.status} `
            + `assets=${eventWithPreviewUrls.assets.length} preview_links_ms=${patchStartedAt - previewStartedAt} `
            + `card_patch_ms=${Date.now() - patchStartedAt} `
            + `queue_to_delivered_ms=${Date.now() - (target.queuedAt ?? patchStartedAt)}`,
          );
        } catch (error) {
          api.logger.warn(`personal-assets: Feishu card delivery pending for ${runId}: ${String(error)}`);
        }
      }
      if (mutated) await persist();
    } catch (error) {
      api.logger.warn(`personal-assets: Feishu card flush failed: ${String(error)}`);
    } finally {
      flushing = false;
    }
  };

  api.registerService({
    id: 'personal-assets-feishu-notifier',
    start: async (ctx) => {
      serviceStateDir = ctx.stateDir;
      for (const target of await readPending(stateFile())) pending.set(target.runId, target);
      await flush();
      const statePath = stateFile();
      try {
        watcher = watch(path.dirname(statePath), (_event, filename) => {
          if (filename === path.basename(statePath)) {
            void flush();
          }
        });
      } catch (error) {
        api.logger.warn(`personal-assets: fs.watch unavailable; poll-only delivery: ${String(error)}`);
      }
      interval = setInterval(() => void flush(), POLL_INTERVAL_MS);
      interval.unref?.();
    },
    stop: async () => {
      watcher?.close();
      watcher = undefined;
      if (interval) clearInterval(interval);
      interval = undefined;
      await reloadPending();
      await persist();
    },
  });
}
