import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveActiveEmbeddedRunSessionIdMock, queueAgentHarnessMessageMock, loadSteerRuntimeMock } =
  vi.hoisted(() => ({
    resolveActiveEmbeddedRunSessionIdMock: vi.fn(),
    queueAgentHarnessMessageMock: vi.fn(),
    loadSteerRuntimeMock: vi.fn(),
  }));

vi.mock('../src/messaging/inbound/steer-runtime', () => ({
  loadSteerRuntime: loadSteerRuntimeMock,
}));

import { trySteerMidRunFollowup } from '../src/messaging/inbound/dispatch-mid-run-steer';
import type { DispatchContext } from '../src/messaging/inbound/dispatch-context';

function createDc(): DispatchContext {
  return {
    account: { accountId: 'acc-1', config: {} },
    accountScopedCfg: {},
    ctx: {
      chatId: 'oc_chat',
      messageId: 'om_msg',
      senderId: 'ou_user',
      senderName: 'User',
      content: 'please also summarize',
      chatType: 'p2p',
    },
    route: { sessionKey: 'agent:main:feishu:acc-1:direct:ou_user', accountId: 'acc-1', agentId: 'main' },
    threadSessionKey: undefined,
    isThread: false,
    isGroup: false,
    commandAuthorized: true,
    envelopeFrom: 'feishu:ou_user',
    envelopeOptions: {},
    feishuFrom: 'feishu:ou_user',
    feishuTo: 'feishu:oc_chat',
    core: {
      channel: {
        reply: {},
      },
    },
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as DispatchContext;
}

describe('trySteerMidRunFollowup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue('session-active');
    queueAgentHarnessMessageMock.mockReturnValue(true);
    loadSteerRuntimeMock.mockResolvedValue({
      resolveActiveEmbeddedRunSessionId: resolveActiveEmbeddedRunSessionIdMock,
      queueAgentHarnessMessage: queueAgentHarnessMessageMock,
    });
  });

  it('injects into the active run via the harness queue API', async () => {
    const dc = createDc();
    const result = await trySteerMidRunFollowup({
      dc,
      steerText: 'please also summarize',
    });

    expect(result).toBe('steered');
    expect(resolveActiveEmbeddedRunSessionIdMock).toHaveBeenCalledWith(
      'agent:main:feishu:acc-1:direct:ou_user',
    );
    expect(queueAgentHarnessMessageMock).toHaveBeenCalledWith(
      'session-active',
      'please also summarize',
      { steeringMode: 'all', debounceMs: 0 },
    );
  });

  it('falls back when text is empty', async () => {
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: '   ',
    });
    expect(result).toBe('fallback');
    expect(loadSteerRuntimeMock).not.toHaveBeenCalled();
  });

  it('falls back when the message is already an explicit /steer', async () => {
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: '/steer keep going',
    });
    expect(result).toBe('fallback');
    expect(loadSteerRuntimeMock).not.toHaveBeenCalled();
  });

  it('falls back when steer runtime is unavailable', async () => {
    loadSteerRuntimeMock.mockResolvedValueOnce(null);
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: 'please also summarize',
    });
    expect(result).toBe('fallback');
    expect(queueAgentHarnessMessageMock).not.toHaveBeenCalled();
  });

  it('falls back when no active run is found', async () => {
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue(undefined);
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: 'please also summarize',
    });
    expect(result).toBe('fallback');
    expect(queueAgentHarnessMessageMock).not.toHaveBeenCalled();
  });

  it('retries when the active run temporarily rejects inject, then succeeds', async () => {
    queueAgentHarnessMessageMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: 'please also summarize',
    });
    expect(result).toBe('steered');
    expect(queueAgentHarnessMessageMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when the active run keeps rejecting inject', async () => {
    queueAgentHarnessMessageMock.mockReturnValue(false);
    const result = await trySteerMidRunFollowup({
      dc: createDc(),
      steerText: 'please also summarize',
    });
    expect(result).toBe('fallback');
    expect(queueAgentHarnessMessageMock.mock.calls.length).toBeGreaterThan(1);
  });
});
