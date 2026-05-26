import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetChatQueueState,
  enqueueFeishuChatTask,
  hasActiveTask,
} from '../src/channel/chat-queue';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('enqueueFeishuChatTask', () => {
  afterEach(() => {
    _resetChatQueueState();
  });

  it('serializes same-chat tasks when no bypass flag is set', async () => {
    const first = createDeferred();
    const order: string[] = [];

    enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        order.push('start:first');
        await first.promise;
        order.push('end:first');
      },
    });

    enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        order.push('start:second');
      },
    });

    await flushMicrotasks();
    expect(order).toEqual(['start:first']);
    expect(hasActiveTask('default:chat-1')).toBe(true);

    first.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['start:first', 'end:first', 'start:second']);
  });

  it('bypasses the serial chain when a task is already active', async () => {
    const first = createDeferred();
    const order: string[] = [];

    const firstEnqueue = enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        order.push('start:first');
        await first.promise;
        order.push('end:first');
      },
    });
    expect(firstEnqueue.status).toBe('immediate');

    const secondEnqueue = enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      bypassSerialWhenActive: true,
      task: async () => {
        order.push('start:second');
      },
    });

    expect(secondEnqueue.status).toBe('bypass-active');
    await flushMicrotasks();
    expect(order).toEqual(['start:first', 'start:second']);

    first.resolve();
    await first.promise;
    await secondEnqueue.promise;
    expect(order).toEqual(['start:first', 'start:second', 'end:first']);
  });

  it('keeps unrelated chat keys independent', async () => {
    const blocked = createDeferred();
    const order: string[] = [];

    enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        order.push('start:chat-1');
        await blocked.promise;
        order.push('end:chat-1');
      },
    });

    const other = enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-2',
      bypassSerialWhenActive: true,
      task: async () => {
        order.push('start:chat-2');
      },
    });

    await flushMicrotasks();
    expect(other.status).toBe('immediate');
    expect(order).toEqual(['start:chat-1', 'start:chat-2']);
  });

  it('uses normal enqueue for the first message even with bypass enabled', async () => {
    const result = enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      bypassSerialWhenActive: true,
      task: async () => {},
    });

    expect(result.status).toBe('immediate');
    expect(hasActiveTask('default:chat-1')).toBe(true);
    await result.promise;
    expect(hasActiveTask('default:chat-1')).toBe(false);
  });
});
