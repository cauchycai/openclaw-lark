import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateCardKitCard: vi.fn(),
  setCardStreamingMode: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({ SILENT_REPLY_TOKEN: '__silent__' }));
vi.mock('openclaw/plugin-sdk/agent-runtime', () => ({ resolveDefaultAgentId: () => 'default' }));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/core/lark-client', () => ({ LarkClient: {} }));
vi.mock('../src/core/shutdown-hooks', () => ({ registerShutdownHook: () => () => {} }));
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: vi.fn(),
  sendCardByCardId: vi.fn(),
  streamCardContent: vi.fn(),
  updateCardKitCard: (...args: unknown[]) => mocks.updateCardKitCard(...args),
  setCardStreamingMode: (...args: unknown[]) => mocks.setCardStreamingMode(...args),
}));
vi.mock('../src/card/flush-controller', () => ({
  FlushController: class {
    cancelPendingFlush() {}
    complete() {}
    setCardMessageReady() {}
    throttledUpdate() {
      return Promise.resolve();
    }
    waitForFlush() {
      return Promise.resolve();
    }
  },
}));
vi.mock('../src/card/image-resolver', () => ({
  ImageResolver: class {
    resolveImages(t: string) {
      return t;
    }
    resolveImagesAwait(t: string) {
      return Promise.resolve(t);
    }
  },
}));
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() {
      return false;
    }
    terminate() {
      return false;
    }
    get isTerminated() {
      return false;
    }
  },
}));

import { buildCardContent } from '../src/card/builder';
import { StreamingCardController } from '../src/card/streaming-card-controller';

function createController(): StreamingCardController {
  return new StreamingCardController({
    cfg: {},
    chatId: 'oc_chat',
    sessionKey: 'agent:test:session',
    agentId: 'test',
    toolUseDisplay: {
      showToolUse: true,
      showFullPaths: false,
      showToolResultDetails: true,
    },
    resolvedFooter: {
      status: false,
      elapsed: false,
      tokens: false,
      cache: false,
      context: false,
      model: false,
      balanceUsage: false,
    },
  } as never);
}

describe('StreamingCardController final CardKit cleanup', () => {
  it('uses a compact completed fallback card when the full final card update fails', async () => {
    mocks.updateCardKitCard.mockReset();
    mocks.updateCardKitCard.mockRejectedValueOnce(new Error('card content too large'));
    mocks.updateCardKitCard.mockRejectedValueOnce(new Error('card content too large'));
    mocks.updateCardKitCard.mockRejectedValueOnce(new Error('card content too large'));
    mocks.updateCardKitCard.mockResolvedValueOnce(undefined);

    const controller = createController() as unknown as {
      updateFinalCardKitCard(params: {
        cardId: string;
        card: ReturnType<typeof buildCardContent>;
        fallbackText: string;
        label: string;
      }): Promise<void>;
    };
    const fullCard = buildCardContent('complete', {
      text: 'full final answer',
      showToolUse: true,
    });

    await controller.updateFinalCardKitCard({
      cardId: 'card_1',
      card: fullCard,
      fallbackText: 'full final answer',
      label: 'test',
    });

    expect(mocks.updateCardKitCard).toHaveBeenCalledTimes(4);
    const fallbackCard = mocks.updateCardKitCard.mock.calls[3][0].card as {
      body: { elements: Array<{ element_id?: string; content?: string }> };
    };
    expect(JSON.stringify(fallbackCard)).not.toContain('loading_icon');
    expect(JSON.stringify(fallbackCard)).toContain('compact completed card');
  });

  it('retries closing streaming mode with increasing sequence numbers', async () => {
    mocks.setCardStreamingMode.mockReset();
    mocks.setCardStreamingMode.mockRejectedValueOnce(new Error('stale sequence'));
    mocks.setCardStreamingMode.mockResolvedValueOnce(undefined);

    const controller = createController() as unknown as {
      closeCardKitStreamingMode(cardId: string, label: string): Promise<void>;
    };

    await controller.closeCardKitStreamingMode('card_1', 'test');

    expect(mocks.setCardStreamingMode).toHaveBeenCalledTimes(2);
    expect(mocks.setCardStreamingMode.mock.calls[0][0].sequence).toBe(1);
    expect(mocks.setCardStreamingMode.mock.calls[1][0].sequence).toBe(2);
    expect(mocks.setCardStreamingMode.mock.calls[1][0].streamingMode).toBe(false);
  });
});
