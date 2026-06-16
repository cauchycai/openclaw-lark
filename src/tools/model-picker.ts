/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu dynamic model picker:
 * - application.bot.menu_v6 (event_key=turingclaw_pick_model) → send card
 * - card.action.trigger (action=set_model) → inject /model model_id
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
    unknownModel: '未知模型，请重新打开模型选择卡片',
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
    unknownModel: 'Unknown model. Please reopen the model picker.',
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
  // The "turing-claw/default" model is matched by the gateway using just
  // the short name "default". Other models use their full modelId as-is.
  if (modelId === 'turing-claw/default') {
    return '/model default';
  }
  return `/model ${modelId}`;
}

function resolveCurrentModelEntry(
  sessionModel: string | undefined,
  entries: ModelCatalogEntry[],
): ModelCatalogEntry | undefined {
  if (!sessionModel?.trim()) return undefined;
  const normalized = sessionModel.trim();
  const byRef = entries.find((entry) => entry.ref === normalized);
  if (byRef) return byRef;
  return entries.find(
    (entry) =>
      normalized === entry.modelId ||
      normalized.endsWith(`/${entry.modelId}`) ||
      normalized.endsWith(entry.modelId),
  );
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
  const candidates = [...new Set([modelRef.model, `${modelRef.provider}/${modelRef.model}`])];
  for (const candidate of candidates) {
    const entry = resolveCurrentModelEntry(candidate, entries);
    if (entry) return entry.modelId;
  }
  return undefined;
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

function resolveCurrentSessionModelId(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
  entries: ModelCatalogEntry[];
}): string | undefined {
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
    if (!store) return undefined;

    const candidateKeys = resolveCandidateSessionKeys(params.cfg, route.sessionKey);
    for (const candidateKey of candidateKeys) {
      const sessionEntry = readSessionStoreEntry(store, candidateKey);
      if (!sessionEntry) continue;
      const modelId = resolveCatalogModelIdFromSessionEntry({
        cfg: params.cfg,
        entry: sessionEntry,
        agentId: route.agentId,
        entries: params.entries,
      });
      if (modelId) return modelId;
    }
  } catch (err) {
    log.warn(
      `failed to resolve current session model account=${params.accountId} sender=${params.senderOpenId}: ${String(err)}`,
    );
  }

  return undefined;
}

function resolveDisplayedCurrentModelId(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
  entries: ModelCatalogEntry[];
}): string | undefined {
  const fromSession = resolveCurrentSessionModelId(params);
  if (fromSession) return fromSession;
  return findPrimaryModelEntry(params.entries)?.modelId;
}

async function sendModelPickerCard(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
}): Promise<void> {
  const accountScopedCfg = createAccountScopedConfig(params.cfg, params.accountId);
  const catalog = await listModelCatalog(accountScopedCfg);

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

  const currentModelId = resolveDisplayedCurrentModelId({
    cfg: accountScopedCfg,
    accountId: params.accountId,
    senderOpenId: params.senderOpenId,
    entries: catalog.entries,
  });

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
  if (cachedCatalog?.entries.length && !findModelEntry(cachedCatalog.entries, modelId)) {
    log.warn(`model picker rejected model_id account=${accountId} openId=${senderOpenId} modelId=${modelId}`);
    return {
      toast: {
        type: 'error',
        ...i18nToast(CARD_TEXTS.zh_cn.unknownModel, CARD_TEXTS.en_us.unknownModel),
      },
    };
  }

  const cachedEntry = findModelEntry(cachedCatalog?.entries ?? [], modelId);
  const displayName =
    cachedEntry?.name ?? findPrimaryModelEntry(cachedCatalog?.entries ?? [])?.name ?? CARD_TEXTS.zh_cn.unknown;
  const syntheticMessageId = `${openMessageId ?? senderOpenId}:set-model:${modelId}:${Date.now()}`;
  const chatId = openChatId ?? senderOpenId;

  setImmediate(() => {
    void (async () => {
      const catalog = await listModelCatalog(accountScopedCfg);
      const entry = findModelEntry(catalog.entries, modelId!);
      if (!entry) {
        log.warn(
          `model picker inject blocked unknown model_id account=${accountId} openId=${senderOpenId} modelId=${modelId}`,
        );
        return;
      }

      await dispatchSyntheticTextMessage({
        cfg: accountScopedCfg,
        accountId,
        chatId,
        senderOpenId: senderOpenId!,
        text: formatModelCommand(entry.modelId),
        syntheticMessageId,
        replyToMessageId: openMessageId ?? syntheticMessageId,
        chatType: 'p2p',
      });
    })().catch((err) => {
      log.error(
        `model picker inject failed account=${accountId} openId=${senderOpenId} modelId=${modelId}: ${String(err)}`,
      );
    });
  });

  log.info(`model picker set_model account=${accountId} openId=${senderOpenId} modelId=${modelId}`);

  const response: Record<string, unknown> = {
    toast: {
      type: 'success',
      ...i18nToast(CARD_TEXTS.zh_cn.switchedTo(displayName), CARD_TEXTS.en_us.switchedTo(displayName)),
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
