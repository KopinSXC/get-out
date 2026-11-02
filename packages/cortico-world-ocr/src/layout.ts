/**
 * OCR 结果的纯函数部分:坐标换回屏幕像素、按行合并碎片、排版输出、按模式查找。
 * 不碰系统,方便在任何平台上测试。
 */

/** ocr.ps1 给出的一个文本块,坐标是识别图里的像素。 */
export interface RawBlock {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Windows OCR 给的行序号。 */
  line: number;
}

export interface RawResult {
  ok: true;
  source: 'region' | 'monitor' | 'window';
  origin: { x: number; y: number };
  size: { w: number; h: number };
  image: { w: number; h: number };
  fx: number;
  fy: number;
  language: string;
  angle: number | null;
  blocks: RawBlock[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 合并后一行里的一个碎片,记着它在行文本里的位置。 */
export interface Fragment extends Box {
  text: string;
  start: number;
  end: number;
}

export interface Row extends Box {
  text: string;
  fragments: Fragment[];
}

/** 输出上限,超过就截断并注明位置。 */
export const MAX_OUTPUT_CHARS = 8000;

/** 识别图坐标 → 屏幕原始像素(整数)。 */
export function toScreen(raw: RawResult): Array<Box & { text: string; line: number }> {
  const fx = raw.fx > 0 ? raw.fx : 1;
  const fy = raw.fy > 0 ? raw.fy : 1;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : raw.blocks ? [raw.blocks as unknown as RawBlock] : [];
  return blocks.map((b) => {
    const x0 = raw.origin.x + b.x / fx;
    const y0 = raw.origin.y + b.y / fy;
    const x1 = raw.origin.x + (b.x + b.w) / fx;
    const y1 = raw.origin.y + (b.y + b.h) / fy;
    const x = Math.round(x0);
    const y = Math.round(y0);
    return { text: String(b.text ?? ''), line: b.line, x, y, w: Math.max(1, Math.round(x1) - x), h: Math.max(1, Math.round(y1) - y) };
  });
}

/** 不用空格分隔的文字:汉字、假名、全角标点。 */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

/** 两个碎片之间放什么:CJK 紧挨着、拉丁文加空格、隔得远的加两个空格当分栏。 */
function joiner(prev: Box & { text: string }, next: Box & { text: string }): string {
  const gap = next.x - (prev.x + prev.w);
  const h = Math.max(prev.h, next.h, 1);
  if (gap > 1.5 * h) return '  ';
  const a = prev.text.at(-1) ?? '';
  const b = next.text[0] ?? '';
  if (DENSE.test(a) || DENSE.test(b)) return gap > 0.6 * h ? ' ' : '';
  return ' ';
}

function union(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function verticalOverlap(a: Box, b: Box): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

function horizontalOverlap(a: Box, b: Box): number {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

/**
 * 按行合并:先按 Windows 给的行把词拼成段,再把垂直方向重叠过半、水平方向不重叠的段并成一行。
 * 空白碎片丢掉,空行丢掉。结果从上到下、每行从左到右。
 */
export function mergeRows(blocks: ReadonlyArray<Box & { text: string; line: number }>): Row[] {
  const byLine = new Map<number, Array<Box & { text: string }>>();
  for (const b of blocks) {
    const text = b.text.trim();
    if (!text) continue;
    const list = byLine.get(b.line) ?? [];
    list.push({ ...b, text });
    byLine.set(b.line, list);
  }

  // 一段 = Windows 的一行
  const segments = [...byLine.values()].map((words) => {
    words.sort((a, b) => a.x - b.x);
    return { ...union(words), words };
  });
  segments.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);

  const groups: Array<{ anchor: Box; segs: typeof segments }> = [];
  for (const seg of segments) {
    const home = groups.find((g) => {
      const v = verticalOverlap(g.anchor, seg);
      if (v < 0.5 * Math.min(g.anchor.h, seg.h)) return false;
      return g.segs.every((s) => horizontalOverlap(s, seg) <= 0);
    });
    if (home) home.segs.push(seg);
    else groups.push({ anchor: seg, segs: [seg] });
  }

  const rows: Row[] = groups.map((g) => {
    const words = g.segs.flatMap((s) => s.words).sort((a, b) => a.x - b.x);
    let text = '';
    const fragments: Fragment[] = [];
    words.forEach((w, i) => {
      if (i > 0) text += joiner(words[i - 1], w);
      const start = text.length;
      text += w.text;
      fragments.push({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, start, end: text.length });
    });
    return { ...union(words), text, fragments };
  });
  rows.sort((a, b) => a.y - b.y || a.x - b.x);
  return rows;
}

export const boxText = (b: Box) => `${b.x},${b.y},${b.w},${b.h}`;

const SOURCE_LABEL: Record<RawResult['source'], string> = {
  region: '指定区域',
  monitor: '前台窗口所在显示器',
  window: '前台窗口',
};

export function header(raw: RawResult, rowCount: number): string {
  return `OCR ${SOURCE_LABEL[raw.source] ?? raw.source} ${raw.origin.x},${raw.origin.y} ${raw.size.w}x${raw.size.h}`
    + `,识别图 ${raw.image.w}x${raw.image.h},语言 ${raw.language || '未知'},${rowCount} 行`;
}

/** 把若干行拼起来,超过上限就停在整行处,并写明截在第几行。 */
export function clip(head: string, lines: readonly string[], limit = MAX_OUTPUT_CHARS, hint = ''): string {
  let out = head;
  for (let i = 0; i < lines.length; i++) {
    const next = `${out}\n${lines[i]}`;
    if (next.length > limit) {
      const note = `\n…[已截断:共 ${lines.length} 行,只显示前 ${i} 行,从第 ${i + 1} 行起省略${hint}]`;
      return `${out}${note}`;
    }
    out = next;
  }
  return out;
}

/** ocr_screen 的回执:一行一条,`x,y,w,h  文本`。 */
export function formatRows(raw: RawResult, rows: readonly Row[], limit = MAX_OUTPUT_CHARS): string {
  const head = `${header(raw, rows.length)}\n坐标 x,y,w,h 是屏幕原始像素`;
  if (!rows.length) return `${head}\n(没有识别到文字)`;
  return clip(head, rows.map((r) => `${boxText(r)}  ${r.text}`), limit, ';可以用 region 缩小范围');
}

export interface Match extends Box {
  /** 匹配到的那段文字。 */
  text: string;
  /** 所在行全文。 */
  line: string;
  cx: number;
  cy: number;
}

/** 模式按不区分大小写的正则用;不是合法正则就当普通文字找。 */
export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'giu');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  }
}

