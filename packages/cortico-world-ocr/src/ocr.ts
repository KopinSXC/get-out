/**
 * 调 ocr.ps1:参数用 base64 JSON 传,结果从 stdout 读 base64 JSON。
 * 截图只在 PowerShell 进程内存里,不落盘,也不回传图片字节。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RawResult } from './layout.ts';

export const SCRIPT_PATH = fileURLToPath(new URL('./ocr.ps1', import.meta.url));
/** 识别前长边上限。 */
export const MAX_EDGE = 1600;
/** stdout 上限;正常一屏的结果远小于此。 */
const MAX_STDOUT = 16 * 1024 * 1024;

export interface OcrRequest {
  region?: { x: number; y: number; w: number; h: number };
  scale: number;
  foregroundOnly: boolean;
  language?: string;
}

export type OcrResponse = RawResult | { ok: false; reason: string };

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** 测试或非常规安装时替换解释器。 */
  powershell?: string;
}

export function supported(): boolean {
  return process.platform === 'win32';
}

export function runOcr(req: OcrRequest, opts: RunOptions): Promise<OcrResponse> {
  if (!supported()) {
    return Promise.resolve({ ok: false, reason: `只支持 Windows 10/11,当前平台是 ${process.platform}` });
  }
  const params = Buffer.from(JSON.stringify({ ...req, maxEdge: MAX_EDGE }), 'utf8').toString('base64');
  const exe = opts.powershell ?? 'powershell.exe';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-ParamsB64', params];

  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const done = (r: OcrResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: `OCR 超时(${Math.round(opts.timeoutMs / 1000)} 秒)` }), opts.timeoutMs);
    const onAbort = () => done({ ok: false, reason: '已取消' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    child.stdout.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > MAX_STDOUT) done({ ok: false, reason: 'OCR 输出过大,已中止' });
      else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => { if (err.length < 64) err.push(b); });
    child.on('error', (e) => done({ ok: false, reason: `启动 ${exe} 失败: ${e.message}` }));
    child.on('close', (code) => {
      // 结果是最后一行;前面如果混进了别的管道输出就丢掉
      const text = Buffer.concat(out).toString('ascii').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
      if (!text) {
        const msg = Buffer.concat(err).toString('utf8').trim().slice(0, 500);
        done({ ok: false, reason: `ocr.ps1 没有输出(退出码 ${code})${msg ? `: ${msg}` : ''}` });
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as OcrResponse;
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) done(parsed);
        else done({ ok: false, reason: 'ocr.ps1 输出格式不对' });
      } catch {
        done({ ok: false, reason: 'ocr.ps1 输出解析失败' });
      }
    });
  });
}
