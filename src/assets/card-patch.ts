/**
 * Personal Asset card-patch helpers (scheme B).
 *
 * Flow:
 *   1. `StreamingCardController.finalizeCompleteCard()` persists a card ref
 *      whose complete JSON has **no** asset panel (clean finalize).
 *   2. When the asset notifier receives `assets.ready`:
 *      - `completed` + assets → `insertAssetPanel` + CardKit/IM update
 *      - `completed_no_assets` / empty → silent (no Feishu write)
 *      - `failed` → insert a red failure notation
 *   3. Legacy cards that still have a pending placeholder are handled via
 *      `replaceAssetPanel` first, then fall back to insert.
 *
 * Using the cached JSON rather than `im.message.get` avoids the bug where
 * IM returns the original streaming skeleton instead of the finalized card.
 *
 * State file: `/sandbox/.openclaw/personal-assets-feishu-card-refs.json`
 * TTL: 24 h (matches the notifier's DELIVERED_TTL_MS).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { writeJsonAtomically } from './atomic-json';
import { updateCardFeishu } from '../messaging/outbound/send';
import { updateCardKitCard } from '../card/cardkit';
import { larkLogger } from '../core/lark-logger';
import {
  ASSET_PANEL_ELEMENT_ID,
  type AssetSummary,
  type FeishuCard,
  buildPersonalAssetsPanel,
  toCardKit2,
} from '../card/builder';

const CARD_REF_FILE = 'personal-assets-feishu-card-refs.json';
const CANONICAL_STATE_DIR = '/sandbox/.openclaw';
const CARD_REF_TTL_MS = 24 * 60 * 60 * 1000;
const log = larkLogger('assets/card-patch');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardRef {
  /** Orchestrator run id. Prevents a later reply in the same session overwriting this ref. */
  runId?: string;
  /** Feishu session key — links the card to the delivery target's sessionKey. */
  sessionKey: string;
  cardMessageId: string;
  /** Present when the card was sent via CardKit; absent for IM-fallback cards. */
  cardKitCardId?: string;
  /**
   * Last CardKit sequence used for this card (finalize / prior asset patch).
   * Asset patches must send a strictly greater sequence.
   */
  cardKitSequence?: number;
  /**
   * The complete card JSON as written at finalize time.
   * Stored here to avoid relying on `im.message.get` which returns the
   * original streaming skeleton rather than the finalized content.
   */
  completeCardJson: Record<string, unknown>;
  createdAt: number;
}

/** Result of attempting to patch the main reply card with asset outcomes. */
export type PatchMainCardResult =
  | { ok: true; action: 'inserted' | 'replaced' | 'silent' }
  /** Finalize has not persisted a card ref yet — caller should keep polling. */
  | { ok: false; reason: 'waiting_for_card' }
  | { ok: false; reason: 'no_session' | 'update_failed' };

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function resolveCardRefFile(stateDir?: string): string {
  const dir = (stateDir ?? '').trim() || CANONICAL_STATE_DIR;
  return path.join(dir, CARD_REF_FILE);
}

async function readCardRefs(refPath: string): Promise<CardRef[]> {
  const now = Date.now();
  try {
    const raw: unknown = JSON.parse(await fs.readFile(refPath, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is CardRef => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return (
        typeof row.sessionKey === 'string' &&
        typeof row.cardMessageId === 'string' &&
        row.completeCardJson !== null &&
        typeof row.completeCardJson === 'object' &&
        typeof row.createdAt === 'number' &&
        now - (row.createdAt as number) <= CARD_REF_TTL_MS
      );
    });
  } catch {
    return [];
  }
}

