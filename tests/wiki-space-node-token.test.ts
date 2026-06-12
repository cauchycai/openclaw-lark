import { describe, expect, it } from 'vitest';

import { normalizeWikiSpaceNodeGetToken } from '../src/tools/oapi/wiki/space-node';

describe('wiki space node get token normalization', () => {
  it('accepts node_token as an alias for token', () => {
    expect(normalizeWikiSpaceNodeGetToken({ node_token: 'WikiNodeTokenForTest1234567890' })).toBe(
      'WikiNodeTokenForTest1234567890',
    );
  });

  it('extracts tokens from wiki URLs', () => {
    expect(
      normalizeWikiSpaceNodeGetToken({
        token: 'https://www.feishu.cn/wiki/WikiNodeTokenForTest1234567890?from=copylink',
      }),
    ).toBe('WikiNodeTokenForTest1234567890');
  });

  it('prefers token over node_token when both are provided', () => {
    expect(normalizeWikiSpaceNodeGetToken({ token: 'primary', node_token: 'alias' })).toBe('primary');
  });
});
