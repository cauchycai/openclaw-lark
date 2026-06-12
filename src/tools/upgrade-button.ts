/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * /upgrade_feishu command handler.
 *
 * Flow:
 *   1. User sends "/upgrade_feishu" in Feishu chat
 *   2. Version check via orchestrator — already latest → reply and stop
 *   3. Call upgrade/init → get QR token → generate image → upload to Feishu
 *   4. Show card with QR code for admin to scan
 *   5. Consume upgrade/stream SSE → update card on progress / done / error
 *
 * Requires CLAW_SANDBOX_ID env var to be set in the sandbox (injected by orchestrator).
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import * as QRCode from 'qrcode';
import { createAccountScopedConfig, getLarkAccount } from '../core/accounts';
import { larkLogger } from '../core/lark-logger';
import { LarkClient } from '../core/lark-client';
import { OwnerAccessDeniedError, assertOwnerAccessStrict } from '../core/owner-policy';
import {
  fetchOrchestratorJwt,
  orchestratorApiUrl,
  resolveEaglelabApiKey,
  resolveOrchestratorUrl,
} from '../core/orchestrator-models';
import { sendMessageFeishu } from '../messaging/outbound/send';
import { uploadImageLark } from '../messaging/outbound/media';
import { createCardEntity, sendCardByCardId, updateCardKitCardForAuth } from '../card/cardkit';

const log = larkLogger('tools/upgrade-button');

export const UPGRADE_COMMAND = '/upgrade_feishu';

const CLAW_SANDBOX_ID_ENV = 'CLAW_SANDBOX_ID';

// Per-account in-flight guard — prevents concurrent upgrade flows
const pendingUpgrades = new Set<string>();
const UPGRADE_STREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const LATEST_FEISHU_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

type Locale = 'zh_cn' | 'en_us';

const I18N_CONFIG = {
  update_multi: true,
  locales: ['zh_cn', 'en_us'] as Locale[],
};

const TEXTS = {
  zh_cn: {
    qrTitle: '请扫码完成登录',
    qrBody: '请用**手机飞书**扫描下方二维码，登录后将自动完成权限更新和版本发布。',
    qrAlt: '升级二维码',
    progressTitle: '升级中...',
    successTitle: '升级成功 ✅',
    successBody: (name: string, ver: string) => `**${name || '机器人'}** 已升级至版本 \`${ver}\`，新功能和权限即刻生效。`,
    errorTitle: '升级失败 ❌',
    errorBody: (msg: string) => `升级过程中出现错误：\n\n${msg}`,
    alreadyLatest: (ver: string) => `当前版本已是最新（${ver}），无需升级。`,
    noSandboxId: '升级失败：环境未配置 sandbox ID，请联系管理员。',
    statusLabels: {
      configuring: '正在配置应用权限...',
      publishing: '正在发布新版本...',
      syncing: '正在同步配置...',
    } as Record<string, string>,
    statusFallback: (s: string) => `正在处理：${s}`,
  },
  en_us: {
    qrTitle: 'Scan QR Code to Log In',
    qrBody: 'Scan the QR code below with **Feishu mobile** to authorise the upgrade.',
    qrAlt: 'Upgrade QR code',
    progressTitle: 'Upgrading...',
    successTitle: 'Upgrade Complete ✅',
    successBody: (name: string, ver: string) => `**${name || 'Bot'}** has been upgraded to version \`${ver}\`. New features and permissions are now active.`,
    errorTitle: 'Upgrade Failed ❌',
    errorBody: (msg: string) => `An error occurred during the upgrade:\n\n${msg}`,
    alreadyLatest: (ver: string) => `Already on the latest version (${ver}). No upgrade needed.`,
    noSandboxId: 'Upgrade failed: sandbox ID not configured. Please contact your administrator.',
    statusLabels: {
      configuring: 'Configuring app permissions...',
      publishing: 'Publishing new version...',
      syncing: 'Syncing configuration...',
    } as Record<string, string>,
    statusFallback: (s: string) => `Processing: ${s}`,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpgradeInitResult {
  sandbox_id: string;
  account_id: string;
  app_id: string;
  qr_content: string;
  qr_token: string;
}

interface UpgradeSseEvent {
  type: 'status' | 'done' | 'error';
  status?: string;
  message?: string;
  feishu_display_name?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

function buildUpgradeQrCard(imageKey: string): Record<string, unknown> {
  const zh = TEXTS.zh_cn;
  const en = TEXTS.en_us;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: { title: i18nPlainText(zh.qrTitle, en.qrTitle), template: 'orange' },
    body: {
      elements: [
        i18nMarkdown(zh.qrBody, en.qrBody),
        { tag: 'img', img_key: imageKey, alt: i18nPlainText(zh.qrAlt, en.qrAlt) },
      ],
    },
  };
}

function buildUpgradeProgressCard(zhMsg: string, enMsg: string): Record<string, unknown> {
  const zh = TEXTS.zh_cn;
  const en = TEXTS.en_us;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: { title: i18nPlainText(zh.progressTitle, en.progressTitle), template: 'orange' },
    body: { elements: [i18nMarkdown(zhMsg, enMsg)] },
  };
}

function buildUpgradeSuccessCard(displayName: string, version: string): Record<string, unknown> {
  const zh = TEXTS.zh_cn;
  const en = TEXTS.en_us;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: { title: i18nPlainText(zh.successTitle, en.successTitle), template: 'green' },
    body: { elements: [i18nMarkdown(zh.successBody(displayName, version), en.successBody(displayName, version))] },
  };
}

