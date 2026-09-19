// 生成微信分享用长图：先量高度，再按精确高度截图
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIR = __dirname;
const SHOT = path.join(DIR, '_shot.html');
const OUT_PNG = path.join(DIR, '..', 'assets', 'route-price-long.png');
const WIDTH = 1000;

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

function runChrome(args, outFile) {
  try {
    execFileSync(CHROME, args, {
      stdio: ['ignore', outFile ? fs.openSync(outFile, 'w') : 'ignore', 'ignore'],
      timeout: 180000
    });
  } catch (e) { /* Windows 上常被 SIGTERM，产物照样生成 */ }
}

function probeHeight() {
  const out = path.join(DIR, '_shotdom.txt');
  runChrome([
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--force-device-scale-factor=1', `--window-size=${WIDTH},900`, '--hide-scrollbars',
    '--user-data-dir=' + path.join(DIR, '_cdp_shot'),
    '--virtual-time-budget=7000', '--dump-dom', 'file:///' + SHOT.replace(/\\/g, '/')
  ], out);
  const dom = fs.readFileSync(out, 'utf8');
  const a = dom.indexOf('@@'), b = dom.indexOf('@@', a + 2);
  return a < 0 ? null : dom.slice(a + 2, b);
}

console.log('--- 量取页面高度 ---');
const info = probeHeight();
console.log(info || '(探针未触发)');
if (!info) process.exit(1);

const m = info.match(/SCROLL_H=(\d+)/);
if (!m) { console.log('未取到高度'); process.exit(1); }
const contentH = parseInt(m[1], 10);

// 先试一次基准截图，用来标定窗口高度与实际画布高度的差值
const probePng = path.join(DIR, '_cal.png');
runChrome([
  '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--force-device-scale-factor=1', `--window-size=${WIDTH},900`, '--hide-scrollbars',
  '--user-data-dir=' + path.join(DIR, '_cdp_shot'),
  '--virtual-time-budget=7000', '--screenshot=' + probePng,
  'file:///' + SHOT.replace(/\\/g, '/')
]);
const cal = pngSize(probePng);
console.log('基准截图尺寸:', cal.w + 'x' + cal.h, '（窗口高 900）');
const overhead = 900 - cal.h;
console.log('窗口高与画布高差值:', overhead);

// 按内容高度反推窗口高度，再截一次
const winH = contentH + overhead;
console.log('目标内容高度:', contentH, '→ 窗口高度:', winH);

runChrome([
  '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--force-device-scale-factor=1', `--window-size=${WIDTH},${winH}`, '--hide-scrollbars',
  '--user-data-dir=' + path.join(DIR, '_cdp_shot'),
  '--virtual-time-budget=7000', '--screenshot=' + OUT_PNG,
  'file:///' + SHOT.replace(/\\/g, '/')
]);

if (fs.existsSync(OUT_PNG)) {
  const s = pngSize(OUT_PNG);
  console.log('\n长图已生成:', path.basename(OUT_PNG));
  console.log('尺寸:', s.w + 'x' + s.h, '大小:', (s.bytes / 1024).toFixed(0) + ' KB');
  console.log('与内容高度差:', s.h - contentH, 'px');
} else {
  console.log('截图未生成');
}

try { fs.rmSync(probePng, { force: true }); } catch (e) {}
try { fs.rmSync(path.join(DIR, '_cdp_shot'), { recursive: true, force: true }); } catch (e) {}
