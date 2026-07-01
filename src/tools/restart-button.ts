/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu restart button.
 *
 * application.bot.menu_v6 (event_key=turingclaw_restart)
 *   → owner check → send one "restarting" card → persist pending state
 *   → return so the SDK acks the event, then fire agent-restart (deferred)
 *   → on next startup, finish the persisted pending restart notification
 *     (the restart kills this process before it can send the success card)
 *
 * Requires SANDBOX_ID env var (injected by orchestrator).
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { createAccountScopedConfig, getLarkAccount } from '../core/accounts';
import { larkLogger } from '../core/lark-logger';
import { LarkClient } from '../core/lark-client';
import { OwnerAccessDeniedError, assertOwnerAccessStrict } from '../core/owner-policy';
import {
  fetchOrchestratorJwt,
  orchestratorApiUrl,
  resolveEaglelabApiKey,
  resolveOrchestratorUrl,
  resolveUserJwtToken,
} from '../core/orchestrator-models';
import type { MonitorContext } from '../channel/types';
import { sendCardFeishu, updateCardFeishu } from '../messaging/outbound/send';
import {
  clearRestartPending,
  isRestartInFlight,
  isRestartPendingFresh,
  readRestartPending,
  resolveRestartPendingPath,
  writeRestartPending,
} from './restart-pending';

const log = larkLogger('tools/restart-button');

export const MENU_EVENT_KEY_RESTART = 'turingclaw_restart';
const SANDBOX_ID_ENV = 'SANDBOX_ID';

/**
 * Delay before firing the actual restart, so the handler can return and the SDK
 * can send its event ack first. Restarting synchronously kills this process
 * mid-handler before the ack goes out, which makes Feishu redeliver the click
 * and triggers repeated restarts.
 */
const RESTART_DEFER_MS = 1500;

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

type Locale = 'zh_cn' | 'en_us';

const I18N_CONFIG = { update_multi: true, locales: ['zh_cn', 'en_us'] as Locale[] };

function i18nContent(zh: string, en: string): Record<Locale, string> {
  return { zh_cn: zh, en_us: en };
}
function i18nPlainText(zh: string, en: string) {
  return { tag: 'plain_text' as const, content: en, i18n_content: i18nContent(zh, en) };
}
function i18nMarkdown(zh: string, en: string) {
  return { tag: 'markdown' as const, content: en, i18n_content: i18nContent(zh, en) };
}

