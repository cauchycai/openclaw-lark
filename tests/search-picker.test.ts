import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

const runtimeState = vi.hoisted(() => ({
  current: null as {
    config: {
      loadConfig: ReturnType<typeof vi.fn>;
      writeConfigFile: ReturnType<typeof vi.fn>;
    };
  } | null,
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
  });

  it('writes the selected provider through the live runtime config before returning success', async () => {
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
        type: 'success',
        content: 'Switched to Baidu Search',
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