/** 在合并后的行里找,坐标取命中那几个碎片的外框,并给出中心点方便点击。 */
export function findMatches(rows: readonly Row[], pattern: string, max = 50): Match[] {
  const re = compilePattern(pattern);
  const out: Match[] = [];
  for (const row of rows) {
    re.lastIndex = 0;
    for (const m of row.text.matchAll(re)) {
      if (m[0] === '') continue;
      const s = m.index ?? 0;
      const e = s + m[0].length;
      const hit = row.fragments.filter((f) => f.start < e && f.end > s);
      const box = hit.length ? union(hit) : { x: row.x, y: row.y, w: row.w, h: row.h };
      out.push({ ...box, text: m[0], line: row.text, cx: Math.round(box.x + box.w / 2), cy: Math.round(box.y + box.h / 2) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function formatMatches(raw: RawResult, rows: readonly Row[], pattern: string, matches: readonly Match[], limit = MAX_OUTPUT_CHARS): string {
  const head = `${header(raw, rows.length)}\n查找 ${JSON.stringify(pattern)}:${matches.length} 处(坐标 x,y,w,h 与中心点都是屏幕原始像素)`;
  if (!matches.length) return `${head}\n(没有匹配)`;
  return clip(head, matches.map((m, i) => `${i + 1}. ${boxText(m)} 中心 ${m.cx},${m.cy}  ${m.text}${m.text === m.line ? '' : `  ← ${m.line}`}`), limit);
}
