/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu web-search provider picker (mirrors model-picker):
 * - application.bot.menu_v6 (event_key=turingclaw_pick_search) → send card
 * - card.action.trigger (action=set_search) → write `tools.web.search.provider`
 *
 * Unlike model-picker (which injects a `/model` chat command), there is no
 * `/search` chat command, so the action writes the single scoped config key
 * through the in-process OpenClaw runtime config API. `tools.*` hot-applies
 * under the default gateway reload mode, so no restart is needed. The provider
 * list is derived from enabled search plugins in config; the current provider
 * is read straight from `tools.web.search.provider`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { MonitorContext } from '../channel/types';
import { createAccountScopedConfig } from '../core/accounts';
import { resolveCardCallbackOperatorId } from '../core/card-action-operator';
import { larkLogger } from '../core/lark-logger';
import { tryGetLarkRuntime } from '../core/runtime-store';
import { sendCardFeishu, sendMessageFeishu } from '../messaging/outbound/send';

const log = larkLogger('tools/search-picker');
const execFileAsync = promisify(execFile);

export const MENU_EVENT_KEY_PICK_SEARCH = 'turingclaw_pick_search';
export const ACTION_SET_SEARCH = 'set_search';

type Locale = 'zh_cn' | 'en_us';

const I18N_CONFIG = {
  update_multi: true,
  locales: ['zh_cn', 'en_us'] as Locale[],
};

/**
 * Known web-search providers and the plugin entry that backs each one. A
 * provider is offered only when its backing plugin is enabled in config (so
 * the list is dynamic), plus the currently-selected provider is always shown.
 * Adding a provider is a one-line change here.
 */
interface LocalizedLabel {
  zh_cn: string;
  en_us: string;
}

interface SearchProvider {
  id: string;
  label: LocalizedLabel;
  /** plugins.entries key that must be enabled for this provider to be offered. */
  pluginKey?: string;
}

type SearchConfig = ClawdbotConfig & {
  tools?: {
    web?: {
      search?: {
        provider?: string;
      };
    };
  };
};

const KNOWN_PROVIDERS: readonly SearchProvider[] = [
  { id: 'turing-baidu', label: { zh_cn: '百度搜索', en_us: 'Baidu Search' }, pluginKey: 'turing-baidu' },
  { id: 'firecrawl', label: { zh_cn: '海外搜索', en_us: 'Global Search' }, pluginKey: 'firecrawl' },
];

