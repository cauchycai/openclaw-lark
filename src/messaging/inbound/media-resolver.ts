/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Media resolution and payload building for inbound Feishu messages.
 *
 * Downloads media files based on ResourceDescriptors extracted during
 * the content converter phase, and builds the payload object spread
 * into the agent envelope.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuMediaInfo, ResourceDescriptor } from '../types';
import { LarkClient } from '../../core/lark-client';
import { downloadMessageResourceFeishu, isOversizeResourceError, repairFeishuFileName } from '../outbound/media';

// ---------------------------------------------------------------------------
// Resource-descriptor-based download
// ---------------------------------------------------------------------------

/**
 * A resource the bot could not download because it exceeds Feishu's 100MB
 * IM-attachment cap (errCode 234037).
 */
export interface OversizeFileInfo {
  fileKey: string;
  fileName?: string;
  resourceType: ResourceDescriptor['type'];
}

/** Result of {@link downloadResources}: downloaded media + oversize files. */
export interface DownloadResourcesResult {
  media: FeishuMediaInfo[];
  oversize: OversizeFileInfo[];
}

/**
 * Download media files based on pre-extracted ResourceDescriptors from
 * the converter phase.
 */
export async function downloadResources(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  resources: ResourceDescriptor[];
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<DownloadResourcesResult> {
  const { cfg, messageId, resources, maxBytes, log, accountId } = params;

  if (resources.length === 0) return { media: [], oversize: [] };

  const out: FeishuMediaInfo[] = [];
  const oversize: OversizeFileInfo[] = [];
  const core = LarkClient.runtime;

  for (const res of resources) {
    try {
      const result = await downloadMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: res.fileKey,
        type: toMessageResourceType(res.type),
        accountId,
      });

      let contentType = result.contentType;
      if (!contentType) {
        contentType = await core.media.detectMime({ buffer: result.buffer });
      }

      // Prefer the message JSON name, but repair latin1-mojibake on either
      // source. OpenClaw keeps \p{L} as-is, so garbled latin1 letters would
      // otherwise be written to disk unchanged.
      const fileName = repairFeishuFileName(res.fileName) || repairFeishuFileName(result.fileName);
      const saved = await core.channel.media.saveMediaBuffer(result.buffer, contentType, 'inbound', maxBytes, fileName);

      const placeholder = inferPlaceholderFromType(res.type);
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder,
        fileKey: res.fileKey,
        resourceType: res.type,
      });

      log?.(`feishu: downloaded ${res.type} resource ${res.fileKey}, saved to ${saved.path}`);
    } catch (err) {
      if (isOversizeResourceError(err)) {
        oversize.push({ fileKey: res.fileKey, fileName: res.fileName, resourceType: res.type });
        log?.(`feishu: ${res.type} resource ${res.fileKey} exceeds 100MB IM cap; guiding user to re-share via Drive`);
      } else {
        log?.(`feishu: failed to download ${res.type} resource ${res.fileKey}: ${String(err)}`);
      }
    }
  }

  return { media: out, oversize };
}

/**
 * Probe message resources only for Feishu's 100MB IM-resource cap.
 *
 * This intentionally does not save successfully downloaded resources or return
 * local media paths. It is used for quoted/history messages where the normal
 * agent-facing `<file key="..."/>` behavior should stay unchanged unless the
 * resource is too large and would otherwise fail later with errCode 234037.
 */
export async function detectOversizeResources(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  resources: ResourceDescriptor[];
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<OversizeFileInfo[]> {
  const { cfg, messageId, resources, log, accountId } = params;

  if (resources.length === 0) return [];

  const oversize: OversizeFileInfo[] = [];
  for (const res of resources) {
    try {
      await downloadMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: res.fileKey,
        type: toMessageResourceType(res.type),
        accountId,
      });
    } catch (err) {
      if (isOversizeResourceError(err)) {
        oversize.push({ fileKey: res.fileKey, fileName: res.fileName, resourceType: res.type });
        log?.(`feishu: quoted ${res.type} resource ${res.fileKey} exceeds 100MB IM cap; guiding user to re-share via Drive`);
      } else {
        log?.(`feishu: failed to probe quoted ${res.type} resource ${res.fileKey}: ${String(err)}`);
      }
    }
  }

  return oversize;
}

function toMessageResourceType(type: ResourceDescriptor['type']): 'image' | 'file' {
  return type === 'image' ? 'image' : 'file';
}

function inferPlaceholderFromType(type: ResourceDescriptor['type']): string {
  switch (type) {
    case 'image':
      return '<media:image>';
    case 'file':
      return '<media:document>';
    case 'audio':
      return '<media:audio>';
    case 'video':
      return '<media:video>';
    case 'sticker':
      return '<media:sticker>';
  }
}

// ---------------------------------------------------------------------------
// Media payload builder
// ---------------------------------------------------------------------------

export function buildFeishuMediaPayload(mediaList: FeishuMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean) as string[];

  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
