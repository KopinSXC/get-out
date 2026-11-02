import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clip, findMatches, formatMatches, formatRows, mergeRows, toScreen, type RawBlock, type RawResult } from '../src/layout.ts';
import { SCRIPT_PATH, runOcr } from '../src/ocr.ts';

function raw(blocks: RawBlock[], over: Partial<RawResult> = {}): RawResult {
  return {
    ok: true, source: 'monitor', origin: { x: 1920, y: 0 }, size: { w: 3200, h: 1800 },
    image: { w: 1600, h: 900 }, fx: 0.5, fy: 0.5, language: 'zh-Hans-CN', angle: null, blocks, ...over,
  };
}

describe('toScreen', () => {
  it('按缩放系数与原点换回屏幕像素', () => {
    const [b] = toScreen(raw([{ text: '确定', x: 100, y: 50, w: 20, h: 10, line: 0 }]));
    expect(b).toMatchObject({ x: 1920 + 200, y: 100, w: 40, h: 20 });
  });
});

describe('mergeRows', () => {
  it('汉字紧挨着,英文加空格,空碎片丢弃', () => {
    const rows = mergeRows(toScreen(raw([
      { text: '文', x: 10, y: 10, w: 10, h: 10, line: 0 },
      { text: '件', x: 21, y: 10, w: 10, h: 10, line: 0 },
      { text: ' ', x: 32, y: 10, w: 2, h: 10, line: 0 },
      { text: 'Hello', x: 10, y: 40, w: 30, h: 10, line: 1 },
      { text: 'World', x: 44, y: 40, w: 30, h: 10, line: 1 },
    ], { origin: { x: 0, y: 0 }, fx: 1, fy: 1 })));
    expect(rows.map((r) => r.text)).toEqual(['文件', 'Hello World']);
  });

  it('同一高度的不同段并成一行,远的用两个空格隔开', () => {
    const rows = mergeRows(toScreen(raw([
      { text: '名称', x: 10, y: 10, w: 20, h: 10, line: 0 },
      { text: '大小', x: 200, y: 11, w: 20, h: 10, line: 1 },
      { text: '下一行', x: 10, y: 30, w: 30, h: 10, line: 2 },
    ], { origin: { x: 0, y: 0 }, fx: 1, fy: 1 })));
    expect(rows.map((r) => r.text)).toEqual(['名称  大小', '下一行']);
    expect(rows[0]).toMatchObject({ x: 10, y: 10, w: 210, h: 11 });
  });

  it('PowerShell 把单元素数组展开成对象时也能处理', () => {
    const r = raw({ text: 'X', x: 0, y: 0, w: 1, h: 1, line: 0 } as unknown as RawBlock[]);
    expect(toScreen(r)).toHaveLength(1);
  });
});

describe('find', () => {
  const rows = mergeRows(toScreen(raw([
    { text: '取消', x: 100, y: 500, w: 20, h: 10, line: 0 },
    { text: '确定', x: 140, y: 500, w: 20, h: 10, line: 0 },
    { text: 'Save', x: 100, y: 600, w: 30, h: 10, line: 1 },
    { text: 'As', x: 134, y: 600, w: 10, h: 10, line: 1 },
  ])));

  it('框住命中的碎片并给中心点', () => {
    const [m] = findMatches(rows, '确定');
    expect(m).toMatchObject({ text: '确定', x: 1920 + 280, y: 1000, w: 40, h: 20, cx: 1920 + 300, cy: 1010 });
  });

  it('正则不区分大小写,非法正则当普通文字', () => {
    expect(findMatches(rows, 'save as')).toHaveLength(1);
    expect(findMatches(rows, '取消|确定')).toHaveLength(2);
    expect(findMatches(rows, '确定(')).toHaveLength(0);
    const text = formatMatches(raw([]), rows, '确定', findMatches(rows, '确定'));
    expect(text).toContain('中心 2220,1010');
  });
});

describe('输出', () => {
  it('超过上限在整行处截断并写明位置', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${i}`.padEnd(20, 'x'));
    const out = clip('头', lines, 8000);
    expect(out.length).toBeLessThan(8000 + 120);
    expect(out).toMatch(/已截断:共 1000 行,只显示前 (\d+) 行,从第 \d+ 行起省略/);
  });

  it('formatRows 没文字时说明', () => {
    expect(formatRows(raw([]), [])).toContain('没有识别到文字');
  });
});

describe('ocr.ps1', () => {
  it('带 UTF-8 BOM,Windows PowerShell 5.1 才能正确读中文', () => {
    const head = readFileSync(SCRIPT_PATH).subarray(0, 3);
    expect([...head]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('非 Windows 上直接返回不支持,不抛错', async () => {
    if (process.platform === 'win32') return;
    const r = await runOcr({ scale: 1, foregroundOnly: false }, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false });
  });
});