const CARD_TEXTS = {
  zh_cn: {
    title: '选择搜索源',
    current: (label: string) => `当前：${label}`,
    auto: '自动检测',
    hint: '点击按钮切换网页搜索源',
    errorTitle: '无法加载搜索源',
    emptyBody: '当前没有可用的搜索源插件，请联系管理员。',
    switchFailed: '切换搜索源失败，请稍后再试或联系管理员。',
    switchedTo: (label: string) => `已切换至 ${label}`,
    unknownProvider: '未知搜索源，请重新打开选择卡片。',
  },
  en_us: {
    title: 'Select Search Provider',
    current: (label: string) => `Current: ${label}`,
    auto: 'Auto-detect',
    hint: 'Tap a button to switch the web search provider',
    errorTitle: 'Unable to load search providers',
    emptyBody: 'No search provider plugins are enabled. Contact your admin.',
    switchFailed: 'Failed to switch the search provider. Try again later or contact your admin.',
    switchedTo: (label: string) => `Switched to ${label}`,
    unknownProvider: 'Unknown search provider. Please reopen the picker.',
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
  header?: { event_id?: string };
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
  action?: {
    value?: { action?: string; provider?: string } | string;
  };
}

function resolveMenuOperatorOpenId(payload: MenuV6EventPayload): string | undefined {
  const operator = payload.event?.operator ?? payload.operator;
  if (!operator) return undefined;
  return operator.operator_id?.open_id || operator.open_id || operator.operator_id?.user_id || operator.user_id;
}

function resolveMenuEventKey(payload: MenuV6EventPayload): string | undefined {
  return payload.event?.event_key?.trim() || payload.event_key?.trim() || undefined;
}

function resolveMenuEventId(data: unknown): string | undefined {
  const payload = data as MenuV6EventPayload;
  return payload.header?.event_id?.trim() || undefined;
}

/** The active provider is just the `tools.web.search.provider` config field. */
export function resolveCurrentProviderId(cfg: ClawdbotConfig): string | undefined {
  const value = (cfg as { tools?: { web?: { search?: { provider?: unknown } } } }).tools?.web?.search?.provider;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Providers whose backing plugin is enabled, plus the current one. `currentId`
 * (a freshly-read provider id) is included even if it is not a known provider;
 * when omitted it falls back to the possibly-stale value in `cfg`.
 */
export function listAvailableProviders(cfg: ClawdbotConfig, currentId?: string): SearchProvider[] {
  const entries = ((cfg as { plugins?: { entries?: Record<string, { enabled?: boolean }> } }).plugins?.entries ??
    {}) as Record<string, { enabled?: boolean }>;
  const available = KNOWN_PROVIDERS.filter((p) => !p.pluginKey || entries[p.pluginKey]?.enabled === true).map((p) => ({
    ...p,
  }));

  const current = currentId ?? resolveCurrentProviderId(cfg);
  if (current && !available.some((p) => p.id === current)) {
    available.push({ id: current, label: { zh_cn: current, en_us: current } });
  }
  return available;
}

function findProvider(providers: SearchProvider[], id: string): SearchProvider | undefined {
  return providers.find((p) => p.id === id);
}

function formatButtonText(provider: SearchProvider, isCurrent: boolean) {
  const prefix = isCurrent ? '✅ ' : '';
  return i18nPlainText(`${prefix}${provider.label.zh_cn}`, `${prefix}${provider.label.en_us}`);
}

export function buildSearchPickerCard(params: {
  providers: SearchProvider[];
  currentProviderId?: string;
}): Record<string, unknown> {
  const { providers, currentProviderId } = params;
  const zh = CARD_TEXTS.zh_cn;
  const en = CARD_TEXTS.en_us;
  const currentProvider = currentProviderId ? findProvider(providers, currentProviderId) : undefined;
  const currentLabelZh = currentProvider?.label.zh_cn ?? currentProviderId ?? zh.auto;
  const currentLabelEn = currentProvider?.label.en_us ?? currentProviderId ?? en.auto;

  const buttons = providers.map((provider) => ({
    tag: 'button',
    type: currentProviderId === provider.id ? 'primary' : 'default',
    text: formatButtonText(provider, currentProviderId === provider.id),
    value: {
      action: ACTION_SET_SEARCH,
      provider: provider.id,
    },
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: {
      title: i18nPlainText(zh.title, en.title),
      subtitle: i18nPlainText(zh.current(currentLabelZh), en.current(currentLabelEn)),
      template: 'blue',
    },
    body: {
      elements: [i18nMarkdown(zh.hint, en.hint), ...buttons],
    },
  };
}

function buildSearchPickerErrorCard(): Record<string, unknown> {
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

/** Write the single scoped config key. `tools.*` hot-applies (no restart). */
async function applySearchProvider(provider: string): Promise<void> {
  const runtime = tryGetLarkRuntime();
  if (runtime?.config?.loadConfig && runtime.config.writeConfigFile) {
    const live = runtime.config.loadConfig() as ClawdbotConfig;
    if (live && typeof live === 'object' && Object.keys(live as Record<string, unknown>).length > 0) {
      const next = structuredClone(live) as SearchConfig;
      next.tools ??= {};
      next.tools.web ??= {};
      next.tools.web.search ??= {};
      next.tools.web.search.provider = provider;
      await runtime.config.writeConfigFile(next);
      return;
    }
  }

  // Compatibility fallback for tests or older hosts where the plugin runtime
  // config API is not available.
  await execFileAsync('openclaw', ['config', 'set', 'tools.web.search.provider', provider], {
    timeout: 30_000,
  });
}

/**
 * Read the current provider from the live runtime config first, with a CLI
 * fallback for older hosts. Returns undefined when unset (auto-detect) or on
 * any read error.
 */
async function getCurrentProviderId(): Promise<string | undefined> {
  try {
    const runtime = tryGetLarkRuntime();
    const live = runtime?.config?.loadConfig?.() as ClawdbotConfig | undefined;
    if (live) {
      const value = resolveCurrentProviderId(live);
      if (value) return value;
    }
  } catch {
    // Fall through to the CLI compatibility path below.
  }

  try {
    const { stdout } = await execFileAsync('openclaw', ['config', 'get', 'tools.web.search.provider'], {
      timeout: 15_000,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function sendSearchPickerCard(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
}): Promise<void> {
  const accountScopedCfg = createAccountScopedConfig(params.cfg, params.accountId);
  // Read the current provider from the live runtime snapshot so a reopened
  // picker reflects the latest switch.
  const currentId = (await getCurrentProviderId()) ?? resolveCurrentProviderId(accountScopedCfg);
  const providers = listAvailableProviders(accountScopedCfg, currentId);

  if (providers.length === 0) {
    log.warn(`search picker empty providers account=${params.accountId} openId=${params.senderOpenId}`);
    await sendCardFeishu({
      cfg: accountScopedCfg,
      to: params.senderOpenId,
      card: buildSearchPickerErrorCard(),
      accountId: params.accountId,
    });
    return;
  }

  await sendCardFeishu({
    cfg: accountScopedCfg,
    to: params.senderOpenId,
    card: buildSearchPickerCard({ providers, currentProviderId: currentId }),
    accountId: params.accountId,
  });
}

export async function handleMenuPickSearchEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  const payload = data as MenuV6EventPayload;
  if (resolveMenuEventKey(payload) !== MENU_EVENT_KEY_PICK_SEARCH) return;

  const senderOpenId = resolveMenuOperatorOpenId(payload);
  if (!senderOpenId) {
    log.warn(`menu pick search missing operator account=${ctx.accountId}`);
    return;
  }

  const eventId = resolveMenuEventId(data);
  if (eventId && !ctx.messageDedup.tryRecord(eventId, `menu:${ctx.accountId}`)) {
    log.info(`menu pick search duplicate event_id=${eventId} account=${ctx.accountId}`);
    return;
  }

  try {
    await sendSearchPickerCard({ cfg: ctx.cfg, accountId: ctx.accountId, senderOpenId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`menu pick search failed account=${ctx.accountId} openId=${senderOpenId}: ${errMsg}`);
    try {
      await sendMessageFeishu({
        cfg: createAccountScopedConfig(ctx.cfg, ctx.accountId),
        to: senderOpenId,
        text: CARD_TEXTS.zh_cn.switchFailed,
        accountId: ctx.accountId,
      });
    } catch (notifyErr) {
      log.error(`menu pick search fallback text failed account=${ctx.accountId}: ${String(notifyErr)}`);
    }
  }
}

export async function handleSearchPickerAction(
  data: unknown,
  cfg: ClawdbotConfig,
  accountId: string,
): Promise<unknown | undefined> {
  let action: string | undefined;
  let provider: string | undefined;
  let senderOpenId: string | undefined;

  try {
    const event = data as CardActionPayload;
    const rawValue = event.action?.value;
    const value =
      typeof rawValue === 'string' ? (JSON.parse(rawValue) as { action?: string; provider?: string }) : rawValue;
    action = value?.action;
    provider = typeof value?.provider === 'string' ? value.provider.trim() : undefined;
    senderOpenId = resolveCardCallbackOperatorId(event.operator);
  } catch {
    return undefined;
  }

  if (action !== ACTION_SET_SEARCH || !provider || !senderOpenId) return undefined;

  const accountScopedCfg = createAccountScopedConfig(cfg, accountId);
  const providers = listAvailableProviders(accountScopedCfg);
  const target = findProvider(providers, provider);
  if (!target) {
    log.warn(`search picker rejected provider account=${accountId} openId=${senderOpenId} provider=${provider}`);
    return {
      toast: {
        type: 'error',
        ...i18nToast(CARD_TEXTS.zh_cn.unknownProvider, CARD_TEXTS.en_us.unknownProvider),
      },
    };
  }

  try {
    await applySearchProvider(target.id);
    log.info(`search picker set provider account=${accountId} openId=${senderOpenId} provider=${target.id}`);
  } catch (err) {
    log.error(
      `search picker apply failed account=${accountId} openId=${senderOpenId} provider=${target.id}: ${String(err)}`,
    );
    return {
      toast: {
        type: 'error',
        ...i18nToast(CARD_TEXTS.zh_cn.switchFailed, CARD_TEXTS.en_us.switchFailed),
      },
    };
  }

  return {
    toast: {
      type: 'success',
      ...i18nToast(CARD_TEXTS.zh_cn.switchedTo(target.label.zh_cn), CARD_TEXTS.en_us.switchedTo(target.label.en_us)),
    },
    card: {
      type: 'raw',
      data: buildSearchPickerCard({ providers, currentProviderId: target.id }),
    },
  };
}
