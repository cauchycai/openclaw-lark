/**
 * Optional OpenClaw peer surface used for mid-run steer injection.
 * Present on production OpenClaw builds (~2026.6.x+); absent from older
 * local peer stubs — keep this ambient so typecheck stays green.
 */
declare module 'openclaw/plugin-sdk/agent-harness-runtime' {
  export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined;
  export function queueAgentHarnessMessage(
    sessionId: string,
    text: string,
    options?: { steeringMode?: 'all'; debounceMs?: number },
  ): boolean;
}
