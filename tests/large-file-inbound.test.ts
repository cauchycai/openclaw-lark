/**
 * Tests for inbound large-file (>100MB) handling.
 */

import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// downloadResources only touches LarkClient.runtime after a successful
// download; the error paths under test never reach it. Quoted-message probes
// intentionally do not save successful downloads.
vi.mock('../src/core/lark-client', () => ({
  LarkClient: { runtime: {} },
}));

// Keep the real isOversizeResourceError; stub only the network download.
vi.mock('../src/messaging/outbound/media', async (importActual) => {
  const actual = await importActual<typeof import('../src/messaging/outbound/media')>();
  return { ...actual, downloadMessageResourceFeishu: vi.fn() };
});

const mockedSendCardFeishu = vi.hoisted(() => vi.fn());
const mockedGetMessageFeishu = vi.hoisted(() => vi.fn());

vi.mock('../src/messaging/outbound/send', async (importActual) => {
  const actual = await importActual<typeof import('../src/messaging/outbound/send')>();
  return { ...actual, sendCardFeishu: mockedSendCardFeishu };
});

vi.mock('../src/messaging/outbound/fetch', () => ({
  getMessageFeishu: (...args: unknown[]) => mockedGetMessageFeishu(...args),
}));

import {
  downloadMessageResourceFeishu,
  isOversizeResourceError,
  recoverFeishuErrorCode,
} from '../src/messaging/outbound/media';
import { downloadResources } from '../src/messaging/inbound/media-resolver';
import { resolveQuotedContent, substituteMediaPaths } from '../src/messaging/inbound/enrich';
import { sendLargeFileHintOnce } from '../src/messaging/inbound/large-file-hint';
import { clearLargeFileHintDedupeForTest } from '../src/messaging/inbound/large-file-hint-dedupe';

const mockedDownload = downloadMessageResourceFeishu as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearLargeFileHintDedupeForTest();
});

