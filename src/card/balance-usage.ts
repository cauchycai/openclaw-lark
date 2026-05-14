import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { LarkLogger } from '../core/lark-logger';
import { getResolvedConfig } from '../core/lark-client';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ENDPOINT = 'https://live-turing.cn.llm.tcljd.com/api/v1/users/me/budget/usage/summary';
const DEFAULT_API_KEY_ENV = 'EAGLELAB_API_KEY';
const DEFAULT_USAGE_PATH = 'data.current_month_usage_in_usd';
const DEFAULT_CLIENT = 'tcl-aigc-portal';
const DEFAULT_ENVIRONMENT = 'live';
const RMB_PER_USD = 6.8;

export interface BalanceUsageTracker {
  formatUsageRmb: () => Promise<string | undefined>;
}

type ApiKeyResolution =
  | { source: 'provider' | 'config-env' | 'process-env'; value: string }
  | { source: 'missing' };

function normalizeSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\$\{[^}]+\}$/u.test(trimmed)) return undefined;
  return trimmed;
}

function resolveApiKey(cfg?: ClawdbotConfig): ApiKeyResolution {
  const fromProcess = normalizeSecret(process.env[DEFAULT_API_KEY_ENV]);
  if (!cfg) {
    return fromProcess ? { source: 'process-env', value: fromProcess } : { source: 'missing' };
  }
  const resolved = getResolvedConfig(cfg) as ClawdbotConfig & {
    models?: { providers?: Record<string, { apiKey?: string }> };
    env?: Record<string, string>;
  };
  const fromProvider = normalizeSecret(resolved.models?.providers?.eaglelab?.apiKey);
  if (fromProvider) return { source: 'provider', value: fromProvider };
  const fromConfigEnv = normalizeSecret(resolved.env?.[DEFAULT_API_KEY_ENV]);
  if (fromConfigEnv) return { source: 'config-env', value: fromConfigEnv };
  if (fromProcess) return { source: 'process-env', value: fromProcess };
  return { source: 'missing' };
}

function readPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, root);
}

function parseUsage(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function formatRmbUsage(usdValue: number): string {
  const rmbValue = usdValue * RMB_PER_USD;
  return rmbValue < 0.01 ? '小于0.01元' : `${rmbValue.toFixed(2)}元`;
}

async function fetchUsage(logger: LarkLogger, cfg?: ClawdbotConfig): Promise<number | undefined> {
  const apiKeyResolution = resolveApiKey(cfg);
  if (apiKeyResolution.source === 'missing') {
    logger.warn('balance usage footer skipped: missing EAGLELAB_API_KEY in resolved config and process env');
    return undefined;
  }
  const apiKey = apiKeyResolution.value;
  logger.info('balance usage footer: starting usage fetch', {
    endpoint: DEFAULT_ENDPOINT,
    usagePath: DEFAULT_USAGE_PATH,
    apiKeySource: apiKeyResolution.source,
  });

  try {
    const response = await fetch(DEFAULT_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        client: DEFAULT_CLIENT,
        environment: DEFAULT_ENVIRONMENT,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(`balance usage footer endpoint returned HTTP ${response.status}`);
      return undefined;
    }

    const body = (await response.json()) as unknown;
    const rawUsage = readPath(body, DEFAULT_USAGE_PATH);
    const parsedUsage = parseUsage(rawUsage);
    logger.info('balance usage footer: usage fetched', {
      apiKeySource: apiKeyResolution.source,
      rawUsageType: typeof rawUsage,
      parsedUsage,
    });
    return parsedUsage;
  } catch (err) {
    logger.warn('balance usage footer fetch failed', { error: String(err) });
    return undefined;
  }
}

export function createBalanceUsageTracker(logger: LarkLogger, cfg?: ClawdbotConfig): BalanceUsageTracker {
  const beforePromise = fetchUsage(logger, cfg);
  let formattedPromise: Promise<string | undefined> | undefined;

  return {
    formatUsageRmb() {
      formattedPromise ??= (async () => {
        const before = await beforePromise;
        if (before == null) {
          logger.warn('balance usage footer: initial usage unavailable, skipping usage calculation');
          return undefined;
        }

        const after = await fetchUsage(logger, cfg);
        if (after == null) {
          logger.warn('balance usage footer: final usage unavailable, skipping usage calculation');
          return undefined;
        }

        const used = after - before;
        if (!Number.isFinite(used)) {
          logger.warn('balance usage footer: computed usage is not finite', { before, after, used });
          return undefined;
        }

        const clampedUsed = Math.max(used, 0);
        const formatted = formatRmbUsage(clampedUsed);
        logger.info('balance usage footer: usage calculated', {
          before,
          after,
          used,
          clampedUsed,
          formatted,
        });
        return formatted;
      })();
      return formattedPromise;
    },
  };
}