function buildUpgradeErrorCard(message: string): Record<string, unknown> {
  const zh = TEXTS.zh_cn;
  const en = TEXTS.en_us;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: { title: i18nPlainText(zh.errorTitle, en.errorTitle), template: 'red' },
    body: { elements: [i18nMarkdown(zh.errorBody(message), en.errorBody(message))] },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSandboxId(): string | undefined {
  return process.env[CLAW_SANDBOX_ID_ENV]?.trim() || undefined;
}

async function getOrchestratorJwt(cfg: ClawdbotConfig): Promise<string | undefined> {
  const apiKey = resolveEaglelabApiKey(cfg);
  if (!apiKey) return undefined;
  return fetchOrchestratorJwt(apiKey, resolveOrchestratorUrl());
}

// ---------------------------------------------------------------------------
// Orchestrator API calls
// ---------------------------------------------------------------------------

async function fetchCurrentVersion(params: {
  cfg: ClawdbotConfig;
  sandboxId: string;
  accountId: string;
}): Promise<string | undefined> {
  const { cfg, sandboxId, accountId } = params;
  const jwt = await getOrchestratorJwt(cfg);
  if (!jwt) return undefined;

  const url = orchestratorApiUrl(resolveOrchestratorUrl(), 'channels/feishu');
  url.searchParams.set('sandbox_id', sandboxId);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { accounts?: Array<{ account_id?: string; version?: string }> };
    return (data.accounts ?? []).find((a) => a.account_id === accountId)?.version?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function callUpgradeInit(params: {
  cfg: ClawdbotConfig;
  sandboxId: string;
  accountId: string;
}): Promise<UpgradeInitResult> {
  const { cfg, sandboxId, accountId } = params;
  const jwt = await getOrchestratorJwt(cfg);
  if (!jwt) throw new Error('orchestrator auth failed: no JWT');

  const url = orchestratorApiUrl(resolveOrchestratorUrl(), 'channels/feishu/auto-bind/upgrade/init');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandbox_id: sandboxId, account_id: accountId }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`upgrade/init HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json() as Promise<UpgradeInitResult>;
}

async function consumeUpgradeStream(params: {
  cfg: ClawdbotConfig;
  sandboxId: string;
  accountId: string;
  onStatus: (status: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<UpgradeSseEvent> {
  const { cfg, sandboxId, accountId, onStatus, signal } = params;
  const jwt = await getOrchestratorJwt(cfg);
  if (!jwt) throw new Error('orchestrator auth failed: no JWT');

  const url = orchestratorApiUrl(resolveOrchestratorUrl(), 'channels/feishu/auto-bind/upgrade/stream');
  url.searchParams.set('sandbox_id', sandboxId);
  url.searchParams.set('account_id', accountId);

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` }, signal });
  if (!resp.ok || !resp.body) throw new Error(`upgrade/stream HTTP ${resp.status}`);

  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        const event = JSON.parse(raw) as UpgradeSseEvent;
        if (event.type === 'done' || event.type === 'error') return event;
        if (event.type === 'status' && event.status) await onStatus(event.status);
      } catch { /* ignore malformed lines */ }
    }
  }
  throw new Error('upgrade/stream ended without done/error event');
}

// ---------------------------------------------------------------------------
// /upgrade_feishu command entry point
// ---------------------------------------------------------------------------

