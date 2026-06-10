import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  EAGLELAB_API_BASE_ENV,
  EAGLELAB_API_KEY_ENV,
  clearOrchestratorAuthCache,
  formatModelLabel,
  listAvailableModelsFromOrchestrator,
  parseEaglelabApiKeyFromShellExport,
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
});

describe('listAvailableModelsFromOrchestrator', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    clearOrchestratorAuthCache();
    process.env[EAGLELAB_API_KEY_ENV] = 'test-api-key';
    process.env[EAGLELAB_API_BASE_ENV] = 'https://live-turing.cn.llm.tcljd.com/api/v1';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[EAGLELAB_API_KEY_ENV];
    delete process.env[EAGLELAB_API_BASE_ENV];
    clearOrchestratorAuthCache();
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

  it('uses test-cowork when EAGLELAB_API_BASE contains test', async () => {
    process.env[EAGLELAB_API_BASE_ENV] = 'https://test-turing.cn.llm.tcljd.com/api/v1';
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'jwt' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) });
    await listAvailableModelsFromOrchestrator();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('test-cowork.tcljd.com/api/v1/auth/sso');
  });

  it('returns empty list when api key is missing', async () => {
    delete process.env[EAGLELAB_API_KEY_ENV];
    const result = await listAvailableModelsFromOrchestrator();
    expect(result.entries).toEqual([]);
    expect(result.error).toContain('EAGLELAB_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
