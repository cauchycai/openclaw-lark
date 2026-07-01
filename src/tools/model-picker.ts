/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu dynamic model picker:
 * - application.bot.menu_v6 (event_key=turingclaw_pick_model) → send card
 * - card.action.trigger (action=set_model) → inject /model ref
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import {
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from 'openclaw/plugin-sdk/agent-runtime';
import { loadSessionStore, resolveSessionStoreEntry, resolveStorePath } from 'openclaw/plugin-sdk/config-runtime';
import type { MonitorContext } from '../channel/types';
import { createAccountScopedConfig } from '../core/accounts';
import { resolveCardCallbackOperatorId } from '../core/card-action-operator';
import { LarkClient } from '../core/lark-client';
import { larkLogger } from '../core/lark-logger';
import {
  type ModelCatalogEntry,
  findModelEntry,
  findPrimaryModelEntry,
  getCachedModelCatalog,
  listModelCatalog,
} from '../core/model-catalog';
import { MODEL_PROVIDER_ID } from '../core/orchestrator-models';
import { dispatchSyntheticTextMessage } from '../messaging/inbound/synthetic-message';
import { sendCardFeishu, sendMessageFeishu } from '../messaging/outbound/send';

const log = larkLogger('tools/model-picker');

export const MENU_EVENT_KEY_PICK_MODEL = 'turingclaw_pick_model';
export const ACTION_SET_MODEL = 'set_model';

type Locale = 'zh_cn' | 'en_us';

const I18N_CONFIG = {
  update_multi: true,
  locales: ['zh_cn', 'en_us'] as Locale[],
};

const CARD_TEXTS = {
  zh_cn: {
    title: '选择模型',
    current: (label: string) => `当前：${label}`,
    unknown: '未知',
    hint: '点击按钮切换模型',
    errorTitle: '无法加载模型列表',
    emptyBody: '暂无可用模型，请联系管理员，或直接在对话中使用 `/model` 命令。',
    loadFailed: '暂时无法加载模型列表，请稍后再试或使用 `/model` 命令切换。',
    switchedTo: (label: string) => `已切换至 ${label}`,
  },
  en_us: {
    title: 'Select Model',
    current: (label: string) => `Current: ${label}`,
    unknown: 'Unknown',
    hint: 'Tap a button to switch models',
    errorTitle: 'Unable to load models',
    emptyBody: 'No models are available. Contact your admin, or use `/model` in chat.',
    loadFailed: 'Unable to load the model list. Try again later or use `/model` in chat.',
    switchedTo: (label: string) => `Switched to ${label}`,
  },
} as const;

function i18nContent(zh: string, en: string): Record<Locale, string> {
  return { zh_cn: zh, en_us: en };
}

function i18nPlainText(zh: string, en: string) {
  return { tag: 'plain_text' as const, content: en, i18n_content: i18nContent(zh, en) };
}

function i18nMarkdown(zh: string, en: string) {
  return { tag: 'markdown' as const, content: en, i18n_content: i18nContent(zh, en) };
}

/** Feishu card callback toast i18n (see card-callback-communication). */
function i18nToast(zh: string, en: string): { content: string; i18n: Record<Locale, string> } {
  return { content: en, i18n: i18nContent(zh, en) };
}

interface MenuV6EventPayload {
  header?: { event_id?: string; event_type?: string };
  event?: {
    event_key?: string;
    operator?: {
      operator_id?: { open_id?: string; user_id?: string };
      open_id?: string;
      user_id?: string;
    };
  };
  event_key?: string;
  operator?: {
    operator_id?: { open_id?: string; user_id?: string };
    open_id?: string;
    user_id?: string;
  };
}

interface CardActionPayload {
  operator?: { open_id?: string; user_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: {
    value?: { action?: string; model_id?: string } | string;
  };
}

function resolveMenuOperatorOpenId(payload: MenuV6EventPayload): string | undefined {
  const operator = payload.event?.operator ?? payload.operator;
  if (!operator) return undefined;
  return (
    operator.operator_id?.open_id ||
    operator.open_id ||
    operator.operator_id?.user_id ||
    operator.user_id
  );
}

function resolveMenuEventKey(payload: MenuV6EventPayload): string | undefined {
  return payload.event?.event_key?.trim() || payload.event_key?.trim() || undefined;
}

function resolveMenuEventId(data: unknown): string | undefined {
  const payload = data as MenuV6EventPayload & { header?: { event_id?: string } };
  return payload.header?.event_id?.trim() || undefined;
}

function formatButtonLabel(entry: ModelCatalogEntry, isCurrent: boolean): string {
  return isCurrent ? `✅ ${entry.label}` : entry.label;
}

function formatModelCommand(modelId: string): string {
  return `/model ${MODEL_PROVIDER_ID}/${modelId.trim()}`;
}

/** Model id namespace stored mistakenly as providerOverride in older sessions. */
const MODEL_NAMESPACE_PROVIDERS = new Set(['turing-claw']);

function normalizeModelToken(value: string): string {
  return value.trim().toLowerCase();
}

function isModelNamespaceProvider(provider: string | undefined): boolean {
  return Boolean(provider && MODEL_NAMESPACE_PROVIDERS.has(normalizeModelToken(provider)));
}

function findCatalogEntryByModelId(
  modelId: string,
  entries: ModelCatalogEntry[],
): ModelCatalogEntry | undefined {
  const normalized = normalizeModelToken(modelId);
  return entries.find((entry) => normalizeModelToken(entry.modelId) === normalized);
}

function findCatalogEntryByRef(ref: string, entries: ModelCatalogEntry[]): ModelCatalogEntry | undefined {
  const normalized = normalizeModelToken(ref);
  return entries.find((entry) => normalizeModelToken(entry.ref) === normalized);
}

/** Match catalog by last path segment; disambiguate with full session model when needed. */
function findCatalogEntryByTail(
  tail: string,
  entries: ModelCatalogEntry[],
  preferModelId?: string,
): ModelCatalogEntry | undefined {
  const normalizedTail = normalizeModelToken(tail);
  const matches = entries.filter((entry) => {
    const modelId = normalizeModelToken(entry.modelId);
    return modelId === normalizedTail || modelId.endsWith(`/${normalizedTail}`);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length <= 1) return undefined;

  const preferred = preferModelId?.trim();
  if (!preferred) return undefined;

  const normalizedPreferred = normalizeModelToken(preferred);
  const exact = matches.find((entry) => normalizeModelToken(entry.modelId) === normalizedPreferred);
  if (exact) return exact;

  const preferredTail = normalizedPreferred.split('/').pop() ?? normalizedPreferred;
  const tailFiltered = matches.filter((entry) => {
    const modelId = normalizeModelToken(entry.modelId);
    return modelId === preferredTail || modelId.endsWith(`/${preferredTail}`);
  });
  return tailFiltered.length === 1 ? tailFiltered[0] : undefined;
}

function readSessionStringField(
  entry: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = entry?.[key];
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function normalizeStoredOverrideModel(params: {
  providerOverride?: unknown;
  modelOverride?: unknown;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride =
    typeof params.providerOverride === 'string' ? params.providerOverride.trim() : undefined;
  const modelOverride = typeof params.modelOverride === 'string' ? params.modelOverride.trim() : undefined;
  if (!providerOverride || !modelOverride) {
    return { providerOverride, modelOverride };
  }
  if (isModelNamespaceProvider(providerOverride)) {
    const combined = modelOverride.includes('/')
      ? modelOverride
      : `${providerOverride}/${modelOverride}`;
    return { providerOverride: MODEL_PROVIDER_ID, modelOverride: combined };
  }
  const providerPrefix = `${providerOverride.toLowerCase()}/`;
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerPrefix.length).trim() || modelOverride
      : modelOverride,
  };
}

/** Mirror OpenClaw gateway `resolveSessionModelRef` for UI surfaces. */
export function resolveOpenClawSessionModelRef(
  cfg: ClawdbotConfig,
  entry: Record<string, unknown> | undefined,
  agentId: string,
): { provider: string; model: string } {
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  return (
    resolvePersistedSelectedModelRef({
      defaultProvider: defaults.provider || 'openai',
      runtimeProvider: readSessionStringField(entry, 'modelProvider'),
      runtimeModel: readSessionStringField(entry, 'model'),
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
    }) ?? defaults
  );
}

export function resolveCatalogModelIdFromSessionModelRef(
  modelRef: { provider: string; model: string },
  entries: ModelCatalogEntry[],
): string | undefined {
  const model = modelRef.model.trim();
  if (!model) return undefined;

  const provider = modelRef.provider.trim();
  const fullRef = provider ? `${provider}/${model}` : model;

  const byModelId = findCatalogEntryByModelId(model, entries);
  if (byModelId) return byModelId.modelId;

  const byRef = findCatalogEntryByRef(fullRef, entries);
  if (byRef) return byRef.modelId;

  if (provider !== MODEL_PROVIDER_ID) {
    const eaglelabRef = `${MODEL_PROVIDER_ID}/${model}`;
    const byEaglelabRef = findCatalogEntryByRef(eaglelabRef, entries);
    if (byEaglelabRef) return byEaglelabRef.modelId;
  }

  const tail = model.split('/').pop() ?? model;
  const byTail = findCatalogEntryByTail(tail, entries, model);
  return byTail?.modelId;
}

export function resolveCatalogModelIdFromSessionEntry(params: {
  cfg: ClawdbotConfig;
  entry: Record<string, unknown> | undefined;
  agentId: string;
  entries: ModelCatalogEntry[];
}): string | undefined {
  if (!params.entry) return undefined;
  const modelRef = resolveOpenClawSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveCatalogModelIdFromSessionModelRef(modelRef, params.entries);
}

export function buildModelPickerCard(params: {
  entries: ModelCatalogEntry[];
  currentModelId?: string;
}): Record<string, unknown> {
  const { entries, currentModelId } = params;
  const zh = CARD_TEXTS.zh_cn;
  const en = CARD_TEXTS.en_us;
  const effectiveCurrentModelId = currentModelId ?? findPrimaryModelEntry(entries)?.modelId;
  const currentEntry = effectiveCurrentModelId
    ? findModelEntry(entries, effectiveCurrentModelId)
    : undefined;
  const primaryName = findPrimaryModelEntry(entries)?.name;
  const currentName = currentEntry?.name ?? primaryName ?? zh.unknown;
  const currentNameEn = currentEntry?.name ?? primaryName ?? en.unknown;

  const buttons = entries.map((entry) => ({
    tag: 'button',
    type: effectiveCurrentModelId === entry.modelId ? 'primary' : 'default',
    text: {
      tag: 'plain_text',
      content: formatButtonLabel(entry, effectiveCurrentModelId === entry.modelId),
    },
    value: {
      action: ACTION_SET_MODEL,
      model_id: entry.modelId,
    },
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: {
      title: i18nPlainText(zh.title, en.title),
      subtitle: i18nPlainText(zh.current(currentName), en.current(currentNameEn)),
      template: 'blue',
    },
    body: {
      elements: [i18nMarkdown(zh.hint, en.hint), ...buttons],
    },
  };
}

function buildModelPickerErrorCard(): Record<string, unknown> {
  const zh = CARD_TEXTS.zh_cn;
  const en = CARD_TEXTS.en_us;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: {
      title: i18nPlainText(zh.errorTitle, en.errorTitle),
      template: 'orange',
    },
    body: {
      elements: [i18nMarkdown(zh.emptyBody, en.emptyBody)],
    },
  };
}

function resolveCandidateSessionKeys(cfg: ClawdbotConfig, sessionKey: string): string[] {
  const key = sessionKey.trim().toLowerCase();
  const defaultAgentId = resolveDefaultAgentId(cfg as Record<string, unknown>);
  const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
  return fallbackKey !== key ? [key, fallbackKey] : [key];
}

function getLarkRuntimeSafe(): typeof LarkClient.runtime | undefined {
  try {
    return LarkClient.runtime;
  } catch {
    return undefined;
  }
}

type SessionStore = ReturnType<typeof loadSessionStore>;

interface SessionPickerContext {
  agentId: string;
  sessionEntry?: Record<string, unknown>;
}

function readSessionStoreEntry(
  store: SessionStore,
  sessionKey: string,
): Record<string, unknown> | undefined {
  const direct = store[sessionKey];
  if (direct && typeof direct === 'object') {
    return direct as Record<string, unknown>;
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  return resolved.existing as Record<string, unknown> | undefined;
}

function loadSessionStoreForAgent(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): SessionStore | undefined {
  const cfgWithSession = params.cfg as { session?: { store?: string }; sessions?: { store?: string } };
  const sessionStorePath = cfgWithSession.session?.store ?? cfgWithSession.sessions?.store;
  const runtime = getLarkRuntimeSafe() as {
    agent?: {
      session?: {
        resolveStorePath?: (storePath?: string, opts?: { agentId?: string }) => string;
        loadSessionStore?: (storePath: string) => Record<string, Record<string, unknown>>;
      };
    };
  } | undefined;

  const sessionApi = runtime?.agent?.session;
  if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
    const storePath = sessionApi.resolveStorePath(sessionStorePath, { agentId: params.agentId });
    return sessionApi.loadSessionStore(storePath) as unknown as SessionStore;
  }

  const storePath = resolveStorePath(sessionStorePath, { agentId: params.agentId });
  return loadSessionStore(storePath);
}

/** Load session store + entry without waiting on the model catalog. */
function loadSessionPickerContext(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
}): SessionPickerContext | undefined {
  const core = getLarkRuntimeSafe();
  if (!core?.channel?.routing?.resolveAgentRoute) return undefined;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: 'feishu',
    accountId: params.accountId,
    peer: { kind: 'direct', id: params.senderOpenId },
  });

  try {
    const store = loadSessionStoreForAgent({ cfg: params.cfg, agentId: route.agentId });
    if (!store) return { agentId: route.agentId };

    const candidateKeys = resolveCandidateSessionKeys(params.cfg, route.sessionKey);
    for (const candidateKey of candidateKeys) {
      const sessionEntry = readSessionStoreEntry(store, candidateKey);
      if (sessionEntry) {
        return { agentId: route.agentId, sessionEntry };
      }
    }
    return { agentId: route.agentId };
  } catch (err) {
    log.warn(
      `failed to load session for model picker account=${params.accountId} sender=${params.senderOpenId}: ${String(err)}`,
    );
    return undefined;
  }
}

function resolveCurrentModelIdFromSessionContext(params: {
  cfg: ClawdbotConfig;
  sessionCtx: SessionPickerContext | undefined;
  entries: ModelCatalogEntry[];
}): string | undefined {
  if (!params.sessionCtx?.sessionEntry) return undefined;
  return resolveCatalogModelIdFromSessionEntry({
    cfg: params.cfg,
    entry: params.sessionCtx.sessionEntry,
    agentId: params.sessionCtx.agentId,
    entries: params.entries,
  });
}

async function sendModelPickerCard(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
}): Promise<void> {
  const accountScopedCfg = createAccountScopedConfig(params.cfg, params.accountId);
  const catalogPromise = listModelCatalog(accountScopedCfg);
  const sessionCtx = loadSessionPickerContext({
    cfg: accountScopedCfg,
    accountId: params.accountId,
    senderOpenId: params.senderOpenId,
  });
  const catalog = await catalogPromise;

  if (catalog.entries.length === 0) {
    log.warn(
      `model picker empty catalog account=${params.accountId} openId=${params.senderOpenId} error=${catalog.error ?? 'empty'}`,
    );
    await sendCardFeishu({
      cfg: accountScopedCfg,
      to: params.senderOpenId,
      card: buildModelPickerErrorCard(),
      accountId: params.accountId,
    });
    return;
  }

  const fromSession = resolveCurrentModelIdFromSessionContext({
    cfg: accountScopedCfg,
    sessionCtx,
    entries: catalog.entries,
  });
  const currentModelId = fromSession ?? findPrimaryModelEntry(catalog.entries)?.modelId;

  await sendCardFeishu({
    cfg: accountScopedCfg,
    to: params.senderOpenId,
    card: buildModelPickerCard({ entries: catalog.entries, currentModelId }),
    accountId: params.accountId,
  });
}

