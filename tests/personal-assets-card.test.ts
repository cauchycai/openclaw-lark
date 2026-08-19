import { describe, expect, test } from 'vitest';
import {
  ASSET_PANEL_ELEMENT_ID,
  buildCardContent,
  buildPersonalAssetsPanel,
  formatAssetLine,
} from '../src/card/builder';
import { insertAssetPanel, removeAssetPanel, replaceAssetPanel } from '../src/assets/card-patch';

describe('formatAssetLine', () => {
  test('shows basename and /workspace address', () => {
    const line = formatAssetLine({ id: 'a', title: 'python-guide.md', source_path: 'python-guide.md' });
    expect(line).toBe('• python-guide.md (/workspace/python-guide.md)');
  });

  test('shows basename with nested path address', () => {
    const line = formatAssetLine({
      id: 'a',
      title: '预算',
      source_path: 'reports/budget.xlsx',
      extension: 'xlsx',
    });
    expect(line).toBe('• budget.xlsx (/workspace/reports/budget.xlsx)');
  });

  test('appends vN when version > 1', () => {
    const line = formatAssetLine({
      id: 'a',
      title: 'notes.md',
      source_path: 'notes.md',
      version: 3,
    });
    expect(line).toBe('• notes.md · v3 (/workspace/notes.md)');
  });

  test('does not append v1', () => {
    const line = formatAssetLine({ id: 'a', title: 'notes.md', source_path: 'notes.md', version: 1 });
    expect(line).toBe('• notes.md (/workspace/notes.md)');
    expect(line).not.toContain('v1');
  });

  test('falls back to title when source_path is empty', () => {
    const line = formatAssetLine({ id: 'a', title: 'file.txt', source_path: '' });
    expect(line).toBe('• file.txt');
  });
});

describe('buildPersonalAssetsPanel', () => {
  test('element_id satisfies Feishu CardKit 20-char limit', () => {
    expect(ASSET_PANEL_ELEMENT_ID.length).toBeLessThanOrEqual(20);
    expect(ASSET_PANEL_ELEMENT_ID).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  test('complete card finalize does not include a pending asset panel (scheme B)', () => {
    const card = buildCardContent('complete', {
      text: 'hello',
      elapsedMs: 1200,
      showToolUse: false,
    });
    const body = JSON.stringify(card);
    expect(body).not.toContain('正在整理资产');
    expect(body).not.toContain('Saving assets');
    expect(card.elements.some((el) => el.element_id === ASSET_PANEL_ELEMENT_ID)).toBe(false);
  });

  test('pending state: notation markdown with element_id', () => {
    const panel = buildPersonalAssetsPanel([], 'pending');
    expect(panel.tag).toBe('markdown');
    expect(panel.element_id).toBe(ASSET_PANEL_ELEMENT_ID);
    expect(JSON.stringify(panel)).toContain('正在整理资产');
  });

  test('no_assets state: notation markdown with element_id', () => {
    const panel = buildPersonalAssetsPanel([], 'no_assets');
    expect(panel.tag).toBe('markdown');
    expect(panel.element_id).toBe(ASSET_PANEL_ELEMENT_ID);
    expect(JSON.stringify(panel)).toContain('未保存资产');
  });

  test('failed state: red notation markdown with element_id', () => {
    const panel = buildPersonalAssetsPanel([], 'failed', 'disk full');
    expect(panel.tag).toBe('markdown');
    expect(panel.element_id).toBe(ASSET_PANEL_ELEMENT_ID);
    const body = JSON.stringify(panel);
    expect(body).toContain('red');
    expect(body).toContain('disk full');
  });

  test('completed state: collapsed collapsible_panel with element_id', () => {
    const panel = buildPersonalAssetsPanel(
      [{ id: 'a', title: 'x.md', source_path: 'x.md' }],
      'completed',
    );
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.element_id).toBe(ASSET_PANEL_ELEMENT_ID);
  });

  test('completed i18n title contains asset count', () => {
    const panel = buildPersonalAssetsPanel(
      [{ id: 'a', title: 'x.md', source_path: 'x.md' }, { id: 'b', title: 'y.md', source_path: 'y.md' }],
      'completed',
    );
    const body = JSON.stringify(panel);
    expect(body).toContain('已保存 2 个资产');
    expect(body).toContain('Saved 2 asset(s)');
  });

  test('completed lists asset lines in panel content', () => {
    const panel = buildPersonalAssetsPanel(
      [{ id: 'a', title: '报告.md', source_path: 'reports/report.md' }],
      'completed',
    );
    const body = JSON.stringify(panel);
    expect(body).toContain('report.md');
    expect(body).toContain('/workspace/reports/report.md');
  });

  test('completed adds Schema V2-compatible Feishu in-app preview links', () => {
    const panel = buildPersonalAssetsPanel(
      [
        { id: 'a', title: 'report.pdf', preview_url: 'https://cowork.example/preview?a' },
        { id: 'b', title: 'notes.md', preview_url: 'https://cowork.example/preview?b' },
      ],
      'completed',
    );
    const body = JSON.stringify(panel);
    expect(body).toContain('[预览](');
    expect(body).not.toContain('"tag":"action"');
    expect(body).not.toContain('"tag":"button"');
    expect(body).toContain('https://applink.feishu.cn/client/web_url/open');
    expect(body).toContain('mode=sidebar-semi');
    expect(body).toContain(encodeURIComponent('https://cowork.example/preview?a'));
    expect(body).toContain(encodeURIComponent('https://cowork.example/preview?b'));
  });

  test('default state is completed', () => {
    const panel = buildPersonalAssetsPanel([{ id: 'a', title: 'x.md', source_path: 'x.md' }]);
    expect(panel.tag).toBe('collapsible_panel');
  });
});

describe('replaceAssetPanel', () => {
  const pendingEl = { tag: 'markdown', element_id: ASSET_PANEL_ELEMENT_ID, content: 'pending' };
  const replacement = { tag: 'collapsible_panel', element_id: ASSET_PANEL_ELEMENT_ID, _replaced: true };

  test('replaces placeholder in v1 card', () => {
    const card: Record<string, unknown> = {
      elements: [
        { tag: 'markdown', content: 'Answer' },
        pendingEl,
        { tag: 'markdown', content: '已完成', text_size: 'notation' },
      ],
    };
    const patched = replaceAssetPanel(card, replacement);
    expect(patched).not.toBeNull();
    const els = patched!.elements as Record<string, unknown>[];
    expect(els).toHaveLength(3);
    expect(els[1]).toMatchObject({ _replaced: true });
    // footer still in place
    expect(els[2]).toMatchObject({ text_size: 'notation' });
  });

  test('replaces placeholder in CardKit 2.0 card', () => {
    const card: Record<string, unknown> = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'Answer' },
          pendingEl,
          { tag: 'markdown', content: '已完成', text_size: 'notation' },
        ],
      },
    };
    const patched = replaceAssetPanel(card, replacement);
    expect(patched).not.toBeNull();
    const els = ((patched!.body as Record<string, unknown>).elements) as Record<string, unknown>[];
    expect(els[1]).toMatchObject({ _replaced: true });
  });

  test('returns null when placeholder element not found', () => {
    const card: Record<string, unknown> = {
      elements: [{ tag: 'markdown', content: 'no placeholder here' }],
    };
    expect(replaceAssetPanel(card, replacement)).toBeNull();
  });

  test('returns null when no elements array', () => {
    expect(replaceAssetPanel({ config: {} }, replacement)).toBeNull();
  });
});

