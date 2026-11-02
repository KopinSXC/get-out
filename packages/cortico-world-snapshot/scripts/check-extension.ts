/**
 * 本地版 check:extension:用 cortico 自带的 manifest 解析、dry-mount 与自描述导出核对本包。
 * `tsx scripts/check-extension.ts --write` 重新生成 describe.json;不带参数只核对。
 * 不调用 start(),不碰真实部署;假部署建在系统临时目录,跑完删掉。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseExtensionManifest, type ExtensionPackageJson } from 'cortico/extensions/manifest.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { exportDescribe } from 'cortico/extensions/describe-export.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import definition from '../src/index.ts';

const packageDir = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ExtensionPackageJson & {
  cortico: { describe?: string; webUiClient?: string; webUiStyle?: string };
};
const write = process.argv.includes('--write');
const scratchDir = mkdtempSync(join(tmpdir(), 'cortico-check-'));
let failed = false;
const say = (tag: string, lines: readonly string[]) => { for (const l of lines) console.log(`${tag} ${l}`); };

try {
  const parsed = parseExtensionManifest(pkg, 'zh');
  if (parsed.ok) say('ok  ', [`manifest: kind=${parsed.manifest.kind} api=${parsed.manifest.api}`]);
  else { failed = true; say('FAIL', parsed.reasons); }
  say('warn', parsed.warnings);

  for (const f of [pkg.cortico.webUiClient, pkg.cortico.webUiStyle]) {
    if (f && !existsSync(join(packageDir, f))) { failed = true; say('FAIL', [`${f} 不存在,先跑 npm run build`]); }
  }

  const def = definition as unknown as WorldDefinition<WorldSection>;
  const report = await dryMountWorld(def, { scratchDir, packageDir, hasWebUiClient: !!pkg.cortico.webUiClient });
  say('ok  ', report.ok);
  say('warn', report.warnings);
  say('FAIL', report.failures);
  if (report.failures.length) failed = true;

  const describeFile = join(packageDir, pkg.cortico.describe ?? 'describe.json');
  const want = await exportDescribe('world', def, { scratchDir, packageDir });
  if (!want) { failed = true; say('FAIL', ['定义里没有 describe']); }
  else if (write) {
    writeFileSync(describeFile, `${JSON.stringify(want, null, 2)}\n`);
    say('ok  ', [`已写 ${describeFile}`]);
  } else {
    const have = existsSync(describeFile) ? JSON.parse(readFileSync(describeFile, 'utf8')) : null;
    if (isDeepStrictEqual(have, want)) say('ok  ', ['describe.json 与定义一致']);
    else { failed = true; say('FAIL', ['describe.json 过期,跑 npm run build 重新生成']); }
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