describe('isOversizeResourceError', () => {
  it('detects the real 234037 log shape', () => {
    const err = Object.assign(new Error('Downloaded file size exceeds limit.'), {
      code: 234037,
      status: 400,
    });
    expect(isOversizeResourceError(err)).toBe(true);
  });

  it('detects 234037 nested in response.data', () => {
    expect(isOversizeResourceError({ response: { data: { code: 234037 } } })).toBe(true);
  });

  it('detects 234037 embedded in the message string', () => {
    expect(isOversizeResourceError(new Error('request failed: 234037'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isOversizeResourceError(new Error('Not Found'))).toBe(false);
    expect(isOversizeResourceError({ code: 404 })).toBe(false);
    expect(isOversizeResourceError(null)).toBe(false);
  });
});

describe('recoverFeishuErrorCode', () => {
  const OVERSIZE_BODY = '{"code":234037,"msg":"Downloaded file size exceeds limit."}';

  it('drains a stream body and recovers 234037 (the real prod shape)', async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: Readable.from([Buffer.from(OVERSIZE_BODY)]) },
    });
    const { code, msg } = await recoverFeishuErrorCode(err);
    expect(code).toBe(234037);
    expect(msg).toBe('Downloaded file size exceeds limit.');
    expect(isOversizeResourceError(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it('recovers from a Buffer body', async () => {
    const err = { response: { data: Buffer.from(OVERSIZE_BODY) } };
    expect((await recoverFeishuErrorCode(err)).code).toBe(234037);
  });

  it('recovers from a string body', async () => {
    const err = { response: { data: OVERSIZE_BODY } };
    expect((await recoverFeishuErrorCode(err)).code).toBe(234037);
  });

  it('recovers from an already-parsed object body', async () => {
    const err = { response: { data: { code: 234037, msg: 'Downloaded file size exceeds limit.' } } };
    expect((await recoverFeishuErrorCode(err)).code).toBe(234037);
  });

  it('returns empty when there is no recoverable body', async () => {
    expect(await recoverFeishuErrorCode(new Error('boom'))).toEqual({});
    expect(await recoverFeishuErrorCode({ response: { data: 'not json' } })).toEqual({});
    expect(await recoverFeishuErrorCode(null)).toEqual({});
  });
});

describe('downloadResources', () => {
  const baseParams = {
    cfg: {} as never,
    messageId: 'om_test',
    maxBytes: 1024,
    log: vi.fn(),
    accountId: 'acct',
  };

  it('collects oversize files (234037) instead of dropping them', async () => {
    mockedDownload.mockRejectedValueOnce(
      Object.assign(new Error('Downloaded file size exceeds limit.'), { code: 234037, status: 400 }),
    );

    const result = await downloadResources({
      ...baseParams,
      resources: [{ type: 'file', fileKey: 'file_v3_big', fileName: 'big.zip' }],
    });

    expect(result.media).toHaveLength(0);
    expect(result.oversize).toEqual([{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' }]);
  });

  it('does not treat ordinary errors as oversize', async () => {
    mockedDownload.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await downloadResources({
      ...baseParams,
      resources: [{ type: 'file', fileKey: 'file_v3_x', fileName: 'x.pdf' }],
    });

    expect(result.media).toHaveLength(0);
    expect(result.oversize).toHaveLength(0);
  });
});

describe('substituteMediaPaths oversize handling', () => {
  it('replaces an oversize <file/> placeholder with a notice', () => {
    const out = substituteMediaPaths('A <file key="file_v3_big" name="big.zip"/> B', [], [
      { fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' },
    ]);

    expect(out).not.toContain('<file key=');
    expect(out).toContain('>=100mb');
    expect(out).toContain('big.zip');
  });

  it('replaces an oversize <video/> placeholder with a notice', () => {
    const out = substituteMediaPaths('A <video key="file_v3_big" name="movie.mp4" duration="1:23"/> B', [], [
      { fileKey: 'file_v3_big', fileName: 'movie.mp4', resourceType: 'video' },
    ]);

    expect(out).not.toContain('<video key=');
    expect(out).toContain('>=100mb');
    expect(out).toContain('movie.mp4');
  });

  it('replaces an oversize image placeholder with a notice', () => {
    const out = substituteMediaPaths('A ![image](img_v3_big) B', [], [
      { fileKey: 'img_v3_big', resourceType: 'image' },
    ]);

    expect(out).not.toContain('![image](img_v3_big)');
    expect(out).toContain('>=100mb');
  });

  it('leaves content untouched when there are no oversize files', () => {
    const input = 'plain text with no media';
    expect(substituteMediaPaths(input, [])).toBe(input);
  });
});

describe('sendLargeFileHintOnce', () => {
  it('sends a localized zh/en guidance card', async () => {
    mockedSendCardFeishu.mockResolvedValueOnce({ messageId: 'om_hint' });

    await expect(
      sendLargeFileHintOnce({
        accountScopedCfg: {} as never,
        accountId: 'acct',
        chatId: 'oc_test',
        messageId: 'om_test',
        oversizeFiles: [{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' }],
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ handled: true, sent: true, duplicate: false });

    const call = mockedSendCardFeishu.mock.calls[0]?.[0] as { card?: Record<string, unknown> };
    expect(call).toMatchObject({
      to: 'oc_test',
      replyToMessageId: 'om_test',
      accountId: 'acct',
    });

    const card = call.card as {
      config: { locales?: string[] };
      body: { elements: Array<{ content: string; i18n_content: Record<string, string> }> };
    };
    const element = card.body.elements[0]!;

    expect(card.config.locales).toEqual(['zh_cn', 'en_us']);
    expect(element.content).toBe(element.i18n_content.en_us);
    expect(element.i18n_content.zh_cn).toContain('文件（big.zip）>=100mb');
    expect(element.i18n_content.en_us).toContain('File (big.zip) >=100mb');
    expect(element.i18n_content.en_us).toContain('Save it to Drive');
  });

  it('adds quote-and-@ instructions for group chats', async () => {
    mockedSendCardFeishu.mockResolvedValueOnce({ messageId: 'om_hint' });

    await expect(
      sendLargeFileHintOnce({
        accountScopedCfg: {} as never,
        accountId: 'acct',
        chatId: 'oc_group',
        messageId: 'om_text_mention',
        chatType: 'group',
        oversizeFiles: [{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' }],
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ handled: true, sent: true, duplicate: false });

    const call = mockedSendCardFeishu.mock.calls[0]?.[0] as { card?: Record<string, unknown> };
    const card = call.card as {
      body: { elements: Array<{ content: string; i18n_content: Record<string, string> }> };
    };
    const element = card.body.elements[0]!;

    expect(element.i18n_content.zh_cn).toContain('引用刚发出的云文档消息并 @机器人');
    expect(element.i18n_content.zh_cn).toContain('引用/回复那条云文档消息');
    expect(element.i18n_content.en_us).toContain('Reply to that Drive-file message and @mention the bot');
  });

  it('deduplicates repeated cards for the same trigger message and file', async () => {
    mockedSendCardFeishu.mockResolvedValue({ messageId: 'om_hint' });
    const params = {
      accountScopedCfg: {} as never,
      accountId: 'acct',
      chatId: 'oc_group',
      messageId: 'om_text_mention',
      chatType: 'group' as const,
      oversizeFiles: [{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' as const }],
      log: vi.fn(),
    };

    await expect(sendLargeFileHintOnce(params)).resolves.toMatchObject({
      handled: true,
      sent: true,
      duplicate: false,
    });
    await expect(sendLargeFileHintOnce(params)).resolves.toMatchObject({
      handled: true,
      sent: false,
      duplicate: true,
    });
    expect(mockedSendCardFeishu).toHaveBeenCalledOnce();
  });
});

describe('resolveQuotedContent large-file handling', () => {
  it('keeps sub-100MB quoted files in the normal file-key form', async () => {
    mockedGetMessageFeishu.mockResolvedValueOnce({
      messageId: 'om_quoted_file',
      chatId: 'oc_group',
      chatType: 'group',
      content: '<file key="file_v3_small" name="small.zip"/>',
      resources: [{ type: 'file', fileKey: 'file_v3_small', fileName: 'small.zip' }],
      contentType: 'file',
    });
    mockedDownload.mockResolvedValueOnce({
      buffer: Buffer.from('small'),
      contentType: 'application/zip',
      fileName: 'small.zip',
    });

    const result = await resolveQuotedContent({
      ctx: {
        chatId: 'oc_group',
        messageId: 'om_text_mention',
        parentId: 'om_quoted_file',
        senderId: 'ou_sender',
        chatType: 'group',
        content: '看看这个',
        contentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        rawMessage: {} as never,
        rawSender: {} as never,
      },
      accountScopedCfg: {} as never,
      account: { accountId: 'acct', config: {}, configured: true, enabled: true } as never,
      log: vi.fn(),
    });

    expect(result?.content).toBe('[message_id=om_quoted_file] <file key="file_v3_small" name="small.zip"/>');
    expect(result?.oversizeFiles).toHaveLength(0);
    expect(mockedDownload).toHaveBeenCalledOnce();
    expect(mockedSendCardFeishu).not.toHaveBeenCalled();
  });

  it('marks a quoted file that exceeds the IM resource cap', async () => {
    mockedGetMessageFeishu.mockResolvedValueOnce({
      messageId: 'om_quoted_file',
      chatId: 'oc_group',
      chatType: 'group',
      content: '<file key="file_v3_big" name="big.zip"/>',
      resources: [{ type: 'file', fileKey: 'file_v3_big', fileName: 'big.zip' }],
      contentType: 'file',
    });
    mockedDownload.mockRejectedValueOnce(
      Object.assign(new Error('Downloaded file size exceeds limit.'), { code: 234037, status: 400 }),
    );

    const result = await resolveQuotedContent({
      ctx: {
        chatId: 'oc_group',
        messageId: 'om_text_mention',
        parentId: 'om_quoted_file',
        senderId: 'ou_sender',
        chatType: 'group',
        content: '看看这个',
        contentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        rawMessage: {} as never,
        rawSender: {} as never,
      },
      accountScopedCfg: {} as never,
      account: { accountId: 'acct', config: {}, configured: true, enabled: true } as never,
      log: vi.fn(),
    });

    expect(result?.content).toContain('[message_id=om_quoted_file]');
    expect(result?.content).toContain('>=100mb');
    expect(result?.content).not.toContain('<file key=');
    expect(result?.oversizeFiles).toEqual([{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' }]);
    expect(mockedSendCardFeishu).not.toHaveBeenCalled();
  });
});
