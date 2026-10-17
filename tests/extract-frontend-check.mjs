// 静态检查：提取 src/frontend.html 中所有内嵌 <script> 块，逐个做 node --check 语法检查。
// 用途：CI 静态检查组。frontend.html 由 Worker 以 Text 模块方式提供，内嵌 JS 必须语法正确。
// 注意：仅做语法检查，不执行代码；不依赖浏览器。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const html = readFileSync(new URL('../src/frontend.html', import.meta.url), 'utf-8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);
console.log('FRONTEND SCRIPT BLOCKS: ' + blocks.length);
if (blocks.length === 0) { console.error('FAIL: no inline <script> blocks found in src/frontend.html'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'frontend-check-'));
let fail = 0;
try {
  blocks.forEach((code, i) => {
    const f = join(dir, 'block-' + i + '.js');
    writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      console.log('PASS: script block ' + i + ' (' + code.length + ' bytes) syntax OK');
    } catch (e) {
      fail++;
      console.error('FAIL: script block ' + i + ' syntax error');
      console.error(String((e.stdout || '') + (e.stderr || '')).slice(0, 2000));
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('FRONTEND CHECK DONE pass=' + (blocks.length - fail) + ' fail=' + fail);
if (fail) process.exit(1);