export async function handleMenuPickModelEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  const payload = data as MenuV6EventPayload;
  const eventKey = resolveMenuEventKey(payload);
  if (eventKey !== MENU_EVENT_KEY_PICK_MODEL) return;

  const senderOpenId = resolveMenuOperatorOpenId(payload);
  if (!senderOpenId) {
    log.warn(`menu pick model missing operator account=${ctx.accountId}`);
    return;
  }

  const eventId = resolveMenuEventId(data);
  if (eventId && !ctx.messageDedup.tryRecord(eventId, `menu:${ctx.accountId}`)) {
    log.info(`menu pick model duplicate event_id=${eventId} account=${ctx.accountId}`);
    return;
  }

  try {
    await sendModelPickerCard({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      senderOpenId,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      `menu pick model failed account=${ctx.accountId} openId=${senderOpenId}: ${errMsg}`,
    );
    try {
      const accountScopedCfg = createAccountScopedConfig(ctx.cfg, ctx.accountId);
      await sendMessageFeishu({
        cfg: accountScopedCfg,
        to: senderOpenId,
        text: CARD_TEXTS.zh_cn.loadFailed,
        accountId: ctx.accountId,
      });
    } catch (notifyErr) {
      log.error(
        `menu pick model fallback text failed account=${ctx.accountId} openId=${senderOpenId}: ${String(notifyErr)}`,
      );
    }
  }
}

