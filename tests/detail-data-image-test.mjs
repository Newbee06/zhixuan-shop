// 商品详情：拦截 data: 图片，避免上游导入描述嵌入假收款二维码。
// 同源路径仍渲染 img；外站 https 仍是「查看图片」链接。不连网络、不启浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');

function extractFunction(src, name) {
  const key = 'function ' + name + '(';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('missing function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; continue; }
    if (c === '/' && n === '*') { blockComment = true; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

const names = ['escH', 'detailImgExtOk', 'detailImgBad', 'detailParsedUrl', 'detailIsSameOriginImg', 'detailIsExternalHttpsImg', 'detailImgFromLine', 'detailLi', 'detailKv', 'detailRichHTML'];
const detailRichHTML = new Function(names.map((n) => extractFunction(html, n)).join('\n') + '\nreturn detailRichHTML;')();

globalThis.location = { href: 'https://shop.example/', origin: 'https://shop.example' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, extra == null ? '' : extra); }
}

check('allow helper removed', !/function\s+detailIsDataImage\s*\(/.test(html));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const cases = [
  ['lowercase data:image/png', PNG],
  ['uppercase DATA:image/png', 'DATA:image/png;base64,iVBORw0KGgo='],
  ['leading whitespace data:', '   data:image/png;base64,iVBORw0KGgo='],
  ['markdown data image', '![](data:image/png;base64,iVBORw0KGgo=)'],
];
for (const [name, src] of cases) {
  const out = detailRichHTML(src);
  check(name + ' does not emit img', !/<img\b/i.test(out), out);
  check(name + ' is not a link', !/<a\b/i.test(out) && !out.includes('查看图片'), out);
  check(name + ' stays escaped text', out.includes('data:image/png;base64,iVBORw0KGgo=') || out.includes('DATA:image/png;base64,iVBORw0KGgo='), out);
}

const breakout = 'data:image/png;base64,"><img src=x onerror=alert(1)>';
const breakoutOut = detailRichHTML(breakout);
check('data: markup breakout stays text', !/<img\b/i.test(breakoutOut) && breakoutOut.includes('&lt;img') && breakoutOut.includes('&quot;'), breakoutOut);

const same = detailRichHTML('/xxx.png');
check('same-origin /xxx.png is img', /<img\b[^>]*\bsrc="\/xxx\.png"/.test(same) && !same.includes('查看图片'), same);
check('same-origin img keeps lazy and no-referrer', same.includes('referrerpolicy="no-referrer"') && same.includes('loading="lazy"'), same);

const ext = detailRichHTML('https://cdn.example/pay.png');
check('external https is 查看图片 link', /<a\b[^>]*href="https:\/\/cdn\.example\/pay\.png"[^>]*rel="noopener noreferrer"[^>]*target="_blank"[^>]*>查看图片<\/a>/.test(ext), ext);
check('external https is not an img', !/<img\b/i.test(ext), ext);

console.log('DETAIL DATA IMAGE DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
