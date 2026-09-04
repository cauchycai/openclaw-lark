import { describe, expect, it } from 'vitest';

import { parseContentDispositionFileName, repairFeishuFileName } from '../src/messaging/outbound/media';

describe('parseContentDispositionFileName', () => {
  it('decodes RFC 5987 filename* as UTF-8', () => {
    const name = parseContentDispositionFileName(
      "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf",
    );
    expect(name).toBe('中文.pdf');
  });

  it('prefers filename* over a latin1 filename=', () => {
    const mojibake = Buffer.from('中文.pdf', 'utf8').toString('latin1');
    const name = parseContentDispositionFileName(
      `attachment; filename="${mojibake}"; filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf`,
    );
    expect(name).toBe('中文.pdf');
  });

  it('re-decodes Feishu filename= UTF-8 bytes exposed as latin1', () => {
    const mojibake = Buffer.from('BOSS直聘20260824.pdf', 'utf8').toString('latin1');
    const name = parseContentDispositionFileName(`attachment; filename="${mojibake}"`);
    expect(name).toBe('BOSS直聘20260824.pdf');
  });

  it('leaves ASCII filenames unchanged', () => {
    expect(parseContentDispositionFileName('attachment; filename="book.rar"')).toBe('book.rar');
  });

  it('returns undefined when no filename is present', () => {
    expect(parseContentDispositionFileName('attachment')).toBeUndefined();
  });
});

describe('repairFeishuFileName', () => {
  it('repairs latin1-decoded UTF-8', () => {
    const mojibake = Buffer.from('中文标题测试_BOSS直聘20260902.txt', 'utf8').toString('latin1');
    expect(repairFeishuFileName(mojibake)).toBe('中文标题测试_BOSS直聘20260902.txt');
  });

  it('leaves already-correct CJK unchanged', () => {
    expect(repairFeishuFileName('中文标题测试.txt')).toBe('中文标题测试.txt');
  });
});
