/**
 * Tests for inbound large-file guidance control flow.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedSendCardFeishu = vi.hoisted(() => vi.fn());

vi.mock('../src/messaging/outbound/send', async (importActual) => {
  const actual = await importActual<typeof import('../src/messaging/outbound/send')>();
  return { ...actual, sendCardFeishu: mockedSendCardFeishu };
});

import { handleLargeFileGuidance } from '../src/messaging/inbound/large-file-hint';
import { clearLargeFileHintDedupeForTest } from '../src/messaging/inbound/large-file-hint-dedupe';

const oversizeFiles = [{ fileKey: 'file_v3_big', fileName: 'big.zip', resourceType: 'file' as const }];

function makeParams(overrides: Partial<Parameters<typeof handleLargeFileGuidance>[0]> = {}) {
  return {
    accountScopedCfg: {} as never,
    accountId: 'acct',
    chatId: 'oc_group',
    messageId: 'om_text_mention',
    chatType: 'group' as const,
    oversizeFiles,
    source: 'direct' as const,
    log: vi.fn(),
    ...overrides,
  };
}

describe('handleLargeFileGuidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLargeFileHintDedupeForTest();
  });

  it('does nothing when there are no oversize files', async () => {
    await expect(handleLargeFileGuidance(makeParams({ oversizeFiles: [] }))).resolves.toBe(false);
    expect(mockedSendCardFeishu).not.toHaveBeenCalled();
  });

  it('sends a card and asks the caller to skip dispatch for direct oversize files', async () => {
    mockedSendCardFeishu.mockResolvedValueOnce({ messageId: 'om_hint' });

    await expect(handleLargeFileGuidance(makeParams())).resolves.toBe(true);
    expect(mockedSendCardFeishu).toHaveBeenCalledOnce();
    expect(mockedSendCardFeishu.mock.calls[0]?.[0]).toMatchObject({
      to: 'oc_group',
      replyToMessageId: 'om_text_mention',
      accountId: 'acct',
    });
  });

  it('does not suppress direct dispatch if the guidance card could not be sent', async () => {
    mockedSendCardFeishu.mockRejectedValueOnce(new Error('send failed'));

    await expect(handleLargeFileGuidance(makeParams())).resolves.toBe(false);
  });

  it('still asks the caller to skip dispatch for quoted oversize files when card sending fails', async () => {
    mockedSendCardFeishu.mockRejectedValueOnce(new Error('send failed'));

    await expect(handleLargeFileGuidance(makeParams({ source: 'quoted' }))).resolves.toBe(true);
  });
});
