import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  COWORK_API_URL_ENV,
  EAGLELAB_API_BASE_ENV,
  EAGLELAB_API_KEY_ENV,
  USER_JWT_TOKEN_ENV,
  clearOrchestratorAuthCache,
  formatModelLabel,
  listAvailableModelsFromOrchestrator,
  parseEaglelabApiKeyFromShellExport,
  resolveEaglelabApiBase,
  resolveOrchestratorUrl,
} from '../src/core/orchestrator-models';

describe('parseEaglelabApiKeyFromShellExport', () => {
  it('parses single-quoted export lines from sandbox profile', () => {
    const content = [
      '# comment',
      "export EAGLELAB_API_KEY='sk-test-key'",
      'export PATH=/usr/bin',
    ].join('\n');
    expect(parseEaglelabApiKeyFromShellExport(content)).toBe('sk-test-key');
  });

  it('parses double-quoted export lines', () => {
    expect(parseEaglelabApiKeyFromShellExport('export EAGLELAB_API_KEY="sk-another"')).toBe(
      'sk-another',
    );
  });

  it('returns undefined when export is absent', () => {
    expect(parseEaglelabApiKeyFromShellExport('export PATH=/usr/bin')).toBeUndefined();
  });
});

describe('formatModelLabel', () => {
  it('formats cost multiplier', () => {
    expect(formatModelLabel('kimi-k2.6', 1)).toBe('kimi-k2.6 · 1.0x cost');
  });
});

describe('resolveOrchestratorUrl', () => {
  it('maps live EAGLELAB_API_BASE to live-cowork', () => {
    expect(resolveOrchestratorUrl('https://live-turing.cn.llm.tcljd.com/api/v1')).toBe(
      'https://live-cowork.tcljd.com',
    );
  });

  it('maps test EAGLELAB_API_BASE to test-cowork', () => {
    expect(resolveOrchestratorUrl('https://test-turing.cn.llm.tcljd.com/api/v1')).toBe(
      'https://test-cowork.tcljd.com',
    );
  });

  it('defaults to live-cowork when EAGLELAB_API_BASE is unset', () => {
    expect(resolveOrchestratorUrl('')).toBe('https://live-cowork.tcljd.com');
  });

  it('prefers COWORK_API_URL when set', () => {
    process.env[COWORK_API_URL_ENV] = 'https://test-cowork.tcljd.com';
    try {
      expect(resolveOrchestratorUrl('')).toBe('https://test-cowork.tcljd.com');
    } finally {
      delete process.env[COWORK_API_URL_ENV];
    }
  });
});

describe('resolveEaglelabApiBase', () => {
  it('reads baseUrl from cfg when process env is unset', () => {
    delete process.env[EAGLELAB_API_BASE_ENV];
    expect(
      resolveEaglelabApiBase({
        models: {
          providers: {
            eaglelab: { baseUrl: 'https://test-turing.cn.llm.tcljd.com/api/v1' },
          },
        },
      } as never),
    ).toBe('https://test-turing.cn.llm.tcljd.com/api/v1');
  });
});

describe('listAvailableModelsFromOrchestrator', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    clearOrchestratorAuthCache();
    process.env[EAGLELAB_API_KEY_ENV] = 'test-api-key';
    process.env[EAGLELAB_API_BASE_ENV] = 'https://live-turing.cn.llm.tcljd.com/api/v1';
    delete process.env[USER_JWT_TOKEN_ENV];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[EAGLELAB_API_KEY_ENV];
    delete process.env[EAGLELAB_API_BASE_ENV];
    delete process.env[USER_JWT_TOKEN_ENV];
    clearOrchestratorAuthCache();
  });

  it('uses USER_JWT_TOKEN without calling SSO', async () => {
    process.env[USER_JWT_TOKEN_ENV] = 'sandbox-jwt-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            model_id: 'turing-claw/kimi',
            name: 'kimi-k2.6',
            enabled: true,
            cost_multiplier: 1,
          },
        ],
      }),
    });

    const result = await listAvailableModelsFromOrchestrator();
    expect(result.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://live-cowork.tcljd.com/api/v1/models');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer sandbox-jwt-token' },
    });
  });

  it('falls back to SSO when USER_JWT_TOKEN is rejected', async () => {
    process.env[USER_JWT_TOKEN_ENV] = 'expired-jwt';
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'fresh-jwt' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) });

    await listAvailableModelsFromOrchestrator();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/auth/sso');
  });

  it('maps enabled orchestrator models to catalog entries via live-cowork', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'jwt-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              model_id: 'turing-claw/kimi',
              name: 'kimi-k2.6',
              enabled: true,
              cost_multiplier: 1,
            },
            {
              model_id: 'turing-claw/disabled',
              name: 'disabled-model',
              enabled: false,
              cost_multiplier: 2,
            },
          ],
        }),
      });

    const result = await listAvailableModelsFromOrchestrator();
    expect(result.entries).toEqual([
      {
        modelId: 'turing-claw/kimi',
        name: 'kimi-k2.6',
        label: 'kimi-k2.6 · 1.0x cost',
        ref: 'eaglelab/turing-claw/kimi',
        isPrimary: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://live-cowork.tcljd.com/api/v1/auth/sso?token=test-api-key',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://live-cowork.tcljd.com/api/v1/models');
  });

  it('uses test-cowork when cfg EAGLELAB_API_BASE contains test', async () => {
    delete process.env[EAGLELAB_API_BASE_ENV];
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'jwt' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) });
    await listAvailableModelsFromOrchestrator({
      env: { EAGLELAB_API_BASE: 'https://test-turing.cn.llm.tcljd.com/api/v1' },
    } as never);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('test-cowork.tcljd.com/api/v1/auth/sso');
  });

  it('returns empty list when api key and USER_JWT_TOKEN are missing', async () => {
    delete process.env[EAGLELAB_API_KEY_ENV];
    delete process.env[USER_JWT_TOKEN_ENV];
    const result = await listAvailableModelsFromOrchestrator();
    expect(result.entries).toEqual([]);
    expect(result.error).toContain('USER_JWT_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