function buildRestartCard(
  template: 'orange' | 'green' | 'red',
  titleZh: string, titleEn: string,
  bodyZh: string, bodyEn: string,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: { title: i18nPlainText(titleZh, titleEn), template },
    body: { elements: [i18nMarkdown(bodyZh, bodyEn)] },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MenuV6EventPayload {
  header?: { event_id?: string };
  event?: {
    event_key?: string;
    operator?: { operator_id?: { open_id?: string }; open_id?: string };
  };
  event_key?: string;
  operator?: { operator_id?: { open_id?: string }; open_id?: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveMenuEventKey(payload: MenuV6EventPayload): string | undefined {
  return payload.event?.event_key?.trim() || payload.event_key?.trim() || undefined;
}

function resolveMenuOperatorOpenId(payload: MenuV6EventPayload): string | undefined {
  const op = payload.event?.operator ?? payload.operator;
  return op?.operator_id?.open_id ?? op?.open_id;
}

function resolveMenuEventId(data: unknown): string | undefined {
  const payload = data as MenuV6EventPayload;
  return payload.header?.event_id?.trim() || undefined;
}

function resolveRestartDedupKey(eventId: string | undefined, senderOpenId: string): string {
  return eventId || `restart:${senderOpenId}`;
}

function resolveSandboxId(): string | undefined {
  const value = process.env[SANDBOX_ID_ENV]?.trim();
  return value || undefined;
}

async function getOrchestratorJwt(cfg: ClawdbotConfig): Promise<string | undefined> {
  const apiKey = resolveEaglelabApiKey(cfg);
  const userJwt = resolveUserJwtToken(cfg);
  if (!apiKey && !userJwt) return undefined;
  return fetchOrchestratorJwt(apiKey, resolveOrchestratorUrl(), { cfg });
}

// ---------------------------------------------------------------------------
// Orchestrator API call
// ---------------------------------------------------------------------------

async function callAgentRestart(params: { cfg: ClawdbotConfig; sandboxId: string }): Promise<void> {
  const { cfg, sandboxId } = params;
  const jwt = await getOrchestratorJwt(cfg);
  if (!jwt) throw new Error('orchestrator auth failed: no JWT');

  const url = orchestratorApiUrl(resolveOrchestratorUrl(), `sandboxes/${sandboxId}/agent-restart`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`agent-restart HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Pending restart completion (after process restart)
// ---------------------------------------------------------------------------

export async function completePendingRestartNotification(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  pendingPath?: string;
}): Promise<void> {
  const pendingPath = params.pendingPath ?? resolveRestartPendingPath();
  const pending = await readRestartPending(pendingPath);
  if (!pending || pending.accountId !== params.accountId || !isRestartPendingFresh(pending)) {
    if (pending && pending.accountId === params.accountId) {
      await clearRestartPending(pendingPath);
    }
    return;
  }

  const accountScopedCfg = createAccountScopedConfig(params.cfg, params.accountId);
  try {
    await updateCardFeishu({
      cfg: accountScopedCfg,
      messageId: pending.messageId,
      card: buildRestartCard(
        'green',
        '重启成功',
        'Restart Complete',
        '机器人已成功重启，可以继续使用。',
        'The bot has been restarted successfully.',
      ),
      accountId: params.accountId,
    });
    log.info(`restart completion card updated messageId=${pending.messageId} account=${params.accountId}`);
  } catch (err) {
    log.warn(
      `restart completion card update failed messageId=${pending.messageId} account=${params.accountId}: ${String(err)}`,
    );
  } finally {
    await clearRestartPending(pendingPath);
  }
}

async function updateRestartCard(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId: string;
  template: 'orange' | 'green' | 'red';
  titleZh: string;
  titleEn: string;
  bodyZh: string;
  bodyEn: string;
}): Promise<void> {
  await updateCardFeishu({
    cfg: params.cfg,
    messageId: params.messageId,
    card: buildRestartCard(
      params.template,
      params.titleZh,
      params.titleEn,
      params.bodyZh,
      params.bodyEn,
    ),
    accountId: params.accountId,
  });
}

// ---------------------------------------------------------------------------
// Menu event handler
// ---------------------------------------------------------------------------

export async function handleMenuRestartEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  const payload = data as MenuV6EventPayload;
  if (resolveMenuEventKey(payload) !== MENU_EVENT_KEY_RESTART) return;

  const senderOpenId = resolveMenuOperatorOpenId(payload);
  if (!senderOpenId) {
    log.warn(`restart menu missing operator account=${ctx.accountId}`);
    return;
  }

  const eventId = resolveMenuEventId(data);
  const dedupKey = resolveRestartDedupKey(eventId, senderOpenId);
  if (!ctx.messageDedup.tryRecord(dedupKey, `menu:${ctx.accountId}`)) {
    log.info(`restart menu duplicate dedupKey=${dedupKey}`);
    return;
  }

  const pendingPath = resolveRestartPendingPath();
  const inFlight = await readRestartPending(pendingPath);
  if (isRestartInFlight(inFlight)) {
    log.info(`restart menu ignored: restart already in flight account=${ctx.accountId}`);
    return;
  }

  const accountScopedCfg = createAccountScopedConfig(ctx.cfg, ctx.accountId);

  // Owner-only guard
  const acct = getLarkAccount(ctx.cfg, ctx.accountId);
  if (acct.configured) {
    try {
      const sdk = LarkClient.fromAccount(acct).sdk;
      await assertOwnerAccessStrict(acct, sdk, senderOpenId);
    } catch (err) {
      if (err instanceof OwnerAccessDeniedError) {
        log.warn(`restart menu: non-owner attempt openId=${senderOpenId} account=${ctx.accountId}`);
        await sendCardFeishu({
          cfg: accountScopedCfg,
          to: senderOpenId,
          card: buildRestartCard('red', '无权限', 'Permission Denied', '仅应用所有者可执行重启操作。', 'Only the app owner can restart the bot.'),
          accountId: ctx.accountId,
        });
        return;
      }
      throw err;
    }
  }

  const sandboxId = resolveSandboxId();
  if (!sandboxId) {
    log.warn(`restart menu: SANDBOX_ID not set account=${ctx.accountId}`);
    await sendCardFeishu({
      cfg: accountScopedCfg,
      to: senderOpenId,
      card: buildRestartCard('red', '重启失败', 'Restart Failed', '环境未配置 SANDBOX_ID，请联系管理员。', 'SANDBOX_ID is not configured. Please contact your administrator.'),
      accountId: ctx.accountId,
    });
    return;
  }

  // Send one card up front and update it in place. Persist pending state so a
  // post-restart startup can finish the notification if this process dies.
  const restartingCard = buildRestartCard(
    'orange',
    '正在重启...',
    'Restarting...',
    '正在重启机器人，请稍候片刻。',
    'Restarting the bot, please wait a moment.',
  );
  const sent = await sendCardFeishu({
    cfg: accountScopedCfg,
    to: senderOpenId,
    card: restartingCard,
    accountId: ctx.accountId,
  });
  if (!sent.messageId) {
    log.warn(`restart menu: restarting card missing messageId account=${ctx.accountId}`);
    return;
  }

  await writeRestartPending({
    operatorOpenId: senderOpenId,
    messageId: sent.messageId,
    accountId: ctx.accountId,
    triggeredAt: Date.now(),
  });

  log.info(`restart triggered sandbox=${sandboxId} account=${ctx.accountId} messageId=${sent.messageId}`);

  // Fire the restart only after this handler returns, so the SDK can send its
  // event ack first. The restart kills this process; if we awaited it here the
  // ack would never go out and Feishu would redeliver the click. The success
  // card is normally finished by completePendingRestartNotification on the next
  // startup — the branch below only updates it when the process happens to
  // survive the restart call.
  const finishRestart = async (): Promise<void> => {
    try {
      await callAgentRestart({ cfg: accountScopedCfg, sandboxId });
      log.info(`restart completed sandbox=${sandboxId} account=${ctx.accountId}`);
      await updateRestartCard({
        cfg: accountScopedCfg,
        messageId: sent.messageId,
        accountId: ctx.accountId,
        template: 'green',
        titleZh: '重启成功',
        titleEn: 'Restart Complete',
        bodyZh: '机器人已成功重启，可以继续使用。',
        bodyEn: 'The bot has been restarted successfully.',
      }).catch(() => {});
      await clearRestartPending(pendingPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`restart failed sandbox=${sandboxId} account=${ctx.accountId}: ${msg}`);
      // Only notify on definitive failures, not timeouts/network drops caused by the restart itself
      if (!msg.toLowerCase().includes('abort') && !msg.toLowerCase().includes('network')) {
        await updateRestartCard({
          cfg: accountScopedCfg,
          messageId: sent.messageId,
          accountId: ctx.accountId,
          template: 'red',
          titleZh: '重启失败',
          titleEn: 'Restart Failed',
          bodyZh: `重启过程中出现错误：${msg}`,
          bodyEn: `An error occurred during restart: ${msg}`,
        }).catch(() => {});
        await clearRestartPending(pendingPath);
      }
    }
  };

  setTimeout(() => void finishRestart(), RESTART_DEFER_MS);
}
