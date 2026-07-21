/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Thin loader for OpenClaw's active-run steer helpers.
 *
 * The `/steer` chat-command path goes through full get-reply and, on inject
 * failure, continues as a normal prompt that waits on the session lane —
 * mid-run follow-ups then hang until the first turn ends. Calling the
 * harness queue API directly avoids that wait.
 */

export type SteerRuntimeApi = {
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  queueAgentHarnessMessage: (
    sessionId: string,
    text: string,
    options?: { steeringMode?: 'all'; debounceMs?: number },
  ) => boolean;
};

export async function loadSteerRuntime(): Promise<SteerRuntimeApi | null> {
  try {
    // Optional peer: present on OpenClaw >= ~2026.6.x used in production sandboxes.
    const mod = (await import('openclaw/plugin-sdk/agent-harness-runtime')) as SteerRuntimeApi;
    if (
      typeof mod.resolveActiveEmbeddedRunSessionId !== 'function' ||
      typeof mod.queueAgentHarnessMessage !== 'function'
    ) {
      return null;
    }
    return mod;
  } catch {
    return null;
  }
}
