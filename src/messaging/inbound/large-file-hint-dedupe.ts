/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * In-process dedupe for large-file guidance cards.
 */

import type { OversizeFileInfo } from './media-resolver';

const LARGE_FILE_HINT_DEDUP_TTL_MS = 10 * 60 * 1000;
const largeFileHintDedupe = new Map<string, number>();

export interface LargeFileHintReservation {
  fresh: OversizeFileInfo[];
  release: () => void;
}

export function reserveLargeFileHintFiles(params: {
  chatId: string;
  messageId: string;
  oversizeFiles: OversizeFileInfo[];
  now?: number;
}): LargeFileHintReservation {
  const now = params.now ?? Date.now();
  pruneExpired(now);

  const fresh: OversizeFileInfo[] = [];
  const keys: string[] = [];
  for (const file of params.oversizeFiles) {
    const key = dedupeKey({ chatId: params.chatId, messageId: params.messageId, file });
    if ((largeFileHintDedupe.get(key) ?? 0) > now) continue;
    largeFileHintDedupe.set(key, now + LARGE_FILE_HINT_DEDUP_TTL_MS);
    fresh.push(file);
    keys.push(key);
  }

  return {
    fresh,
    release: () => {
      for (const key of keys) largeFileHintDedupe.delete(key);
    },
  };
}

export function clearLargeFileHintDedupeForTest(): void {
  largeFileHintDedupe.clear();
}

function pruneExpired(now: number): void {
  for (const [key, expiresAt] of largeFileHintDedupe) {
    if (expiresAt <= now) largeFileHintDedupe.delete(key);
  }
}

function dedupeKey(params: { chatId: string; messageId: string; file: OversizeFileInfo }): string {
  return `${params.chatId}:${params.messageId}:${params.file.resourceType}:${params.file.fileKey}`;
}