async function writeCardRefs(refPath: string, refs: CardRef[]): Promise<void> {
  await writeJsonAtomically(refPath, refs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store the card reference + complete card JSON for a session so the asset
 * notifier can patch it later without a round-trip to `im.message.get`.
 *
 * Called by `StreamingCardController` right after the finalized card is sent.
 */
export async function persistCardRef(
  ref: Omit<CardRef, 'createdAt'>,
  options?: { stateDir?: string },
): Promise<void> {
  if (!ref.sessionKey || !ref.cardMessageId) return;
  const refPath = resolveCardRefFile(options?.stateDir);
  const existing = await readCardRefs(refPath);
  const runId = ref.runId?.trim();
  const next: CardRef[] = [
    ...existing.filter((r) => (runId ? r.runId !== runId : r.sessionKey !== ref.sessionKey)),
    { ...ref, createdAt: Date.now() },
  ];
  await writeCardRefs(refPath, next);
}

/**
 * Remove the card ref for a session (cleanup after a successful patch).
 */
export async function removeCardRef(sessionKey: string, options?: { stateDir?: string }): Promise<void> {
  const refPath = resolveCardRefFile(options?.stateDir);
  const existing = await readCardRefs(refPath);
  const next = existing.filter((r) => r.sessionKey !== sessionKey);
  if (next.length !== existing.length) {
    await writeCardRefs(refPath, next);
  }
}

/**
 * Look up the card ref for a session.
 */
export async function getCardRef(
  sessionKey: string,
  runIdOrOptions?: string | { stateDir?: string },
  options?: { stateDir?: string },
): Promise<CardRef | null> {
  const runId = typeof runIdOrOptions === 'string' ? runIdOrOptions : undefined;
  const stateDir = typeof runIdOrOptions === 'string' ? options?.stateDir : runIdOrOptions?.stateDir;
  const refPath = resolveCardRefFile(stateDir);
  const refs = await readCardRefs(refPath);
  if (runId) {
    // Older/current streaming callbacks may not expose the orchestrator run id.
    // Keep the precise lookup when available, but fall back to the newest ref
    // for this session so asset panels are not silently dropped.
    return refs.find((r) => r.sessionKey === sessionKey && r.runId === runId)
      ?? refs.find((r) => r.sessionKey === sessionKey && !r.runId)
      ?? refs.find((r) => r.sessionKey === sessionKey)
      ?? null;
  }
  return refs.find((r) => r.sessionKey === sessionKey) ?? null;
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

/**
 * Push an updated card JSON to Feishu.
 *
 * CardKit-streamed replies must be updated via CardKit (`cardKitCardId` +
 * bumping sequence). IM `message.patch` alone often no-ops / fails for those
 * cards.
 */
async function pushPatchedCard(params: {
  ref: CardRef;
  card: Record<string, unknown>;
  cfg: ClawdbotConfig;
  accountId?: string;
  stateDir?: string;
}): Promise<boolean> {
  const { ref, card, cfg, accountId, stateDir } = params;
  let imPatchCard = card;
  try {
    if (ref.cardKitCardId) {
      const nextSeq = Math.max((ref.cardKitSequence ?? 0) + 1, Date.now() % 1_000_000_000);
      const kitCard = toCardKit2(card as unknown as FeishuCard);
      // The original streamed reply is a Schema V2 card. If CardKit's full
      // update fails, im.message.patch must still receive Schema V2; Feishu
      // rejects a V2 -> V1 schema change with 230099 / 200830.
      imPatchCard = kitCard;
      try {
        await updateCardKitCard({
          cfg,
          cardId: ref.cardKitCardId,
          card: kitCard,
          sequence: nextSeq,
          accountId,
        });
        await persistCardRef(
          {
            sessionKey: ref.sessionKey,
            runId: ref.runId,
            cardMessageId: ref.cardMessageId,
            cardKitCardId: ref.cardKitCardId,
            cardKitSequence: nextSeq,
            completeCardJson: card,
          },
          { stateDir },
        );
        return true;
      } catch (error) {
        // A finalized CardKit entity can reject a later full-card update.
        // IM patch updates the already-sent original message and preserves the
        // requested single-card experience; it never emits a fallback card.
        log.warn('CardKit asset panel update failed; retrying original message via IM patch', {
          cardId: ref.cardKitCardId,
          messageId: ref.cardMessageId,
          error: String(error),
        });
      }
    }

    await updateCardFeishu({ cfg, messageId: ref.cardMessageId, card: imPatchCard, accountId });
    await persistCardRef(
      {
        sessionKey: ref.sessionKey,
        runId: ref.runId,
        cardMessageId: ref.cardMessageId,
        completeCardJson: card,
      },
      { stateDir },
    );
    return true;
  } catch (error) {
    log.warn('asset panel update failed', {
      messageId: ref.cardMessageId,
      error: String(error),
    });
    return false;
  }
}

function applyAssetPanel(
  card: Record<string, unknown>,
  panel: Record<string, unknown>,
): { card: Record<string, unknown>; action: 'inserted' | 'replaced' } {
  // Legacy finalize cards may still carry a pending placeholder — replace it.
  const replaced = replaceAssetPanel(card, panel);
  if (replaced) return { card: replaced, action: 'replaced' };
  return { card: insertAssetPanel(card, panel), action: 'inserted' };
}

/**
 * Apply an `assets.ready` outcome onto the main reply card (scheme B).
 *
 * - No assets / no workspace changes → silent success (no Feishu write).
 * - Assets present → insert (or replace legacy pending) panel on the main card.
 * - Failed → insert a failure notation on the main card.
 */
export async function patchMainCardWithAssets(params: {
  runId: string;
  assets: AssetSummary[];
  status: 'completed' | 'completed_no_assets' | 'failed';
  failReason?: string;
  cfg: ClawdbotConfig;
  accountId?: string;
  sessionKey?: string;
  stateDir?: string;
}): Promise<PatchMainCardResult> {
  const { runId, assets, status, failReason, cfg, accountId, sessionKey, stateDir } = params;
  if (!sessionKey) return { ok: false, reason: 'no_session' };

  // Scheme B: no workspace changes / nothing kept → do not touch the card.
  if (status === 'completed_no_assets' || (status === 'completed' && assets.length === 0)) {
    return { ok: true, action: 'silent' };
  }

  const ref = await getCardRef(sessionKey, runId, { stateDir });
  if (!ref) return { ok: false, reason: 'waiting_for_card' };

  let panel: Record<string, unknown>;
  if (status === 'completed' && assets.length > 0) {
    panel = buildPersonalAssetsPanel(assets, 'completed') as Record<string, unknown>;
  } else if (status === 'failed') {
    panel = buildPersonalAssetsPanel([], 'failed', failReason) as Record<string, unknown>;
  } else {
    return { ok: true, action: 'silent' };
  }

  const { card: next, action } = applyAssetPanel(ref.completeCardJson, panel);
  const pushed = await pushPatchedCard({ ref, card: next, cfg, accountId, stateDir });
  return pushed ? { ok: true, action } : { ok: false, reason: 'update_failed' };
}

// ---------------------------------------------------------------------------
// Element replacement helpers
// ---------------------------------------------------------------------------

/**
 * Remove the element whose `element_id === ASSET_PANEL_ELEMENT_ID` from
 * the card entirely. Kept for legacy pending placeholders.
 *
 * Returns `null` if the element was not found.
 */
export function removeAssetPanel(
  card: Record<string, unknown>,
): Record<string, unknown> | null {
  const body = card.body as Record<string, unknown> | undefined;
  const rawElements: unknown = body?.elements ?? card.elements;
  if (!Array.isArray(rawElements)) return null;

  const elements = rawElements as Record<string, unknown>[];
  const idx = elements.findIndex((el) => el && el.element_id === ASSET_PANEL_ELEMENT_ID);
  if (idx === -1) return null;

  const next = [...elements.slice(0, idx), ...elements.slice(idx + 1)];

  if (body) {
    return { ...card, body: { ...body, elements: next } };
  }
  return { ...card, elements: next };
}

/**
 * Replace the element whose `element_id === ASSET_PANEL_ELEMENT_ID` with
 * the provided replacement panel.
 *
 * Supports both Feishu v1 (top-level `elements`) and CardKit 2.0
 * (`body.elements`).  Returns `null` if the placeholder element was not
 * found (so the caller can fall back to insert).
 */
export function replaceAssetPanel(
  card: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> | null {
  const body = card.body as Record<string, unknown> | undefined;
  const rawElements: unknown = body?.elements ?? card.elements;
  if (!Array.isArray(rawElements)) return null;

  const elements = rawElements as Record<string, unknown>[];
  const idx = elements.findIndex((el) => el && el.element_id === ASSET_PANEL_ELEMENT_ID);
  if (idx === -1) return null;

  const next = [...elements];
  next[idx] = replacement;

  if (body) {
    return { ...card, body: { ...body, elements: next } };
  }
  return { ...card, elements: next };
}

/**
 * Insert the asset panel into the card elements array just before the first
 * trailing notation-markdown footer element.
 *
 * Primary path for scheme B (finalize has no pending placeholder).
 *
 * Supports both Feishu v1 (top-level `elements`) and CardKit 2.0
 * (`body.elements`).
 */
export function insertAssetPanel(
  card: Record<string, unknown>,
  panel: Record<string, unknown>,
): Record<string, unknown> {
  const body = card.body as Record<string, unknown> | undefined;
  const rawElements: unknown = body?.elements ?? card.elements;
  if (!Array.isArray(rawElements)) return card;

  const elements = [...rawElements] as Record<string, unknown>[];

  // Insertion point: just before the contiguous run of trailing notation elements.
  let insertAt = elements.length;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el && typeof el === 'object' && el.text_size === 'notation') {
      insertAt = i;
    } else {
      break;
    }
  }

  elements.splice(insertAt, 0, panel);

  if (body) {
    return { ...card, body: { ...body, elements } };
  }
  return { ...card, elements };
}
