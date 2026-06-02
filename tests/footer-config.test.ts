import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_FOOTER_CONFIG, readRuntimeFooterConfig, resolveFooterConfig } from '../src/core/footer-config';

describe('footer-config defaults', () => {
  it('hides balance usage by default', () => {
    expect(DEFAULT_FOOTER_CONFIG.balanceUsage).toBe(false);
    expect(resolveFooterConfig().balanceUsage).toBe(false);
    expect(resolveFooterConfig({}).balanceUsage).toBe(false);
  });

  it('shows balance usage only when explicitly enabled', () => {
    expect(resolveFooterConfig({ balanceUsage: true }).balanceUsage).toBe(true);
    expect(resolveFooterConfig({ balanceUsage: false }).balanceUsage).toBe(false);
  });

  it('can enable balance usage from a runtime footer config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-lark-footer-'));
    try {
      const path = join(dir, 'footer.json');
      writeFileSync(path, JSON.stringify({ balanceUsage: true }));

      expect(readRuntimeFooterConfig({ runtimeConfigPath: path })).toEqual({ balanceUsage: true });
      expect(resolveFooterConfig({}, { runtimeConfigPath: path }).balanceUsage).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports nested footer runtime config and can explicitly disable balance usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-lark-footer-'));
    try {
      const path = join(dir, 'footer.json');
      writeFileSync(path, JSON.stringify({ footer: { status: true, balanceUsage: false } }));

      expect(resolveFooterConfig({ balanceUsage: true }, { runtimeConfigPath: path })).toEqual({
        ...DEFAULT_FOOTER_CONFIG,
        status: true,
        balanceUsage: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores missing or malformed runtime footer config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-lark-footer-'));
    try {
      const malformed = join(dir, 'malformed.json');
      writeFileSync(malformed, '{');

      expect(readRuntimeFooterConfig({ runtimeConfigPath: join(dir, 'missing.json') })).toBeUndefined();
      expect(readRuntimeFooterConfig({ runtimeConfigPath: malformed })).toBeUndefined();
      expect(resolveFooterConfig({ balanceUsage: true }, { runtimeConfigPath: malformed }).balanceUsage).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
