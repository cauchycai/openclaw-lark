/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Cached model catalog backed by the orchestrator HTTP API.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import {
  MODEL_CATALOG_CACHE_TTL_MS,
  type ModelCatalogEntry,
  listAvailableModelsFromOrchestrator,
} from './orchestrator-models';

export type { ModelCatalogEntry };

export interface ListModelsResult {
  entries: ModelCatalogEntry[];
  error?: string;
}

interface CatalogCache {
  entries: ModelCatalogEntry[];
  fetchedAt: number;
  error?: string;
}

let catalogCache: CatalogCache | undefined;

export function clearModelCatalogCache(): void {
  catalogCache = undefined;
}

function getFreshCache(): CatalogCache | undefined {
  if (!catalogCache) return undefined;
  if (Date.now() - catalogCache.fetchedAt > MODEL_CATALOG_CACHE_TTL_MS) {
    catalogCache = undefined;
    return undefined;
  }
  return catalogCache;
}

export function getCachedModelCatalog(): ListModelsResult | undefined {
  const cache = getFreshCache();
  if (!cache) return undefined;
  return { entries: cache.entries, error: cache.error };
}

export async function listModelCatalog(cfg?: ClawdbotConfig): Promise<ListModelsResult> {
  const cached = getFreshCache();
  if (cached) {
    return { entries: cached.entries, error: cached.error };
  }

  const result = await listAvailableModelsFromOrchestrator(cfg);
  catalogCache = {
    entries: result.entries,
    fetchedAt: Date.now(),
    error: result.error,
  };
  return result;
}

export function findModelEntry(
  entries: ModelCatalogEntry[],
  modelId: string,
): ModelCatalogEntry | undefined {
  return entries.find((entry) => entry.modelId === modelId);
}

export function findPrimaryModelEntry(entries: ModelCatalogEntry[]): ModelCatalogEntry | undefined {
  return entries.find((entry) => entry.isPrimary);
}
