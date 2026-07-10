/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared 100MB IM-resource cap handling for Feishu resource download tools.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getTicket } from '../core/lark-ticket';
import { sendLargeFileHintOnce } from '../messaging/inbound/large-file-hint';
import { isOversizeResourceError, recoverFeishuErrorCode } from '../messaging/outbound/media';

export interface OversizeResourceToolParams {
  cfg: ClawdbotConfig;
  err: unknown;
  messageId: string;
  fileKey: string;
  fileName?: string;
  type: 'image' | 'file';
  log?: (...args: unknown[]) => void;
}

export async function handleOversizeResourceDownload(params: OversizeResourceToolParams): Promise<Record<string, unknown> | undefined> {
  const { cfg, err, messageId, fileKey, fileName, type, log } = params;
  const recovered = await recoverFeishuErrorCode(err);
  if (!isOversizeResourceError(err) && !isOversizeResourceError(recovered)) return undefined;

  const ticket = getTicket();
  let handled = false;
  let cardSent = false;
  let duplicateCard = false;
  if (ticket?.chatId && ticket.messageId) {
    const hintResult = await sendLargeFileHintOnce({
      accountScopedCfg: cfg,
      accountId: ticket.accountId,
      chatId: ticket.chatId,
      messageId: ticket.messageId,
      chatType: ticket.chatType,
      oversizeFiles: [{ fileKey, fileName, resourceType: type === 'image' ? 'image' : 'file' }],
      log: log ?? (() => undefined),
    });
    handled = hintResult.handled;
    cardSent = hintResult.sent;
    duplicateCard = hintResult.duplicate;
  }

  const common = {
    status: handled ? 'handled' : 'error',
    too_large: true,
    handled,
    card_sent: cardSent,
    card_duplicate: duplicateCard,
    message_id: messageId,
    file_key: fileKey,
    ...(fileName ? { file_name: fileName } : {}),
    type,
  };

  if (handled) {
    return {
      ...common,
      message: duplicateCard
        ? '当前飞书会话已发送过大文件处理引导卡片，无需再解释这个下载错误。'
        : '已向当前飞书会话发送大文件处理引导卡片，无需再解释这个下载错误。',
    };
  }

  return {
    ...common,
    error: '飞书 IM 消息资源超过 100MB，无法通过 messageResource 接口直接下载。请让用户先将文件保存到云盘，再通过「云文档」分享给机器人。',
    error_code: recovered.code ?? 234037,
    message: '未找到当前飞书消息上下文或卡片发送失败，请用大文件转云盘方式提示用户。',
  };
}
