/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Inbound guidance for files that exceed Feishu's 100MB IM-attachment cap.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { sendCardFeishu } from '../outbound/send';
import type { OversizeFileInfo } from './media-resolver';
import { buildLargeFileHintCard } from './large-file-hint-card';
import { reserveLargeFileHintFiles } from './large-file-hint-dedupe';

export interface LargeFileHintResult {
  /** True when the user-visible guidance has already been handled. */
  handled: boolean;
  /** True when this call actually sent a new card. */
  sent: boolean;
  /** True when all files were already covered by a recent card. */
  duplicate: boolean;
}

export interface LargeFileHintParams {
  accountScopedCfg: ClawdbotConfig;
  accountId?: string;
  chatId: string;
  messageId: string;
  chatType?: 'p2p' | 'group';
  replyInThread?: boolean;
  oversizeFiles: OversizeFileInfo[];
  log: (...args: unknown[]) => void;
}

function resolveHintChatType(chatId: string, chatType?: 'p2p' | 'group'): 'p2p' | 'group' | undefined {
  if (chatType) return chatType;
  return chatId.startsWith('oc_') ? 'group' : undefined;
}

/**
 * Send a guidance card when the inbound message carried files too large to
 * download. No-op when there are no oversize files.
 *
 * Best-effort: a failure to send the hint must never break inbound handling.
 */
export async function sendLargeFileHintOnce(params: LargeFileHintParams): Promise<LargeFileHintResult> {
  const { accountScopedCfg, accountId, chatId, messageId, replyInThread, oversizeFiles, log } = params;
  const chatType = resolveHintChatType(chatId, params.chatType);

  if (oversizeFiles.length === 0) {
    return { handled: false, sent: false, duplicate: false };
  }

  const reservation = reserveLargeFileHintFiles({ chatId, messageId, oversizeFiles });
  const { fresh } = reservation;
  if (fresh.length === 0) {
    log(`feishu: large-file guidance card already handled for ${oversizeFiles.length} oversize attachment(s)`);
    return { handled: true, sent: false, duplicate: true };
  }

  try {
    const card = buildLargeFileHintCard(fresh, chatType);
    await sendCardFeishu({
      cfg: accountScopedCfg,
      to: chatId,
      card,
      replyToMessageId: messageId,
      accountId,
      replyInThread,
    });
    log(`feishu: sent large-file guidance card for ${fresh.length} oversize attachment(s)`);
    return { handled: true, sent: true, duplicate: false };
  } catch (err) {
    reservation.release();
    log(`feishu: failed to send large-file guidance card: ${String(err)}`);
    return { handled: false, sent: false, duplicate: false };
  }
}

export async function handleLargeFileGuidance(params: LargeFileHintParams & {
  source: 'direct' | 'quoted';
}): Promise<boolean> {
  const { oversizeFiles, source, log } = params;
  if (oversizeFiles.length === 0) return false;

  const hintResult = await sendLargeFileHintOnce(params);
  const shouldSkipDispatch = source === 'quoted' || hintResult.handled;
  if (!shouldSkipDispatch) return false;

  log(
    source === 'quoted'
      ? `feishu: quoted oversize message; guidance ${hintResult.handled ? 'handled' : 'attempted'}, skipping agent dispatch`
      : `feishu: oversize message; guidance handled, skipping agent dispatch`,
  );
  return true;
}
