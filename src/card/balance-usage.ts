import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { LarkLogger } from '../core/lark-logger';
import { getResolvedConfig } from '../core/lark-client';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ENDPOINT = 'https://live-turing.cn.llm.tcljd.com/api/v1/users/me/budget/usage/summary';
const DEFAULT_API_KEY_ENV = 'EAGLELAB_API_KEY';
const DEFAULT_USAGE_PATH = 'data.current_month_usage_in_usd';
const DEFAULT_QUOTA_PATH = 'data.quota_per_month_in_usd';
const DEFAULT_REMAINING_QUOTA_PATH = 'data.current_month_remaining_quota_in_usd';
const DEFAULT_CLIENT = 'tcl-aigc-portal';
const DEFAULT_ENVIRONMENT = 'live';
const RMB_PER_USD = 6.8;

export interface BalanceUsageTracker {
  formatUsage: () => Promise<BalanceUsageMetrics | undefined>;
  formatUsageRmb: () => Promise<string | undefined>;
}

export interface BalanceUsageMetrics {
  balanceUsageRmb?: string;
  currentMonthUsagePercent?: string;
}

interface BalanceUsageSnapshot {
  currentMonthUsageUsd: number;
  quotaPerMonthUsd?: number;
  currentMonthRemainingQuotaUsd?: number;
}

type ApiKeyResolution = { source: 'provider' | 'config-env' | 'process-env'; value: string } | { source: 'missing' };

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

export function formatQuotaUsagePercent(
  usageUsd: number,
  quotaPerMonthUsd?: number,
  remainingQuotaUsd?: number,
): string | undefined {
  if (!Number.isFinite(usageUsd) || usageUsd < 0) {
    return undefined;
  }
  const totalQuotaUsd =
    quotaPerMonthUsd != null && Number.isFinite(quotaPerMonthUsd)
      ? quotaPerMonthUsd
      : usageUsd + (remainingQuotaUsd ?? NaN);
  if (totalQuotaUsd <= 0) {
    return undefined;
  }
  const percent = (usageUsd / totalQuotaUsd) * 100;
  if (!Number.isFinite(percent)) {
    return undefined;
  }
  if (percent > 0 && percent < 1) {
    return '<1%';
  }
  return `${Math.round(percent)}%`;
}

async function fetchUsage(logger: LarkLogger, cfg?: ClawdbotConfig): Promise<BalanceUsageSnapshot | undefined> {
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
    const rawQuota = readPath(body, DEFAULT_QUOTA_PATH);
    const parsedQuota = parseUsage(rawQuota);
    const rawRemainingQuota = readPath(body, DEFAULT_REMAINING_QUOTA_PATH);
    const parsedRemainingQuota = parseUsage(rawRemainingQuota);
    logger.info('balance usage footer: usage fetched', {
      apiKeySource: apiKeyResolution.source,
      rawUsageType: typeof rawUsage,
      parsedUsage,
      rawQuotaType: typeof rawQuota,
      parsedQuota,
      rawRemainingQuotaType: typeof rawRemainingQuota,
      parsedRemainingQuota,
    });
    if (parsedUsage == null) {
      return undefined;
    }
    return {
      currentMonthUsageUsd: parsedUsage,
      quotaPerMonthUsd: parsedQuota,
      currentMonthRemainingQuotaUsd: parsedRemainingQuota,
    };
  } catch (err) {
    logger.warn('balance usage footer fetch failed', { error: String(err) });
    return undefined;
  }
}

export function createBalanceUsageTracker(logger: LarkLogger, cfg?: ClawdbotConfig): BalanceUsageTracker {
  const beforePromise = fetchUsage(logger, cfg);
  let formattedPromise: Promise<BalanceUsageMetrics | undefined> | undefined;

  const formatUsage = () => {
    formattedPromise ??= (async () => {
      const before = await beforePromise;
      if (before == null) {
        logger.warn('balance usage footer: initial usage unavailable, fetching final usage snapshot only');
        const afterOnly = await fetchUsage(logger, cfg);
        if (afterOnly == null) {
          logger.warn('balance usage footer: final usage unavailable after missing initial snapshot');
          return undefined;
        }
        const currentMonthUsagePercent = formatQuotaUsagePercent(
          afterOnly.currentMonthUsageUsd,
          afterOnly.quotaPerMonthUsd,
          afterOnly.currentMonthRemainingQuotaUsd,
        );
        if (!currentMonthUsagePercent) {
          logger.warn('balance usage footer: month usage percent unavailable after missing initial snapshot', {
            after: afterOnly,
          });
          return undefined;
        }
        logger.info('balance usage footer: fallback month usage calculated', {
          after: afterOnly,
          currentMonthUsagePercent,
        });
        return { currentMonthUsagePercent };
      }

      const after = await fetchUsage(logger, cfg);
      if (after == null) {
        logger.warn('balance usage footer: final usage unavailable, skipping usage calculation');
        return undefined;
      }

      const used = after.currentMonthUsageUsd - before.currentMonthUsageUsd;
      if (!Number.isFinite(used)) {
        logger.warn('balance usage footer: computed usage is not finite', { before, after, used });
        return undefined;
      }

      const clampedUsed = Math.max(used, 0);
      const balanceUsageRmb = formatRmbUsage(clampedUsed);
      const currentMonthUsagePercent = formatQuotaUsagePercent(
        after.currentMonthUsageUsd,
        after.quotaPerMonthUsd,
        after.currentMonthRemainingQuotaUsd,
      );
      logger.info('balance usage footer: usage calculated', {
        before,
        after,
        used,
        clampedUsed,
        balanceUsageRmb,
        currentMonthUsagePercent: currentMonthUsagePercent ?? null,
      });
      return {
        balanceUsageRmb,
        currentMonthUsagePercent,
      };
    })();
    return formattedPromise;
  };

  return {
    formatUsage,
    async formatUsageRmb() {
      return (await formatUsage())?.balanceUsageRmb;
    },
  };
}
