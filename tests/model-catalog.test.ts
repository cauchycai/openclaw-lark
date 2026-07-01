import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockListAvailableModelsFromOrchestrator = vi.fn();
vi.mock('../src/core/orchestrator-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/orchestrator-models')>();
  return {
    ...actual,
    listAvailableModelsFromOrchestrator: (...args: unknown[]) =>
      mockListAvailableModelsFromOrchestrator(...args),
  };
});

import { clearModelCatalogCache, listModelCatalog } from '../src/core/model-catalog';

const SAMPLE_ENTRIES = [
  {
    modelId: 'turing-claw/glm',
    name: 'glm-5.1',
    label: 'glm-5.1 · 1.0x cost',
    ref: 'eaglelab/turing-claw/glm',
    isPrimary: false,
  },
];

describe('listModelCatalog', () => {
  beforeEach(() => {
    clearModelCatalogCache();
    mockListAvailableModelsFromOrchestrator.mockReset();
  });

  afterEach(() => {
    clearModelCatalogCache();
  });

  it('deduplicates concurrent fetches while cache is cold', async () => {
    let resolveFetch: ((value: { entries: typeof SAMPLE_ENTRIES }) => void) | undefined;
    mockListAvailableModelsFromOrchestrator.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = listModelCatalog();
    const p2 = listModelCatalog();
    expect(mockListAvailableModelsFromOrchestrator).toHaveBeenCalledTimes(1);

    resolveFetch?.({ entries: SAMPLE_ENTRIES });
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { entries: SAMPLE_ENTRIES },
      { entries: SAMPLE_ENTRIES },
    ]);
    expect(mockListAvailableModelsFromOrchestrator).toHaveBeenCalledTimes(1);
  });

  it('returns cached result without refetching', async () => {
    mockListAvailableModelsFromOrchestrator.mockResolvedValue({ entries: SAMPLE_ENTRIES });

    await listModelCatalog();
    await listModelCatalog();

    expect(mockListAvailableModelsFromOrchestrator).toHaveBeenCalledTimes(1);
  });
});
