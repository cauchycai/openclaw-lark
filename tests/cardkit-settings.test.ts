import { describe, expect, it, vi } from 'vitest';

const { settings } = vi.hoisted(() => ({ settings: vi.fn().mockResolvedValue({ code: 0 }) }));
vi.mock('../src/core/lark-client', () => ({
  LarkClient: { fromCfg: () => ({ sdk: { cardkit: { v1: { card: { settings } } } } }) },
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
import { setCardStreamingMode } from '../src/card/cardkit';

describe('CardKit settings API contract', () => {
  it.each([true, false])('nests streaming_mode=%s under config', async (streamingMode) => {
    await setCardStreamingMode({ cfg: {} as never, cardId: 'card-1', sequence: 7, streamingMode });
    expect(settings).toHaveBeenLastCalledWith({
      path: { card_id: 'card-1' },
      data: { settings: JSON.stringify({ config: { streaming_mode: streamingMode } }), sequence: 7 },
    });
  });
});
