import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback?: (err: null, stdout: string, stderr: string) => void) => {
    callback?.(null, '', '');
  }),
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockListAvailableModelsFromOrchestrator = vi.fn();
vi.mock('../src/core/orchestrator-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/orchestrator-models')>();
  return {
    ...actual,
    listAvailableModelsFromOrchestrator: (...args: unknown[]) => mockListAvailableModelsFromOrchestrator(...args),
  };
});

const mockSendCardFeishu = vi.fn().mockResolvedValue({ messageId: 'msg_1', chatId: 'oc_1' });
const mockSendMessageFeishu = vi.fn().mockResolvedValue({ messageId: 'msg_2', chatId: 'oc_1' });
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: (...args: unknown[]) => mockSendCardFeishu(...args),
  sendMessageFeishu: (...args: unknown[]) => mockSendMessageFeishu(...args),
}));

const mockDispatchSyntheticTextMessage = vi.fn().mockResolvedValue('ok');
vi.mock('../src/messaging/inbound/synthetic-message', () => ({
  dispatchSyntheticTextMessage: (...args: unknown[]) => mockDispatchSyntheticTextMessage(...args),
}));

import {
  ACTION_SET_MODEL,
  ACTION_SET_THINKING,
  MENU_EVENT_KEY_PICK_MODEL,
  buildModelPickerCard,
  handleMenuPickModelEvent,
  handleModelPickerAction,
  resolveCatalogModelIdFromSessionEntry,
  resolveCatalogModelIdFromSessionModelRef,
} from '../src/tools/model-picker';
import { clearModelCatalogCache, findPrimaryModelEntry, listModelCatalog } from '../src/core/model-catalog';

function thinkingButtonLabels(card: Record<string, unknown>): string[] {
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const row = elements.find((element) => element.tag === 'column_set');
  const columns = (row?.columns ?? []) as Array<{ elements: Array<{ text?: { content?: string } }> }>;
  return columns.map((column) => column.elements[0]?.text?.content ?? '');
}

const SAMPLE_ENTRIES = [
  {
    modelId: 'turing-claw/glm',
    name: 'glm-5.1',
    label: 'glm-5.1 · 1.0x cost',
    ref: 'eaglelab/turing-claw/glm',
    isPrimary: false,
  },
  {
    modelId: 'turing-claw/default',
    name: 'Turing Default Model',
    label: 'Turing Default Model · 1.0x cost',
    ref: 'eaglelab/turing-claw/default',
    isPrimary: true,
  },
];

function createMonitorContext(overrides: Partial<{ tryRecord: boolean }> = {}) {
  return {
    cfg: {} as never,
    accountId: 'feishu-a1',
    messageDedup: {
      tryRecord: vi.fn(() => overrides.tryRecord ?? true),
    },
    log: vi.fn(),
    error: vi.fn(),
  } as never;
}

describe('resolveCatalogModelIdFromSessionEntry', () => {
  it('reads /model override from modelOverride fields', () => {
    const modelId = resolveCatalogModelIdFromSessionEntry({
      cfg: {
        agents: {
          defaults: {
            model: { primary: 'eaglelab/turing-claw/default' },
          },
        },
        models: {
          providers: {
            eaglelab: {
              models: [{ id: 'turing-claw/default', name: 'default' }],
            },
          },
        },
      } as never,
      agentId: 'main',
      entry: {
        providerOverride: 'eaglelab',
        modelOverride: 'turing-claw/glm',
        modelOverrideSource: 'user',
      },
      entries: SAMPLE_ENTRIES,
    });
    expect(modelId).toBe('turing-claw/glm');
  });

  it('maps legacy providerOverride=turing-claw + modelOverride=default', () => {
    const modelId = resolveCatalogModelIdFromSessionEntry({
      cfg: {
        agents: {
          defaults: {
            model: { primary: 'eaglelab/turing-claw/default' },
          },
        },
      } as never,
      agentId: 'main',
      entry: {
        providerOverride: 'turing-claw',
        modelOverride: 'default',
        modelOverrideSource: 'user',
      },
      entries: SAMPLE_ENTRIES,
    });
    expect(modelId).toBe('turing-claw/default');
  });

  it('maps provider/model ref to orchestrator model_id', () => {
    expect(
      resolveCatalogModelIdFromSessionModelRef(
        { provider: 'eaglelab', model: 'turing-claw/glm' },
        SAMPLE_ENTRIES,
      ),
    ).toBe('turing-claw/glm');
  });

  it('maps eaglelab-responses session ref to catalog model_id', () => {
    const entries = [
      ...SAMPLE_ENTRIES,
      {
        modelId: 'turing/gpt-6-astra',
        name: 'GPT-6 Astra',
        label: 'GPT-6 Astra · 1.0x cost',
        ref: 'eaglelab-responses/turing/gpt-6-astra',
        isPrimary: false,
      },
    ];
    expect(
      resolveCatalogModelIdFromSessionModelRef(
        { provider: 'eaglelab-responses', model: 'turing/gpt-6-astra' },
        entries,
      ),
    ).toBe('turing/gpt-6-astra');
  });

  it('resolves tail segment when session stores short model id', () => {
    expect(
      resolveCatalogModelIdFromSessionModelRef({ provider: 'eaglelab', model: 'glm' }, SAMPLE_ENTRIES),
    ).toBe('turing-claw/glm');
  });

  it('disambiguates duplicate tails using full session model id', () => {
    const entries = [
      ...SAMPLE_ENTRIES,
      {
        modelId: 'turing-claw/kimi',
        name: 'kimi-k2.6',
        label: 'kimi-k2.6 · 1.0x cost',
        ref: 'eaglelab/turing-claw/kimi',
        isPrimary: false,
      },
      {
        modelId: 'legacy-claw/kimi',
        name: 'legacy-kimi',
        label: 'legacy-kimi · 1.0x cost',
        ref: 'eaglelab/legacy-claw/kimi',
        isPrimary: false,
      },
    ];
    expect(
      resolveCatalogModelIdFromSessionModelRef(
        { provider: 'eaglelab', model: 'turing-claw/kimi' },
        entries,
      ),
    ).toBe('turing-claw/kimi');
  });
});

