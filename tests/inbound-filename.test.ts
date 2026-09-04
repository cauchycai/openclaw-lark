import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveMediaBuffer = vi.hoisted(() => vi.fn());
const detectMime = vi.hoisted(() => vi.fn());

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      media: { detectMime },
      channel: { media: { saveMediaBuffer } },
    },
  },
}));

vi.mock('../src/messaging/outbound/media', async (importActual) => {
  const actual = await importActual<typeof import('../src/messaging/outbound/media')>();
  return { ...actual, downloadMessageResourceFeishu: vi.fn() };
});

import { downloadMessageResourceFeishu } from '../src/messaging/outbound/media';
import { downloadResources } from '../src/messaging/inbound/media-resolver';

const mockedDownload = downloadMessageResourceFeishu as unknown as ReturnType<typeof vi.fn>;

describe('downloadResources filename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectMime.mockResolvedValue('application/pdf');
    saveMediaBuffer.mockResolvedValue({
      path: '/sandbox/.openclaw/media/inbound/saved.pdf',
      contentType: 'application/pdf',
    });
  });

  it('prefers the message JSON file_name over a garbled download header name', async () => {
    mockedDownload.mockResolvedValueOnce({
      buffer: Buffer.from('%PDF'),
      contentType: 'application/pdf',
      fileName: 'é¦²è.pdf',
    });

    await downloadResources({
      cfg: {} as never,
      messageId: 'om_test',
      maxBytes: 1024,
      resources: [{ type: 'file', fileKey: 'file_v3_x', fileName: '中文标题.pdf' }],
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/pdf',
      'inbound',
      1024,
      '中文标题.pdf',
    );
  });

  it('falls back to the download filename when the message has no file_name', async () => {
    mockedDownload.mockResolvedValueOnce({
      buffer: Buffer.from('%PDF'),
      contentType: 'application/pdf',
      fileName: '中文标题.pdf',
    });

    await downloadResources({
      cfg: {} as never,
      messageId: 'om_test',
      maxBytes: 1024,
      resources: [{ type: 'file', fileKey: 'file_v3_x' }],
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/pdf',
      'inbound',
      1024,
      '中文标题.pdf',
    );
  });

  it('repairs a latin1-mojibake JSON file_name before save', async () => {
    const mojibake = Buffer.from('中文标题测试.pdf', 'utf8').toString('latin1');
    mockedDownload.mockResolvedValueOnce({
      buffer: Buffer.from('%PDF'),
      contentType: 'application/pdf',
      fileName: mojibake,
    });

    await downloadResources({
      cfg: {} as never,
      messageId: 'om_test',
      maxBytes: 1024,
      resources: [{ type: 'file', fileKey: 'file_v3_x', fileName: mojibake }],
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/pdf',
      'inbound',
      1024,
      '中文标题测试.pdf',
    );
  });
});
