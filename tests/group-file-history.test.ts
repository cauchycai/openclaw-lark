/**
 * Group file messages do not @mention bots on Feishu.
 *
 * They should be kept as passive pending history until a later text message
 * explicitly @mentions this bot. Otherwise every bot in the group would
 * download or respond to the same unmentioned file event.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockParseMessageEvent = vi.fn();
const mockResolveSenderInfo = vi.fn();
const mockResolveMedia = vi.fn();
const mockCheckMessageGate = vi.fn();
const mockDispatchToAgent = vi.fn();
const mockHandleLargeFileGuidance = vi.fn();
const recordPendingHistoryEntryMock = vi.hoisted(() => vi.fn());

vi.mock('../src/messaging/inbound/parse', () => ({
  parseMessageEvent: (...args: unknown[]) => mockParseMessageEvent(...args),
}));

vi.mock('../src/messaging/inbound/enrich', () => ({
  resolveSenderInfo: (...args: unknown[]) => mockResolveSenderInfo(...args),
  prefetchUserNames: vi.fn(),
  resolveMedia: (...args: unknown[]) => mockResolveMedia(...args),
  resolveQuotedContent: vi.fn(),
  substituteMediaPaths: vi.fn(),
}));

vi.mock('../src/messaging/inbound/gate', () => ({
  checkMessageGate: (...args: unknown[]) => mockCheckMessageGate(...args),
  readFeishuAllowFromStore: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/messaging/inbound/large-file-hint', () => {
  return {
    handleLargeFileGuidance: (...args: unknown[]) => mockHandleLargeFileGuidance(...args),
  };
});

vi.mock('../src/messaging/inbound/handler-registry', () => ({
  injectInboundHandler: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch', () => ({
  dispatchToAgent: (...args: unknown[]) => mockDispatchToAgent(...args),
}));

vi.mock('../src/messaging/inbound/policy', () => ({
  resolveFeishuGroupConfig: vi.fn(),
  splitLegacyGroupAllowFrom: vi.fn().mockReturnValue({ senderAllowFrom: [] }),
}));

vi.mock('../src/messaging/inbound/bot-loop-guard', () => ({
  noteBotTurnAndCheck: vi.fn(() => ({ allowed: true, count: 1, limit: 10 })),
  resetBotLoop: vi.fn(),
}));

vi.mock('../src/core/accounts', () => ({
  getLarkAccount: vi.fn().mockReturnValue({
    accountId: 'acct',
    config: {},
    enabled: true,
    configured: true,
  }),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        commands: {
          shouldComputeCommandAuthorized: false,
          resolveCommandAuthorizedFromAuthorizers: vi.fn(),
        },
      },
    },
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/lark-ticket', () => ({
  ticketElapsed: () => 1,
}));

vi.mock('../src/channel/chat-queue', () => ({
  threadScopedKey: (chatId: string, threadId?: string) => `${chatId}:${threadId ?? ''}`,
}));

vi.mock('openclaw/plugin-sdk/reply-history', () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  recordPendingHistoryEntryIfEnabled: recordPendingHistoryEntryMock,
}));

vi.mock('openclaw/plugin-sdk/command-auth', () => ({
  resolveSenderCommandAuthorization: vi.fn().mockResolvedValue({ commandAuthorized: false }),
}));

vi.mock('openclaw/plugin-sdk/allow-from', () => ({
  isNormalizedSenderAllowed: vi.fn().mockReturnValue(false),
}));

import { handleFeishuMessage } from '../src/messaging/inbound/handler';

const cfg = { channels: { feishu: {} } } as never;

const event = {
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_file',
    chat_id: 'oc_group',
    chat_type: 'group',
    message_type: 'file',
    content: JSON.stringify({ file_key: 'file_v3_x', file_name: 'report.zip' }),
    create_time: '123',
  },
};

const ctx = {
  chatId: 'oc_group',
  messageId: 'om_file',
  senderId: 'ou_sender',
  senderName: 'Alice',
  chatType: 'group' as const,
  content: '<file key="file_v3_x" name="report.zip"/>',
  contentType: 'file',
  resources: [{ type: 'file' as const, fileKey: 'file_v3_x', fileName: 'report.zip' }],
  mentions: [],
  mentionAll: false,
  rawMessage: {},
  rawSender: { sender_type: 'user' },
  createTime: 123,
};

describe('handleFeishuMessage unmentioned group file history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });
    mockCheckMessageGate.mockResolvedValue({
      allowed: false,
      reason: 'no_mention',
      historyEntry: {
        sender: 'ou_sender',
        body: 'Alice: <file key="file_v3_x" name="report.zip"/>',
        timestamp: 123,
        messageId: 'om_file',
      },
    });
  });

  it('records the original file history passively without downloading, hinting, or dispatching', async () => {
    const chatHistories = new Map();

    await handleFeishuMessage({
      cfg,
      event: event as never,
      botOpenId: 'ou_bot',
      chatHistories,
      accountId: 'acct',
    });

    expect(mockResolveMedia).not.toHaveBeenCalled();
    expect(mockHandleLargeFileGuidance).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();

    const call = recordPendingHistoryEntryMock.mock.calls[0]?.[0];
    expect(call.historyKey).toBe('oc_group:');
    expect(call.entry).toMatchObject({
      sender: 'ou_sender',
      body: 'Alice: <file key="file_v3_x" name="report.zip"/>',
      timestamp: 123,
      messageId: 'om_file',
    });
  });
});
