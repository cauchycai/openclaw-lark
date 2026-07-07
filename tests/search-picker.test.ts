import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => fn(cmd, args, opts)),
  });
  return fn;
});

const runtimeState = vi.hoisted(() => ({
  current: null as {
    config?: {
      loadConfig: ReturnType<typeof vi.fn>;
      writeConfigFile: ReturnType<typeof vi.fn>;
    };
    gateway?: {
      request?: ReturnType<typeof vi.fn>;
      call?: ReturnType<typeof vi.fn>;
    };
  } | null,
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/runtime-store', () => ({
  tryGetLarkRuntime: () => runtimeState.current,
}));

vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
}));

import {
  ACTION_SET_SEARCH,
  buildSearchPickerCard,
  handleSearchPickerAction,
  listAvailableProviders,
} from '../src/tools/search-picker';

function createSearchConfig(provider = 'firecrawl'): ClawdbotConfig {
  return {
    plugins: {
      entries: {
        'turing-baidu': { enabled: true },
        firecrawl: { enabled: true },
      },
    },
    tools: {
      web: {
        search: { provider },
      },
    },
  } as ClawdbotConfig;
}

function createActionPayload(provider: string) {
  return {
    operator: { open_id: 'ou_user_1' },
    action: {
      value: {
        action: ACTION_SET_SEARCH,
        provider,
      },
    },
  };
}

describe('buildSearchPickerCard', () => {
  it('marks the current provider as primary', () => {
    const cfg = createSearchConfig('turing-baidu');
    const providers = listAvailableProviders(cfg);
    const card = buildSearchPickerCard({ providers, currentProviderId: 'turing-baidu' });

    const buttons = (card.body as { elements: Array<Record<string, unknown>> }).elements.filter(
      (el) => el.tag === 'button',
    );
    expect(buttons[0]).toMatchObject({
      type: 'primary',
      value: { action: ACTION_SET_SEARCH, provider: 'turing-baidu' },
    });
  });
});

describe('handleSearchPickerAction', () => {
  beforeEach(() => {
    runtimeState.current = null;
    execFileMock.mockReset();
    execFileMock.mockRejectedValue(new Error('gateway unavailable'));
  });

  it('applies the selected provider through Gateway config.patch before returning success', async () => {
    const gatewayRequest = vi.fn(async (method: string) => {
      if (method === 'config.get') return { hash: 'hash-1', config: createSearchConfig('firecrawl') };
      if (method === 'config.patch') return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });
    runtimeState.current = {
      gateway: {
        request: gatewayRequest,
      },
    };

    const result = await handleSearchPickerAction(
      createActionPayload('turing-baidu'),
      createSearchConfig(),
      'feishu-a1',
    );

    expect(gatewayRequest).toHaveBeenCalledWith('config.get', {});
    expect(gatewayRequest).toHaveBeenCalledWith('config.patch', {
      raw: JSON.stringify({ tools: { web: { search: { provider: 'turing-baidu' } } } }),
      baseHash: 'hash-1',
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to Baidu Search',
      },
    });
  });

  it('can apply the selected provider through Gateway CLI config.patch', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ hash: 'hash-cli', config: createSearchConfig('firecrawl') }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true }) });

    const result = await handleSearchPickerAction(
      createActionPayload('turing-baidu'),
      createSearchConfig(),
      'feishu-a1',
    );

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'openclaw',
      ['gateway', 'call', 'config.get', '--params', '{}', '--json'],
      { timeout: 30_000 },
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      [
        'gateway',
        'call',
        'config.patch',
        '--params',
        JSON.stringify({
          raw: JSON.stringify({ tools: { web: { search: { provider: 'turing-baidu' } } } }),
          baseHash: 'hash-cli',
        }),
        '--json',
      ],
      { timeout: 30_000 },
    );
    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to Baidu Search',
      },
    });
  });

  it('reports Gateway config.patch noop as runtime-unconfirmed', async () => {
    const gatewayRequest = vi.fn(async (method: string) => {
      if (method === 'config.get') return { hash: 'hash-1', config: createSearchConfig('turing-baidu') };
      if (method === 'config.patch') return { ok: true, noop: true };
      throw new Error(`unexpected method ${method}`);
    });
    runtimeState.current = {
      gateway: {
        request: gatewayRequest,
      },
    };

    const result = await handleSearchPickerAction(
      createActionPayload('turing-baidu'),
      createSearchConfig('turing-baidu'),
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'warning',
        content:
          'Saved Baidu Search, but the running Gateway did not confirm it was applied. Use Gateway config.patch or upgrade OpenClaw.',
      },
    });
  });

  it('falls back to live runtime config writes but reports runtime as unconfirmed', async () => {
    let liveConfig = createSearchConfig('firecrawl');
    const writeConfigFile = vi.fn(async (next: ClawdbotConfig) => {
      liveConfig = next;
    });
    runtimeState.current = {
      config: {
        loadConfig: vi.fn(() => liveConfig),
        writeConfigFile,
      },
    };

    const result = await handleSearchPickerAction(createActionPayload('turing-baidu'), liveConfig, 'feishu-a1');

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect((liveConfig as { tools?: { web?: { search?: { provider?: string } } } }).tools?.web?.search?.provider).toBe(
      'turing-baidu',
    );
    expect(result).toMatchObject({
      toast: {
        type: 'warning',
        content:
          'Saved Baidu Search, but the running Gateway did not confirm it was applied. Use Gateway config.patch or upgrade OpenClaw.',
      },
    });
  });

  it('returns an error toast when the runtime config write fails', async () => {
    const cfg = createSearchConfig('firecrawl');
    runtimeState.current = {
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(async () => {
          throw new Error('write failed');
        }),
      },
    };

    const result = await handleSearchPickerAction(createActionPayload('turing-baidu'), cfg, 'feishu-a1');

    expect(result).toMatchObject({
      toast: {
        type: 'error',
        content: 'Failed to switch the search provider. Try again later or contact your admin.',
      },
    });
  });
});
