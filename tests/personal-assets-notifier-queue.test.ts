import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type DeliveryTarget,
  fetchControlPlane,
  markDeliveredRun,
  readDeliveredRunIds,
  readPending,
  resolveDeliveredStateFile,
  resolveFeishuAccountId,
  resolveNotifierStateFile,
  upsertDeliveryTarget,
  writePending,
} from '../src/assets/notifier';
import { getCardRef, patchMainCardWithAssets, persistCardRef } from '../src/assets/card-patch';
import { clearOrchestratorAuthCache } from '../src/core/orchestrator-models';

describe('personal asset notifier queue', () => {
  let tempDir = '';

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearOrchestratorAuthCache();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('refreshes an expired sandbox JWT through SSO and retries the request', async () => {
    vi.stubEnv('USER_JWT_TOKEN', 'expired-user-jwt');
    vi.stubEnv('EAGLELAB_API_KEY', 'model-api-key');
    vi.stubEnv('COWORK_API_URL', 'https://cowork.example.test');
    clearOrchestratorAuthCache();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'fresh-user-jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchControlPlane(
      { config: {} } as never,
      'personal-assets/events/run-a',
    );

    expect(response?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/auth/sso');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh-user-jwt',
    });
  });

  test('resolveFeishuAccountId prefers ctx.accountId then sessionKey', () => {
    expect(resolveFeishuAccountId({ accountId: 'feishu-abc' })).toBe('feishu-abc');
    expect(
      resolveFeishuAccountId({
        sessionKey: 'agent:main:feishu:feishu-0f2f8149:direct:ou_test',
      }),
    ).toBe('feishu-0f2f8149');
    expect(resolveFeishuAccountId({ sessionKey: 'agent:main:web:foo' })).toBe('');
  });

  test('resolveNotifierStateFile prefers explicit stateDir', () => {
    expect(resolveNotifierStateFile('/tmp/openclaw-state')).toBe(
      '/tmp/openclaw-state/personal-assets-feishu-notifier.json',
    );
    expect(resolveNotifierStateFile()).toBe(
      '/sandbox/.openclaw/personal-assets-feishu-notifier.json',
    );
  });

  test('upsertDeliveryTarget merges by runId on disk', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const stateFile = path.join(tempDir, 'personal-assets-feishu-notifier.json');
    const first: DeliveryTarget = { runId: 'run-a', to: 'ou_1', createdAt: 1 };
    const second: DeliveryTarget = { runId: 'run-b', to: 'ou_2', createdAt: 2 };
    const updated: DeliveryTarget = { runId: 'run-a', to: 'ou_3', createdAt: 3 };

    await upsertDeliveryTarget(stateFile, first);
    await upsertDeliveryTarget(stateFile, second);
    await upsertDeliveryTarget(stateFile, updated);

    const rows = await readPending(stateFile);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.runId === 'run-a')).toMatchObject({ to: 'ou_3' });
    expect(rows.find((row) => row.runId === 'run-b')).toMatchObject({ to: 'ou_2' });
  });

  test('writePending replaces the full queue atomically', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const stateFile = path.join(tempDir, 'personal-assets-feishu-notifier.json');
    await writePending(stateFile, [
      { runId: 'run-old', to: 'ou_old', createdAt: 1 },
    ]);
    await writePending(stateFile, [
      { runId: 'run-new', to: 'ou_new', createdAt: 2 },
    ]);
    const rows = await readPending(stateFile);
    expect(rows).toEqual([{ runId: 'run-new', to: 'ou_new', createdAt: 2 }]);
  });

  test('upsertDeliveryTarget skips runs already marked delivered', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const stateFile = path.join(tempDir, 'personal-assets-feishu-notifier.json');
    const deliveredFile = path.join(tempDir, 'personal-assets-feishu-delivered.json');
    await markDeliveredRun(deliveredFile, 'run-done');
    const queued = await upsertDeliveryTarget(
      stateFile,
      { runId: 'run-done', to: 'ou_1', createdAt: 1 },
      { deliveredPath: deliveredFile },
    );
    expect(queued).toBe(false);
    expect(await readPending(stateFile)).toEqual([]);
    const delivered = await readDeliveredRunIds(deliveredFile);
    expect(delivered.has('run-done')).toBe(true);
  });

  test('resolveDeliveredStateFile uses the same root as pending queue', () => {
    expect(resolveDeliveredStateFile('/tmp/openclaw-state')).toBe(
      '/tmp/openclaw-state/personal-assets-feishu-delivered.json',
    );
  });

  test('patchMainCardWithAssets is silent for completed_no_assets without a card ref', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const result = await patchMainCardWithAssets({
      runId: 'run-silent',
      assets: [],
      status: 'completed_no_assets',
      cfg: {} as never,
      sessionKey: 'agent:main:feishu:feishu-x:direct:ou_x',
      stateDir: tempDir,
    });
    expect(result).toEqual({ ok: true, action: 'silent' });
  });

  test('patchMainCardWithAssets reports waiting_for_card when assets need insert but ref is missing', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const result = await patchMainCardWithAssets({
      runId: 'run-wait',
      assets: [{ id: 'a', title: 'x.md', source_path: 'x.md' }],
      status: 'completed',
      cfg: {} as never,
      sessionKey: 'agent:main:feishu:feishu-x:direct:ou_x',
      stateDir: tempDir,
    });
    expect(result).toEqual({ ok: false, reason: 'waiting_for_card' });
  });

  test('persistCardRef stores cardKitSequence for later CardKit patches', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    await persistCardRef(
      {
        sessionKey: 'agent:main:feishu:feishu-x:direct:ou_x',
        cardMessageId: 'om_test',
        cardKitCardId: 'kit_1',
        cardKitSequence: 22,
        completeCardJson: {
          elements: [
            { tag: 'markdown', content: 'answer' },
            { tag: 'markdown', content: '已完成', text_size: 'notation' },
          ],
        },
      },
      { stateDir: tempDir },
    );
    const ref = await getCardRef('agent:main:feishu:feishu-x:direct:ou_x', { stateDir: tempDir });
    expect(ref?.cardKitSequence).toBe(22);
    expect(ref?.cardKitCardId).toBe('kit_1');
  });

  test('keeps separate card refs for consecutive runs in one Feishu session', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const sessionKey = 'agent:main:feishu:feishu-x:direct:ou_x';
    await persistCardRef(
      {
        runId: 'run-one',
        sessionKey,
        cardMessageId: 'om_one',
        completeCardJson: { elements: [{ tag: 'markdown', content: 'first' }] },
      },
      { stateDir: tempDir },
    );
    await persistCardRef(
      {
        runId: 'run-two',
        sessionKey,
        cardMessageId: 'om_two',
        completeCardJson: { elements: [{ tag: 'markdown', content: 'second' }] },
      },
      { stateDir: tempDir },
    );

    expect((await getCardRef(sessionKey, 'run-one', { stateDir: tempDir }))?.cardMessageId).toBe('om_one');
    expect((await getCardRef(sessionKey, 'run-two', { stateDir: tempDir }))?.cardMessageId).toBe('om_two');
  });

  test('falls back to an unbound card ref when streaming events lack a run id', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pa-notifier-'));
    const sessionKey = 'agent:main:feishu:feishu-x:direct:ou_x';
    await persistCardRef(
      {
        sessionKey,
        cardMessageId: 'om_unbound',
        completeCardJson: { elements: [{ tag: 'markdown', content: 'answer' }] },
      },
      { stateDir: tempDir },
    );

    expect((await getCardRef(sessionKey, 'asset-run-id', { stateDir: tempDir }))?.cardMessageId)
      .toBe('om_unbound');
  });
});
