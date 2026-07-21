/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Mid-run follow-up steering for Feishu.
 *
 * When bypassSerialWhenActive lets a second inbound message reach dispatch
 * while an agent run is still active, a full createFeishuReplyDispatcher +
 * dispatchReplyFromConfig path creates a new replyOperation that makes
 * OpenClaw core treat isActive=false (isOwnPreDispatchOperationSession).
 * The follow-up then waits on the session lane and starts a second agent
 * turn with its own streaming card.
 *
 * Prefer direct active-run injection via the harness queue API. Do NOT route
 * through the `/steer` chat-command dispatcher: when inject fails, that path
 * continues as a normal prompt and blocks on the session lane until the
 * first turn ends (acked=false / delivered=false after several seconds).
 */

import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import type { DispatchContext } from './dispatch-context';
import { loadSteerRuntime } from './steer-runtime';

const log = larkLogger('inbound/dispatch-mid-run-steer');

/** Brief retries cover TTFT / tool gaps where isStreaming() is temporarily false. */
const INJECT_RETRY_DELAYS_MS = [0, 120, 240, 360, 480] as const;

export type MidRunSteerResult = 'steered' | 'fallback';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to inject a mid-run follow-up into the active embedded/reply run.
 * Returns `steered` when the active-run queue accepted the message;
 * `fallback` means the caller should use the normal streaming dispatch path.
 */
export async function trySteerMidRunFollowup(params: {
  dc: DispatchContext;
  steerText: string;
  replyToMessageId?: string;
}): Promise<MidRunSteerResult> {
  const { dc } = params;
  const steerText = params.steerText.trim();
  if (!steerText) {
    return 'fallback';
  }

  // Already an explicit steer/tell — leave it to the normal command path.
  if (/^\/(?:steer|tell)(?:\s|$)/i.test(steerText)) {
    return 'fallback';
  }

  const sessionKey = dc.threadSessionKey ?? dc.route.sessionKey;
  dc.log(
    `feishu[${dc.account.accountId}]: mid-run follow-up → active-run inject (session=${sessionKey})`,
  );
  log.info(`mid-run follow-up active-run inject (session=${sessionKey})`);

  const runtime = await loadSteerRuntime();
  if (!runtime) {
    dc.log(
      `feishu[${dc.account.accountId}]: mid-run steer runtime unavailable; falling back (elapsed=${ticketElapsed()}ms)`,
    );
    log.info(`mid-run steer runtime unavailable; falling back (elapsed=${ticketElapsed()}ms)`);
    return 'fallback';
  }

  let sawActiveSession = false;
  for (const delayMs of INJECT_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const sessionId = runtime.resolveActiveEmbeddedRunSessionId(sessionKey);
    if (!sessionId) {
      continue;
    }
    sawActiveSession = true;

    const queued = runtime.queueAgentHarnessMessage(sessionId, steerText, {
      steeringMode: 'all',
      debounceMs: 0,
    });
    if (queued) {
      dc.log(
        `feishu[${dc.account.accountId}]: mid-run steer injected (sessionId=${sessionId}, elapsed=${ticketElapsed()}ms)`,
      );
      log.info(`mid-run steer injected (sessionId=${sessionId}, elapsed=${ticketElapsed()}ms)`);
      return 'steered';
    }
  }

  dc.log(
    `feishu[${dc.account.accountId}]: mid-run steer inject missed (sawActive=${sawActiveSession}, elapsed=${ticketElapsed()}ms); falling back`,
  );
  log.info(
    `mid-run steer inject missed (sawActive=${sawActiveSession}, elapsed=${ticketElapsed()}ms); falling back`,
  );
  return 'fallback';
}