describe('findPrimaryModelEntry', () => {
  it('returns the entry marked isPrimary', () => {
    expect(findPrimaryModelEntry(SAMPLE_ENTRIES)?.name).toBe('Turing Default Model');
    expect(findPrimaryModelEntry([SAMPLE_ENTRIES[0]])).toBeUndefined();
  });
});

describe('buildModelPickerCard', () => {
  it('includes model_id in button value', () => {
    const card = buildModelPickerCard({
      currentModelId: 'turing-claw/glm',
      entries: SAMPLE_ENTRIES,
    });

    const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const buttons = elements.filter((el) => el.tag === 'button');
    expect(buttons[0]).toMatchObject({
      type: 'primary',
      value: {
        action: ACTION_SET_MODEL,
        model_id: 'turing-claw/glm',
        model_ref: 'eaglelab/turing-claw/glm',
      },
    });
    expect((buttons[0].text as { content: string }).content).toBe('✅ glm-5.1 · 1.0x cost');
    expect(card.header).toMatchObject({
      subtitle: {
        content: 'Current: glm-5.1 · Thinking: Light thinking',
        i18n_content: {
          zh_cn: '当前：glm-5.1 · 思考：轻度思考',
          en_us: 'Current: glm-5.1 · Thinking: Light thinking',
        },
      },
    });
  });

  it('falls back to primary name when current model is unknown', () => {
    const card = buildModelPickerCard({ entries: SAMPLE_ENTRIES });
    expect(card.header).toMatchObject({
      subtitle: {
        content: 'Current: Turing Default Model · Thinking: Light thinking',
        i18n_content: {
          zh_cn: '当前：Turing Default Model · 思考：轻度思考',
          en_us: 'Current: Turing Default Model · Thinking: Light thinking',
        },
      },
    });
    const buttons = (card.body as { elements: Array<Record<string, unknown>> }).elements.filter(
      (el) => el.tag === 'button',
    );
    expect(buttons[1]).toMatchObject({ type: 'primary' });
  });

  it('shows an empty thinking level as Light thinking', () => {
    const card = buildModelPickerCard({
      entries: SAMPLE_ENTRIES,
      currentModelId: 'turing-claw/default',
      currentThinkingLevel: undefined,
    });
    const labels = thinkingButtonLabels(card);
    expect(labels).toEqual(['Quick answer', '✅ Light thinking', 'Medium thinking', 'Deep thinking']);
  });

  it('keeps Medium thinking selected and folds xhigh into Deep thinking', () => {
    const medium = buildModelPickerCard({
      entries: SAMPLE_ENTRIES,
      currentThinkingLevel: 'medium',
    });
    expect(thinkingButtonLabels(medium)).toContain('✅ Medium thinking');

    const extraHigh = buildModelPickerCard({
      entries: SAMPLE_ENTRIES,
      currentThinkingLevel: 'xhigh',
    });
    expect(thinkingButtonLabels(extraHigh)).toContain('✅ Deep thinking');
    expect(thinkingButtonLabels(extraHigh)).not.toContain('✅ Quick answer');
  });
});

describe('handleMenuPickModelEvent', () => {
  beforeEach(() => {
    mockSendCardFeishu.mockClear();
    mockSendMessageFeishu.mockClear();
    mockListAvailableModelsFromOrchestrator.mockResolvedValue({ entries: SAMPLE_ENTRIES });
    clearModelCatalogCache();
  });

  it('sends model picker card for matching menu event', async () => {
    await handleMenuPickModelEvent(createMonitorContext(), {
      header: { event_id: 'evt_menu_1', event_type: 'application.bot.menu_v6' },
      event: {
        event_key: MENU_EVENT_KEY_PICK_MODEL,
        operator: { operator_id: { open_id: 'ou_user_1' } },
      },
    });

    expect(mockSendCardFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ou_user_1',
        accountId: 'feishu-a1',
      }),
    );
  });
});

