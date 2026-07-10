/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu guidance-card copy for files that exceed the IM resource cap.
 */

import { buildI18nMarkdownCard } from '../outbound/send';
import type { OversizeFileInfo } from './media-resolver';

type HintChatType = 'p2p' | 'group' | undefined;

export function buildLargeFileHintCard(oversizeFiles: OversizeFileInfo[], chatType: HintChatType): Record<string, unknown> {
  return buildI18nMarkdownCard({
    zh_cn: buildHintTextZh(oversizeFiles, chatType),
    en_us: buildHintTextEn(oversizeFiles, chatType),
  });
}

function buildHintTextZh(oversizeFiles: OversizeFileInfo[], chatType: HintChatType): string {
  const names = oversizeFiles.map((f) => f.fileName).filter((n): n is string => !!n);
  const nameLine = names.length > 0 ? `（${names.join('、')}）` : '';
  const isGroup = chatType === 'group';
  const shareStep =
    isGroup
      ? [
          '**2. 发送云文档到群聊**',
          '聊天界面右下角「+」→ 云文档 → 选择刚刚保存的文件',
          '',
          '**3. 引用刚发出的云文档消息并 @机器人**',
          '发送后，引用/回复那条云文档消息，再 @机器人并说明要处理什么。',
        ]
      : [
          '**2. 发送给我**',
          '聊天界面右下角「+」→ 云文档 → 选择刚刚保存的文件',
        ];

  return [
    `📎 **文件${nameLine}>=100mb，机器人无法直接接收**`,
    '',
    isGroup ? '请按下面三步把它发给我：' : '请按下面两步把它发给我：',
    '',
    '**1. 保存到云盘**',
    '· 手机版：点击文件消息 → 右上角「...」→ 保存到云盘',
    '· 电脑版：点击文件消息右下角「保存到云盘」图标',
    '',
    ...shareStep,
    '',
    '如果出现授权请求卡片，请点击「允许」。',
  ].join('\n');
}

function buildHintTextEn(oversizeFiles: OversizeFileInfo[], chatType: HintChatType): string {
  const names = oversizeFiles.map((f) => f.fileName).filter((n): n is string => !!n);
  const nameLine = names.length > 0 ? ` (${names.join(', ')})` : '';
  const isGroup = chatType === 'group';
  const shareStep =
    isGroup
      ? [
          '**2. Send the Drive file to the group chat**',
          'Chat bottom-right "+" → Docs → choose the file you just saved',
          '',
          '**3. Reply to that Drive-file message and @mention the bot**',
          'After sending it, quote/reply to that Drive-file message, then @mention the bot and say what to do.',
        ]
      : [
          '**2. Send it to me**',
          'Chat interface bottom-right "+" → Docs → choose the file you just saved',
        ];

  return [
    `📎 **File${nameLine} >=100mb; the bot can't receive it directly**`,
    '',
    isGroup ? 'Please send it to me in three steps:' : 'Please send it to me in two steps:',
    '',
    '**1. Save it to Drive**',
    '- Mobile: tap the file message → top-right "..." → Save to Drive',
    '- Desktop: click the "Save to Drive" icon at the bottom-right of the file message',
    '',
    ...shareStep,
    '',
    'If an authorization request card appears, please click "Allow".',
  ].join('\n');
}
