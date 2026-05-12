import { describe, expect, it } from 'vitest';

import { DEFAULT_FOOTER_CONFIG, resolveFooterConfig } from '../src/core/footer-config';

describe('footer-config defaults', () => {
  it('enables balance usage by default', () => {
    expect(DEFAULT_FOOTER_CONFIG.balanceUsage).toBe(true);
    expect(resolveFooterConfig().balanceUsage).toBe(true);
    expect(resolveFooterConfig({}).balanceUsage).toBe(true);
  });

  it('still allows explicit opt-out', () => {
    expect(resolveFooterConfig({ balanceUsage: false }).balanceUsage).toBe(false);
  });
});
