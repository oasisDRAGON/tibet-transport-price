// 生成长图专用的页面副本 + 高度探针
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'index.html');
let h = fs.readFileSync(src, 'utf8');

// 1) 不联网加载腾讯地图，直接走 SVG 走廊图（长图里必须是确定的内容）
const before = h.length;
h = h.replace(/<script src="https:\/\/map\.qq\.com[^"]*"[^>]*><\/script>/,
              '<script>window.__TMAP_FAILED=true;<\/script>');
console.log('TMap 已移除:', h.indexOf('map.qq.com') < 0);

// 2) 静态长图里没有交互，把「下次刷新」倒计时换成固定说明，避免出现无意义的秒数
h = h.replace('<span>下次刷新</span>', '<span>刷新频率</span>');
h = h.replace(/<b id="countdown">—<\/b>/, '<b id="countdown">每 30 秒自动刷新</b>');

// 3) 保留「数据源设置」按钮：底部数据说明里提到了它，删掉会前后不一致

// 4) 探针：量出真实内容高度 + 冻结动态内容，供精确截图使用
const probe = `
<pre id="PROBE" style="position:fixed;left:-9999px;top:0"></pre>
<script>
document.addEventListener('DOMContentLoaded', function(){
  // 静态长图里必须冻结一切动态：清掉倒计时与自动刷新，
  // 否则「刷新频率」会显示成无意义的剩余秒数，且两次截图价格不一致。
  for (var i = 1; i < 100000; i++) { try { clearInterval(i); } catch (e) {} }
  var cd = document.getElementById('countdown');
  if (cd) cd.textContent = '每 30 秒自动刷新';

  var d = document.documentElement, cw = d.clientWidth;
  var wide = [];
  Array.prototype.forEach.call(document.querySelectorAll('body *'), function(el){
    if (el.closest('.tblwrap')) return;              // 表格容器可横向滚动，属预期
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > cw + 1) wide.push(el.tagName + '.' + String(el.className || '').slice(0, 24));
  });
  var tbl = document.querySelector('.tblwrap');
  var mapSvg = document.querySelector('#mapFallback svg');
  var s = [
    'VIEWPORT=' + cw,
    'SCROLL_H=' + d.scrollHeight,
    'H_OVERFLOW=' + (d.scrollWidth > cw + 1 ? 'YES' : 'NO'),
    'CARDS=' + document.querySelectorAll('#cards .card').length,
    'KPIS=' + document.querySelectorAll('#kpis .kpi').length,
    'ROWS=' + document.querySelectorAll('#tbody tr').length,
    'POLY=' + document.querySelectorAll('#dateChart polyline').length,
    'SLOTS=' + document.querySelectorAll('#cards .slot-line').length,
    'NA=' + document.querySelectorAll('#cards .card.na').length,
    'TIPS=' + document.querySelectorAll('#tips .tip').length,
    'MAP_SVG=' + !!mapSvg,
    'MAP_VIEWBOX=' + (mapSvg ? mapSvg.getAttribute('viewBox') : 'na'),
    'MAP_FONTSIZE=' + (mapSvg ? (mapSvg.querySelector('text') || {}).getAttribute && mapSvg.querySelector('text').getAttribute('font-size') : 'na'),
    'MAP_LABELS=' + (mapSvg ? mapSvg.querySelectorAll('text').length : 0),
    'TBL_CLIP=' + (tbl ? (tbl.scrollWidth - tbl.clientWidth) : 'na'),
    'COUNTDOWN=' + (cd ? cd.textContent : 'na'),
    'WIDE=' + wide.slice(0, 5).join(' | ')
  ];
  var payload = s.join('\\n');
  document.getElementById('PROBE').textContent = '@@' + payload + '@@';
  try { parent.postMessage(payload, '*'); } catch (e) {}
});
<\/script>
`;

h = h.replace('</body>', probe + '</body>');
fs.writeFileSync(path.join(__dirname, '_shot.html'), h);
console.log('长图副本已生成 _shot.html');
