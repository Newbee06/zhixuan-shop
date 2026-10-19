// 秘密扫描器测试（P3-10：凭证模式 + 安全占位符）
//
// 本文件只做三件事：
//  1. 断言每种凭证模式能命中对应形态的凭证样例；
//  2. 断言安全占位符（测试 dummy、公开合约地址、YOUR_/test_/example 占位）不被误报；
//  3. 自检仓库：已跟踪文件 + 未提交 diff 不含凭证；.gitignore 覆盖 .env/密钥文件；
//     生成产物 tests/_stock-worker-tmp.mjs 未被跟踪（P3-12）。
//
// 模式表与 .github/workflows/ci.yml 的秘密扫描步骤镜像一致，改一处须同步另一处。
// 凭证样例一律用字符串拼接构造，文件内绝不出现真实形态的密钥字面量。
// 扫描命中时只输出 文件:行号:类型，绝不输出匹配行内容（避免把秘密打进日志）。

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const repoRoot = path.resolve(dir);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, extra); }
}

// ---- 1. 凭证模式（与 ci.yml 秘密扫描步骤镜像一致）----
const PATTERNS = [
  { name: 'github-pat-fine-grained', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'github-pat-classic', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'cloudflare-api-token-assignment', re: /(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY)[ ]*[=:][ ]*['"]?[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{10,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'stripe-live-key', re: /[sr]k_live_[A-Za-z0-9]{10,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{20}/ },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
const byName = {};
for (const p of PATTERNS) byName[p.name] = p.re;
function matchesAny(s) {
  for (const p of PATTERNS) if (p.re.test(s)) return p.name;
  return null;
}

// 凭证样例（拼接构造，绝非真实密钥；长度取真实形态的下限以上）
const CREDENTIAL_FIXTURES = [
  ['github-pat-fine-grained', 'github_pat_' + 'aB3_'.repeat(6)],
  ['github-pat-classic', 'ghp_' + 'A'.repeat(36)],
  ['github-pat-classic', 'gho_' + 'a'.repeat(36)],
  ['github-pat-classic', 'ghu_' + 'a'.repeat(36)],
  ['github-pat-classic', 'ghs_' + 'a'.repeat(36)],
  ['github-pat-classic', 'ghr_' + 'a'.repeat(40)],
  ['cloudflare-api-token-assignment', 'CLOUDFLARE_API_TOKEN=' + 'x'.repeat(40)],
  ['cloudflare-api-token-assignment', 'CF_API_TOKEN: ' + 'y'.repeat(40)],
  ['cloudflare-api-token-assignment', 'CLOUDFLARE_API_KEY="' + 'z'.repeat(40) + '"'],
  ['openai-project-key', 'sk-proj-' + 'a'.repeat(20)],
  ['anthropic-key', 'sk-ant-' + 'a'.repeat(20)],
  ['stripe-live-key', 'sk_live_' + 'a'.repeat(24)],
  ['stripe-live-key', 'rk_live_' + 'a'.repeat(24)],
  ['slack-token', 'xoxb-' + '1'.repeat(12)],
  ['aws-access-key', 'AKIA' + 'A'.repeat(16)],
  ['google-api-key', 'AIza' + 'A'.repeat(35)],
  ['gitlab-pat', 'glpat-' + 'a'.repeat(20)],
  ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['private-key', '-----BEGIN RSA ' + 'PRIVATE KEY-----'],
  ['private-key', '-----BEGIN EC ' + 'PRIVATE KEY-----'],
  ['private-key', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'],
];
for (const [want, sample] of CREDENTIAL_FIXTURES) {
  const hit = matchesAny(sample);
  check('credential fixture matches ' + want, hit === want, '(got ' + hit + ')');
}

// ---- 2. 安全占位符：必须不被误报 ----
// 公开合约地址（0x + 40 hex，商家公开收款/合约地址，不是秘密）；测试 dummy 地址；
// YOUR_/test_/example 占位；短于阈值的残缺形态；CERTIFICATE（非私钥）。
const SAFE_FIXTURES = [
  '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', // 公开：X Layer USDT0 合约
  '0x55d398326f99059fF775485246999027B3197955', // 公开：BEP20 USDT 合约
  '0x1e4a5963abfd975d8c9021ce480b42188849d41d', // 公开：旧 X Layer USDT 合约（已废弃，仍公开）
  '0x1111111111111111111111111111111111111111', // 测试 dummy 收款地址
  '0x2222222222222222222222222222222222222222', // 测试 dummy 收款地址
  'CLOUDFLARE_API_TOKEN=YOUR_TOKEN_HERE', // 占位（15 字符，低于 20 阈值）
  'CF_API_TOKEN=test-token', // 测试占位
  'CLOUDFLARE_API_KEY=', // 空值
  'sk-proj-TEST', // 短占位
  'sk-test-1234567890', // 测试 Key（非 live，不扫）
  'test-key',
  'test-resend',
  'd1-local-test-123',
  'https://example.com/tutorial-binance',
  'noreply@your-domain.example',
  '0xYOUR_XLAYER_USDT_CONTRACT', // 旧占位符
  '0xYOUR_BINANCE_BEP20_ADDRESS', // 旧占位符
  '-----BEGIN ' + 'CERTIFICATE-----', // 证书头不是私钥
  'github_pat_' + 'short', // 残缺形态（低于 20 阈值）
  'ghp_' + 'A'.repeat(10), // 残缺形态（低于 36 阈值）
  'AKIA' + 'A'.repeat(10), // 残缺形态（低于 16 阈值）
];
for (const sample of SAFE_FIXTURES) {
  const hit = matchesAny(sample);
  check('safe placeholder not flagged: ' + sample.slice(0, 40), hit === null, '(flagged as ' + hit + ')');
}

// ---- 3a. .gitignore 覆盖 .env/密钥文件与生成产物 ----
const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
for (const entry of ['.env', '*.pem', '*.key', 'tests/_stock-worker-tmp.mjs']) {
  check('.gitignore covers ' + entry, gitignore.split('\n').some((l) => l.trim() === entry), '(missing)');
}

// ---- 3b. 不应跟踪的文件确实未被跟踪 ----
let tracked = [];
try {
  tracked = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (e) {
  check('git ls-files runs', false, String(e && e.message ? e.message : e));
}
const FORBIDDEN_TRACKED = [
  [/\.env(\.|$)/, 'dotenv file'],
  [/\.pem$/, 'pem file'],
  [/\.key$/, 'key file'],
  [/\.p12$/, 'p12 file'],
  [/\.pfx$/, 'pfx file'],
];
for (const [re, label] of FORBIDDEN_TRACKED) {
  const bad = tracked.filter((f) => re.test(f));
  check('no tracked ' + label, bad.length === 0, '(tracked: ' + bad.slice(0, 5).join(', ') + ')');
}
check('generated _stock-worker-tmp.mjs not tracked (P3-12)', !tracked.includes('tests/_stock-worker-tmp.mjs'));

// ---- 3c. 仓库自检：已跟踪文件 + 未提交 diff 不含凭证（只报文件:行号:类型） ----
function scanText(label, text) {
  const hits = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push(label + ':' + (i + 1) + ':' + p.name);
    }
  });
  return hits;
}
let scanHits = [];
for (const f of tracked) {
  let content;
  try { content = fs.readFileSync(path.join(repoRoot, f), 'utf8'); } catch (e) { continue; }
  scanHits = scanHits.concat(scanText(f, content));
}
try {
  const diff = execSync('git diff HEAD', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  scanHits = scanHits.concat(scanText('uncommitted-diff', added));
} catch (e) { /* 无 HEAD 或无 diff 时跳过 diff 扫描 */ }
if (scanHits.length) console.log('SCAN HITS:\n' + scanHits.slice(0, 50).join('\n'));
check('repo self-scan: no credentials in tracked files or uncommitted diff', scanHits.length === 0, '(' + scanHits.length + ' hits)');

console.log('review-config-test: pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
