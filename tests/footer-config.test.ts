import { describe, expect, it } from 'vitest';

import { DEFAULT_FOOTER_CONFIG, resolveFooterConfig } from '../src/core/footer-config';

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
});
