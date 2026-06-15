import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockFetchOrchestratorJwt = vi.fn().mockResolvedValue('jwt_test');
vi.mock('../src/core/orchestrator-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/orchestrator-models')>();
  return {
    ...actual,
    fetchOrchestratorJwt: (...args: unknown[]) => mockFetchOrchestratorJwt(...args),
    resolveEaglelabApiKey: () => 'api-key',
    resolveOrchestratorUrl: () => 'https://orchestrator.example',
  };
});

const mockSendCardFeishu = vi.fn().mockResolvedValue({ messageId: 'om_restart_1', chatId: 'oc_1' });
const mockUpdateCardFeishu = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: (...args: unknown[]) => mockSendCardFeishu(...args),
  updateCardFeishu: (...args: unknown[]) => mockUpdateCardFeishu(...args),
}));

const mockAssertOwnerAccessStrict = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/core/owner-policy', () => ({
  OwnerAccessDeniedError: class OwnerAccessDeniedError extends Error {},
  assertOwnerAccessStrict: (...args: unknown[]) => mockAssertOwnerAccessStrict(...args),
}));

const mockLarkSdk = { im: { message: { create: vi.fn() } } };
vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromAccount: () => ({ sdk: mockLarkSdk }),
  },
}));

import {
  MENU_EVENT_KEY_RESTART,
  completePendingRestartNotification,
  handleMenuRestartEvent,
} from '../src/tools/restart-button';
import { RESTART_PENDING_ENV } from '../src/tools/restart-pending';

function createMonitorContext(overrides: Partial<{ tryRecord: boolean }> = {}) {
  return {
    cfg: {
      channels: {
        feishu: {
          accounts: {
            'feishu-a1': {
              appId: 'cli_test',
              appSecret: 'secret',
            },
          },
        },
      },
    },
    accountId: 'feishu-a1',
    messageDedup: {
      tryRecord: vi.fn(() => overrides.tryRecord ?? true),
    },
    log: vi.fn(),
    error: vi.fn(),
  } as never;
}

describe('handleMenuRestartEvent', () => {
  let pendingDir: string;
  let pendingPath: string;
  const originalSandboxId = process.env.SANDBOX_ID;
  const originalPendingEnv = process.env[RESTART_PENDING_ENV];

  beforeEach(() => {
    vi.clearAllMocks();
    pendingDir = mkdtempSync(join(tmpdir(), 'openclaw-lark-restart-'));
    pendingPath = join(pendingDir, 'restart-pending.json');
    process.env[RESTART_PENDING_ENV] = pendingPath;
    process.env.SANDBOX_ID = 'sandbox-1';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
    }) as never;
  });

  afterEach(() => {
    if (originalSandboxId === undefined) delete process.env.SANDBOX_ID;
    else process.env.SANDBOX_ID = originalSandboxId;
    if (originalPendingEnv === undefined) delete process.env[RESTART_PENDING_ENV];
    else process.env[RESTART_PENDING_ENV] = originalPendingEnv;
    rmSync(pendingDir, { recursive: true, force: true });
  });

  it('ignores non-restart menu events', async () => {
    await handleMenuRestartEvent(
      createMonitorContext(),
      { event: { event_key: 'other_menu', operator: { operator_id: { open_id: 'ou_1' } } } },
    );
    expect(mockSendCardFeishu).not.toHaveBeenCalled();
  });

  it('sends one restarting card, persists pending state, and defers the restart until after the ack', async () => {
    vi.useFakeTimers();
    try {
      await handleMenuRestartEvent(
        createMonitorContext(),
        {
          header: { event_id: 'evt_restart_1' },
          event: { event_key: MENU_EVENT_KEY_RESTART, operator: { operator_id: { open_id: 'ou_owner' } } },
        },
      );

      // The restarting card is sent and pending state persisted synchronously,
      // but the restart (and the success-card update) is deferred so the handler
      // can return and the SDK can ack the event first.
      expect(mockSendCardFeishu).toHaveBeenCalledTimes(1);
      expect(mockUpdateCardFeishu).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(pendingPath, 'utf8'))).toMatchObject({
        messageId: 'om_restart_1',
        accountId: 'feishu-a1',
      });

      // When the process survives the restart call, the deferred task updates the
      // same card to success and clears pending.
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockUpdateCardFeishu).toHaveBeenCalledTimes(1);
      expect(mockUpdateCardFeishu.mock.calls[0]?.[0]).toMatchObject({
        messageId: 'om_restart_1',
        accountId: 'feishu-a1',
      });
      expect(() => JSON.parse(readFileSync(pendingPath, 'utf8'))).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips duplicate restart while one is already in flight', async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({
        operatorOpenId: 'ou_owner',
        messageId: 'om_existing',
        accountId: 'feishu-a1',
        triggeredAt: Date.now(),
      }),
    );

    await handleMenuRestartEvent(
      createMonitorContext(),
      {
        header: { event_id: 'evt_restart_2' },
        event: { event_key: MENU_EVENT_KEY_RESTART, operator: { operator_id: { open_id: 'ou_owner' } } },
      },
    );

    expect(mockSendCardFeishu).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('completePendingRestartNotification', () => {
  let pendingDir: string;
  let pendingPath: string;
  const originalPendingEnv = process.env[RESTART_PENDING_ENV];

  beforeEach(() => {
    vi.clearAllMocks();
    pendingDir = mkdtempSync(join(tmpdir(), 'openclaw-lark-restart-complete-'));
    pendingPath = join(pendingDir, 'restart-pending.json');
    process.env[RESTART_PENDING_ENV] = pendingPath;
  });

  afterEach(() => {
    if (originalPendingEnv === undefined) delete process.env[RESTART_PENDING_ENV];
    else process.env[RESTART_PENDING_ENV] = originalPendingEnv;
    rmSync(pendingDir, { recursive: true, force: true });
  });

  it('updates the persisted restart card after startup', async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({
        operatorOpenId: 'ou_owner',
        messageId: 'om_restart_1',
        accountId: 'feishu-a1',
        triggeredAt: Date.now(),
      }),
    );

    await completePendingRestartNotification({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              'feishu-a1': {
                appId: 'cli_test',
                appSecret: 'secret',
              },
            },
          },
        },
      } as never,
      accountId: 'feishu-a1',
      pendingPath,
    });

    expect(mockUpdateCardFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'om_restart_1',
        accountId: 'feishu-a1',
      }),
    );
    expect(() => readFileSync(pendingPath, 'utf8')).toThrow();
  });
});
