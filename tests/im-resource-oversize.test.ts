/**
 * Tests for tool-side handling of Feishu's 100MB IM resource cap.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedGetTicket = vi.hoisted(() => vi.fn());
const mockedSendCardFeishu = vi.hoisted(() => vi.fn());

vi.mock('../src/core/lark-ticket', () => ({
  getTicket: (...args: unknown[]) => mockedGetTicket(...args),
}));

vi.mock('../src/messaging/outbound/send', async (importActual) => {
  const actual = await importActual<typeof import('../src/messaging/outbound/send')>();
  return { ...actual, sendCardFeishu: mockedSendCardFeishu };
});

import { handleOversizeResourceDownload } from '../src/tools/im-resource-oversize';
import { sendLargeFileHintOnce } from '../src/messaging/inbound/large-file-hint';
import { clearLargeFileHintDedupeForTest } from '../src/messaging/inbound/large-file-hint-dedupe';

describe('handleOversizeResourceDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLargeFileHintDedupeForTest();
  });

  it('sends the large-file guidance card in the current group chat context', async () => {
    mockedGetTicket.mockReturnValue({
      messageId: 'om_text_mention',
      chatId: 'oc_group',
      accountId: 'acct',
      startTime: Date.now(),
      chatType: 'group',
      threadId: 'omt_thread',
    });
    mockedSendCardFeishu.mockResolvedValueOnce({ messageId: 'om_hint' });

    const result = await handleOversizeResourceDownload({
      cfg: {} as never,
      err: Object.assign(new Error('Downloaded file size exceeds limit.'), { code: 234037, status: 400 }),
      messageId: 'om_file',
      fileKey: 'file_v3_big',
      fileName: 'big.zip',
      type: 'file',
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'handled',
      too_large: true,
      handled: true,
      card_sent: true,
      card_duplicate: false,
      message_id: 'om_file',
      file_key: 'file_v3_big',
      file_name: 'big.zip',
    });
    expect(result).not.toHaveProperty('error');
    expect(mockedSendCardFeishu).toHaveBeenCalledOnce();
    expect(mockedSendCardFeishu.mock.calls[0]?.[0]).toMatchObject({
      to: 'oc_group',
      replyToMessageId: 'om_text_mention',
      accountId: 'acct',
    });

    const card = mockedSendCardFeishu.mock.calls[0]?.[0]?.card as {
      body: { elements: Array<{ i18n_content: Record<string, string> }> };
    };
    expect(card.body.elements[0]?.i18n_content.zh_cn).toContain('引用刚发出的云文档消息并 @机器人');
  });

  it('does not send a second card when the same trigger already handled the same file', async () => {
    mockedGetTicket.mockReturnValue({
      messageId: 'om_text_mention',
      chatId: 'oc_group',
      accountId: 'acct',
      startTime: Date.now(),
      chatType: 'group',
    });
    mockedSendCardFeishu.mockResolvedValue({ messageId: 'om_hint' });

    await sendLargeFileHintOnce({
      accountScopedCfg: {} as never,
      accountId: 'acct',
      chatId: 'oc_group',
      messageId: 'om_text_mention',
      chatType: 'group',
      oversizeFiles: [{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' }],
      log: vi.fn(),
    });

    const result = await handleOversizeResourceDownload({
      cfg: {} as never,
      err: Object.assign(new Error('Downloaded file size exceeds limit.'), { code: 234037, status: 400 }),
      messageId: 'om_file',
      fileKey: 'file_v3_big',
      fileName: 'big.zip',
      type: 'file',
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'handled',
      handled: true,
      card_sent: false,
      card_duplicate: true,
    });
    expect(mockedSendCardFeishu).toHaveBeenCalledOnce();
  });

  it('returns a structured oversize result without sending when there is no ticket context', async () => {
    mockedGetTicket.mockReturnValue(undefined);

    const result = await handleOversizeResourceDownload({
      cfg: {} as never,
      err: Object.assign(new Error('Downloaded file size exceeds limit.'), { code: 234037, status: 400 }),
      messageId: 'om_file',
      fileKey: 'file_v3_big',
      type: 'file',
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'error',
      too_large: true,
      handled: false,
      card_sent: false,
      card_duplicate: false,
    });
    expect(mockedSendCardFeishu).not.toHaveBeenCalled();
  });
});
