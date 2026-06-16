import { describe, expect, it } from 'vitest';

import { getPluginVersion, getPluginVersionDisplay, getUserAgent } from '../src/core/version';

describe('version metadata', () => {
  it('keeps the upstream package version and shows fork metadata separately', () => {
    expect(getPluginVersion()).toBe('2026.6.16');
    expect(getPluginVersionDisplay()).toBe('upstream 2026.6.16 / fork turingclaw 2026.6.16.1');
  });

  it('includes fork metadata in the User-Agent without spaces', () => {
    expect(getUserAgent()).toMatch(/^openclaw-lark\/2026\.6\.16\+turingclaw-2026\.6\.16\.1\/(?:mac|linux|windows)$/u);
  });
});