export function handleModelPickerAction(
  data: unknown,
  cfg: ClawdbotConfig,
  accountId: string,
): unknown | undefined {
  let action: string | undefined;
  let modelId: string | undefined;
  let senderOpenId: string | undefined;
  let openChatId: string | undefined;
  let openMessageId: string | undefined;

  try {
    const event = data as CardActionPayload;
    const rawValue = event.action?.value;
    const value =
      typeof rawValue === 'string'
        ? (JSON.parse(rawValue) as { action?: string; model_id?: string })
        : rawValue;
    action = value?.action;
    modelId = typeof value?.model_id === 'string' ? value.model_id.trim() : undefined;
    senderOpenId = resolveCardCallbackOperatorId(event.operator);
    openChatId = event.open_chat_id ?? event.context?.open_chat_id;
    openMessageId = event.open_message_id ?? event.context?.open_message_id;
  } catch {
    return undefined;
  }

  if (action !== ACTION_SET_MODEL || !modelId || !senderOpenId) return undefined;

  const accountScopedCfg = createAccountScopedConfig(cfg, accountId);
  const cachedCatalog = getCachedModelCatalog();
  const syntheticMessageId = `${openMessageId ?? senderOpenId}:set-model:${modelId}:${Date.now()}`;
  const chatId = openChatId ?? senderOpenId;

  setImmediate(() => {
    void dispatchSyntheticTextMessage({
      cfg: accountScopedCfg,
      accountId,
      chatId,
      senderOpenId: senderOpenId!,
      text: formatModelCommand(modelId!),
      syntheticMessageId,
      replyToMessageId: openMessageId ?? syntheticMessageId,
      chatType: 'p2p',
    }).catch((err) => {
      log.error(
        `model picker inject failed account=${accountId} openId=${senderOpenId} modelId=${modelId}: ${String(err)}`,
      );
    });
  });

  log.info(`model picker set_model account=${accountId} openId=${senderOpenId} modelId=${modelId}`);

  const response: Record<string, unknown> = {
    toast: {
      type: 'success',
      ...i18nToast(CARD_TEXTS.zh_cn.switchedTo(modelId), CARD_TEXTS.en_us.switchedTo(modelId)),
    },
  };
  if (cachedCatalog?.entries.length) {
    response.card = {
      type: 'raw',
      data: buildModelPickerCard({
        entries: cachedCatalog.entries,
        currentModelId: modelId,
      }),
    };
  }
  return response;
}
