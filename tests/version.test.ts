import { describe, expect, it } from 'vitest';

import { getPluginVersion, getPluginVersionDisplay, getUserAgent } from '../src/core/version';

describe('version metadata', () => {
  it('keeps the upstream package version and shows fork metadata separately', () => {
    expect(getPluginVersion()).toBe('2026.6.3');
    expect(getPluginVersionDisplay()).toBe('upstream 2026.6.3 / fork turingclaw 2026.6.2.4');
  });

  it('includes fork metadata in the User-Agent without spaces', () => {
    expect(getUserAgent()).toMatch(/^openclaw-lark\/2026\.6\.3\+turingclaw-2026\.6\.2\.4\/(?:mac|linux|windows)$/u);
  });
});