describe('insertAssetPanel (scheme B primary path)', () => {
  const panel = { tag: 'collapsible_panel', _test: true } as Record<string, unknown>;

  test('inserts before trailing notation footer in v1 card', () => {
    const card: Record<string, unknown> = {
      elements: [
        { tag: 'markdown', content: 'Answer text' },
        { tag: 'markdown', content: '已完成', text_size: 'notation' },
      ],
    };
    const patched = insertAssetPanel(card, panel);
    const elements = patched.elements as Record<string, unknown>[];
    expect(elements).toHaveLength(3);
    expect(elements[1]).toMatchObject({ _test: true });
    expect(elements[2]).toMatchObject({ text_size: 'notation' });
  });

  test('inserts before all trailing notation elements in CardKit 2.0 card', () => {
    const card: Record<string, unknown> = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'Answer text' },
          { tag: 'markdown', content: '已完成 · 耗时 3.2s', text_size: 'notation' },
          { tag: 'markdown', content: '↑ 1k ↓ 500', text_size: 'notation' },
        ],
      },
    };
    const patched = insertAssetPanel(card, panel);
    const elements = (patched.body as Record<string, unknown>).elements as Record<string, unknown>[];
    expect(elements).toHaveLength(4);
    expect(elements[1]).toMatchObject({ _test: true });
    expect(elements[2]).toMatchObject({ text_size: 'notation' });
    expect(elements[3]).toMatchObject({ text_size: 'notation' });
  });

  test('appends at end when no notation footer present', () => {
    const card: Record<string, unknown> = {
      elements: [{ tag: 'markdown', content: 'no footer here' }],
    };
    const patched = insertAssetPanel(card, panel);
    const elements = patched.elements as Record<string, unknown>[];
    expect(elements).toHaveLength(2);
    expect(elements[1]).toMatchObject({ _test: true });
  });

  test('returns card unchanged when no elements array', () => {
    const card: Record<string, unknown> = { config: {} };
    expect(insertAssetPanel(card, panel)).toEqual(card);
  });
});

describe('removeAssetPanel', () => {
  const pendingEl = { tag: 'markdown', element_id: ASSET_PANEL_ELEMENT_ID, content: 'pending' };

  test('removes placeholder from v1 card', () => {
    const card: Record<string, unknown> = {
      elements: [
        { tag: 'markdown', content: 'Answer' },
        pendingEl,
        { tag: 'markdown', content: '已完成', text_size: 'notation' },
      ],
    };
    const result = removeAssetPanel(card);
    expect(result).not.toBeNull();
    const els = result!.elements as Record<string, unknown>[];
    expect(els).toHaveLength(2);
    expect(els.some((el) => el.element_id === ASSET_PANEL_ELEMENT_ID)).toBe(false);
    expect(els[1]).toMatchObject({ text_size: 'notation' });
  });

  test('removes placeholder from CardKit 2.0 card', () => {
    const card: Record<string, unknown> = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'Answer' },
          pendingEl,
          { tag: 'markdown', content: '已完成', text_size: 'notation' },
        ],
      },
    };
    const result = removeAssetPanel(card);
    expect(result).not.toBeNull();
    const els = ((result!.body as Record<string, unknown>).elements) as Record<string, unknown>[];
    expect(els).toHaveLength(2);
    expect(els.some((el) => el.element_id === ASSET_PANEL_ELEMENT_ID)).toBe(false);
  });

  test('returns null when placeholder not found', () => {
    const card: Record<string, unknown> = {
      elements: [{ tag: 'markdown', content: 'no placeholder' }],
    };
    expect(removeAssetPanel(card)).toBeNull();
  });
});