describe('handleModelPickerAction', () => {
  beforeEach(() => {
    mockDispatchSyntheticTextMessage.mockClear();
    mockListAvailableModelsFromOrchestrator.mockClear();
    mockListAvailableModelsFromOrchestrator.mockResolvedValue({ entries: SAMPLE_ENTRIES });
    clearModelCatalogCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('toast and inject use model_id', async () => {
    await listModelCatalog({} as never);
    mockListAvailableModelsFromOrchestrator.mockClear();

    const result = handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_MODEL, model_id: 'turing-claw/glm' } },
      },
      {} as never,
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to turing-claw/glm',
        i18n: { zh_cn: '已切换至 turing-claw/glm', en_us: 'Switched to turing-claw/glm' },
      },
    });

    await vi.runAllTimersAsync();
    expect(mockListAvailableModelsFromOrchestrator).not.toHaveBeenCalled();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab/turing-claw/glm',
      }),
    );
  });

  it('injects full provider/model ref for default model', async () => {
    await listModelCatalog({} as never);

    handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_MODEL, model_id: 'turing-claw/default' } },
      },
      {} as never,
      'feishu-a1',
    );

    await vi.runAllTimersAsync();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab/turing-claw/default',
      }),
    );
  });

  it('injects eaglelab/model_id without catalog lookup', async () => {
    const result = handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_MODEL, model_id: 'turing-claw/glm' } },
      },
      {} as never,
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to turing-claw/glm',
        i18n: { zh_cn: '已切换至 turing-claw/glm', en_us: 'Switched to turing-claw/glm' },
      },
    });
    await vi.runAllTimersAsync();
    expect(mockListAvailableModelsFromOrchestrator).not.toHaveBeenCalled();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab/turing-claw/glm',
      }),
    );
  });

  it('does not reject model_id when cached catalog lacks the entry', async () => {
    await listModelCatalog({} as never);

    const result = handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_MODEL, model_id: 'turing-claw/new-model' } },
      },
      {} as never,
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to turing-claw/new-model',
        i18n: { zh_cn: '已切换至 turing-claw/new-model', en_us: 'Switched to turing-claw/new-model' },
      },
    });

    await vi.runAllTimersAsync();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab/turing-claw/new-model',
      }),
    );
  });

  it('injects catalog OpenClaw ref for Responses models', async () => {
    mockListAvailableModelsFromOrchestrator.mockResolvedValue({
      entries: [
        {
          modelId: 'turing/gpt-6-astra',
          name: 'GPT-6 Astra',
          label: 'GPT-6 Astra · 1.0x cost',
          ref: 'eaglelab-responses/turing/gpt-6-astra',
          isPrimary: false,
        },
      ],
    });
    await listModelCatalog({} as never);

    handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_MODEL, model_id: 'turing/gpt-6-astra' } },
      },
      {} as never,
      'feishu-a1',
    );

    await vi.runAllTimersAsync();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab-responses/turing/gpt-6-astra',
      }),
    );
  });

  it('prefers card model_ref over the Completions fallback', async () => {
    const result = handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: {
          value: {
            action: ACTION_SET_MODEL,
            model_id: 'turing/gpt-6-astra',
            model_ref: 'eaglelab-responses/turing/gpt-6-astra',
          },
        },
      },
      {} as never,
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Switched to turing/gpt-6-astra',
      },
    });
    await vi.runAllTimersAsync();
    expect(mockListAvailableModelsFromOrchestrator).not.toHaveBeenCalled();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/model eaglelab-responses/turing/gpt-6-astra',
      }),
    );
  });

  it('sets the current session and the long-term thinking default', async () => {
    vi.mocked(execFile).mockClear();
    const result = handleModelPickerAction(
      {
        operator: { open_id: 'ou_user_1' },
        open_chat_id: 'oc_chat_1',
        action: { value: { action: ACTION_SET_THINKING, thinking_level: 'medium' } },
      },
      {} as never,
      'feishu-a1',
    );

    expect(result).toMatchObject({
      toast: {
        type: 'success',
        content: 'Thinking set to Medium thinking',
        i18n: { zh_cn: '思考强度已设为 中度思考', en_us: 'Thinking set to Medium thinking' },
      },
    });
    await vi.runAllTimersAsync();
    expect(mockDispatchSyntheticTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/think medium' }),
    );
    expect(execFile).toHaveBeenCalledWith(
      'openclaw',
      ['config', 'set', 'agents.defaults.thinkingDefault', 'medium'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });
});
