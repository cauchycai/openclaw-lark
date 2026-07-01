import { describe, expect, it } from 'vitest';

import { getPluginVersion, getPluginVersionDisplay, getUserAgent } from '../src/core/version';

describe('version metadata', () => {
  it('keeps the upstream package version and shows fork metadata separately', () => {
    expect(getPluginVersion()).toBe('2026.6.30');
    expect(getPluginVersionDisplay()).toBe('upstream 2026.6.30 / fork turingclaw 2026.6.30.1');
  });

  it('includes fork metadata in the User-Agent without spaces', () => {
    expect(getUserAgent()).toMatch(/^openclaw-lark\/2026\.6\.30\+turingclaw-2026\.6\.30\.1\/(?:mac|linux|windows)$/u);
  });
});