export async function handleUpgradeCommand(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  senderOpenId: string;
  chatId: string;
  replyToMessageId?: string;
}): Promise<void> {
  const { cfg, accountId, senderOpenId, chatId, replyToMessageId } = params;
  const accountScopedCfg = createAccountScopedConfig(cfg, accountId);

  // Owner-only guard
  const acct = getLarkAccount(cfg, accountId);
  if (acct.configured) {
    try {
      const sdk = LarkClient.fromAccount(acct).sdk;
      await assertOwnerAccessStrict(acct, sdk, senderOpenId);
    } catch (err) {
      if (err instanceof OwnerAccessDeniedError) {
        log.warn(`upgrade command: non-owner attempt openId=${senderOpenId} account=${accountId}`);
        await sendMessageFeishu({
          cfg: accountScopedCfg,
          to: chatId,
          text: '仅应用所有者可执行升级操作。',
          accountId,
        });
        return;
      }
      throw err;
    }
  }

  // Concurrent upgrade guard
  if (pendingUpgrades.has(accountId)) {
    log.warn(`upgrade command: already in progress account=${accountId}`);
    await sendMessageFeishu({
      cfg: accountScopedCfg,
      to: chatId,
      text: '升级正在进行中，请勿重复触发。',
      accountId,
    });
    return;
  }

  const sandboxId = resolveSandboxId();
  if (!sandboxId) {
    log.warn(`upgrade command: CLAW_SANDBOX_ID not set account=${accountId}`);
    await sendMessageFeishu({
      cfg: accountScopedCfg,
      to: chatId,
      text: TEXTS.zh_cn.noSandboxId,
      accountId,
    });
    return;
  }

  // Version check — skip if already latest
  const currentVersion = await fetchCurrentVersion({ cfg: accountScopedCfg, sandboxId, accountId });
  if (currentVersion && currentVersion >= LATEST_FEISHU_VERSION) {
    log.info(`upgrade command: already latest version=${currentVersion} account=${accountId}`);
    await sendMessageFeishu({
      cfg: accountScopedCfg,
      to: chatId,
      text: TEXTS.zh_cn.alreadyLatest(currentVersion),
      accountId,
    });
    return;
  }

  log.info(`upgrade command: starting version=${currentVersion ?? 'unknown'} account=${accountId}`);

  pendingUpgrades.add(accountId);
  void runUpgradeFlow({ cfg: accountScopedCfg, accountId, sandboxId, chatId, replyToMessageId })
    .finally(() => pendingUpgrades.delete(accountId))
    .catch((err) => log.error(`upgrade flow unhandled error account=${accountId}: ${err}`));
}

// ---------------------------------------------------------------------------
// Upgrade flow (async)
// ---------------------------------------------------------------------------

async function runUpgradeFlow(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  sandboxId: string;
  chatId: string;
  replyToMessageId?: string;
}): Promise<void> {
  const { cfg, accountId, sandboxId, chatId, replyToMessageId } = params;

  const cardId = await createCardEntity({
    cfg,
    card: buildUpgradeProgressCard('正在初始化升级，请稍候...', 'Initialising upgrade, please wait...'),
    accountId,
  });
  if (!cardId) {
    log.error(`upgrade flow: createCardEntity failed account=${accountId}`);
    return;
  }

  await sendCardByCardId({
    cfg,
    to: chatId,
    cardId,
    replyToMessageId: replyToMessageId?.startsWith('om_') ? replyToMessageId : undefined,
    replyInThread: false,
    accountId,
  });

  let seq = 1;
  const updateCard = async (card: Record<string, unknown>) => {
    try {
      await updateCardKitCardForAuth({ cfg, cardId, card, sequence: ++seq, accountId });
    } catch (e) {
      log.warn(`upgrade updateCard seq=${seq} failed: ${e}`);
    }
  };

  try {
    // Step 1: init — get QR token
    const initResult = await callUpgradeInit({ cfg, sandboxId, accountId });

    // Step 2: generate QR image and upload to Feishu
    const qrBuffer = await QRCode.toBuffer(initResult.qr_content, { type: 'png', margin: 2, scale: 6 });
    const { imageKey } = await uploadImageLark({ cfg, image: qrBuffer, accountId });

    // Step 3: show QR card
    await updateCard(buildUpgradeQrCard(imageKey));
    log.info(`upgrade QR shown image_key=${imageKey} account=${accountId}`);

    // Step 4: consume SSE until done/error
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), UPGRADE_STREAM_TIMEOUT_MS);
    let lastStatus = '';
    let result: UpgradeSseEvent;
    try {
      result = await consumeUpgradeStream({
        cfg, sandboxId, accountId,
        onStatus: async (status) => {
          if (status === lastStatus) return;
          lastStatus = status;
          const zh = TEXTS.zh_cn.statusLabels[status] ?? TEXTS.zh_cn.statusFallback(status);
          const en = TEXTS.en_us.statusLabels[status] ?? TEXTS.en_us.statusFallback(status);
          await updateCard(buildUpgradeProgressCard(zh, en));
        },
        signal: abortCtrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (result.type === 'done') {
      const displayName = result.feishu_display_name ?? '机器人';
      const version = result.version ?? '最新版本';
      await updateCard(buildUpgradeSuccessCard(displayName, version));
      log.info(`upgrade done account=${accountId} version=${version}`);
    } else {
      await updateCard(buildUpgradeErrorCard(result.message ?? '未知错误'));
      log.warn(`upgrade error account=${accountId}: ${result.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`upgrade flow exception account=${accountId}: ${msg}`);
    await updateCard(buildUpgradeErrorCard(msg));
  }
}
