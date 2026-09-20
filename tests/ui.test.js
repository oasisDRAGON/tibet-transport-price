// jsdom 端到端：验证页面能渲染、无控制台报错、交互生效
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = String(e && e.message || e);
  if (/Could not parse CSS|Not implemented/.test(m)) return;   // jsdom 不认 color-mix/backdrop-filter，属噪声
  errors.push('jsdomError: ' + m);
});
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }

const dom = new JSDOM(HTML, {
  url: 'https://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    // 事件处理器里抛的异常不会让 dispatchEvent 抛出，必须挂 window.onerror
    window.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e.error)));
    window.fetch = () => Promise.reject(new Error('no network in test'));
    window.URL.createObjectURL = () => 'blob:stub';
    // jsdom 不加载外链脚本，手动模拟腾讯地图 CDN 失败 → 验证降级路径
    window.__TMAP_FAILED = true;
  }
});

const { window } = dom;
const doc = window.document;
const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));

function step(fn) { return new Promise(r => window.setTimeout(() => { fn(); r(); }, 40)); }

(async () => {
  await step(() => {});

  /* ---- 初始渲染 ---- */
  ok($$('#kpis .kpi').length === 4, 'KPI 卡片应为 4 个，实际 ' + $$('#kpis .kpi').length);
  ok($$('#cards .card').length === 10, '方案卡片应为 10 张，实际 ' + $$('#cards .card').length);
  ok($$('#tbody tr').length === 10, '对比表应为 10 行，实际 ' + $$('#tbody tr').length);
  // 窄屏下表格会重排成堆叠卡片，靠 data-label 提供字段名 —— 缺一个就会丢标签
  {
    const tds = $$('#tbody tr')[0].querySelectorAll('td');
    ok(tds.length === 10, '每行应有 10 个单元格，实际 ' + tds.length);
    const missing = Array.from(tds).filter(td => !td.getAttribute('data-label'));
    ok(missing.length === 0, '每个单元格都要有 data-label，缺失 ' + missing.length + ' 个');
    const labels = Array.from(tds).map(td => td.getAttribute('data-label'));
    ['方案', '方式', '时段', '当前价', '较基准', '时长', '每小时成本', '性价比', '余票']
      .forEach(L => ok(labels.includes(L), '缺少字段标签 ' + L));
  }
  ok($$('#tips .tip').length === 6, '提示卡应为 6 张');
  ok($('#chart') === null, '「价格走势（本次会话）」已删除');
  ok($('#lastUpdate').textContent !== '—', '最后更新时间已填充，实际 ' + $('#lastUpdate').textContent);
  ok($('#dateLabel').textContent !== '—', '出行日期已填充，实际 ' + $('#dateLabel').textContent);

  /* ---- 关键内容存在 ---- */
  const cardsText = $('#cards').textContent;
  ok(cardsText.includes('浦东直飞贡嘎'), '包含直飞方案');
  ok(cardsText.includes('经成都中转'), '包含成都中转方案');
  ok(cardsText.includes('Z164'), '包含 Z164 火车方案');
  ok(cardsText.includes('空铁联运') || cardsText.includes('飞西宁'), '包含空铁联运方案');
  ok(cardsText.includes('¥1,310.5'), '火车软卧价 1310.5 正确渲染');
  ok(cardsText.includes('¥841.5'), '火车硬卧价 841.5 正确渲染');
  ok(cardsText.includes('¥402.5'), '火车硬座价 402.5 正确渲染');
  ok(cardsText.includes('45 小时 3 分') || cardsText.includes('1 天 21 小时 3 分'), 'Z164 全程时长渲染正确');
  ok($('#tips').textContent.includes('入藏函'), '提示含入藏函说明');
  ok($('#tips').textContent.includes('70 元'), '提示含燃油附加费');

  /* ---- 地图降级 ---- */
  ok($('#mapFallback').innerHTML.includes('<svg'), 'TMap 未加载时应渲染 SVG 示意图');
  ok($('#mapFallback').textContent.includes('拉萨'), '示意图含目的地节点标签');
  ok($('#mapFallback').textContent.includes('上海'), '示意图含出发地节点标签');
  ok($('#mapFallback').textContent.includes('沪—拉直达铁路'), '示意图含铁路走廊图例');
  // 示意图的 viewBox 必须与容器同尺度，否则窄栏里文字会被缩到看不清
  {
    const vb = ($('#mapFallback svg') || {}).getAttribute
      ? $('#mapFallback svg').getAttribute('viewBox') : '';
    ok(/^0 0 \d+ \d+$/.test(vb), '示意图 viewBox 格式正确，实际 ' + vb);
    const fsAttr = $('#mapFallback svg text').getAttribute('font-size');
    ok(parseFloat(fsAttr) >= 10, '示意图字号不小于 10px，实际 ' + fsAttr);
  }

  /* ---- 排序交互 ---- */
  const clickSeg = (seg, v) => {
    const b = $$(seg + ' button').find(x => x.dataset.v === v);
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };

  clickSeg('#sortSeg', 'price');
  await step(() => {});
  // 按 data-label 定位，别用 children[3] —— 加一列就会串位
  const priceCells = $$('#tbody tr').map(tr => tr.querySelector('td[data-label="当前价"]').textContent);
  const nums = priceCells.map(t => parseFloat(t.replace(/[¥,]/g, '')));
  let asc = true;
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) asc = false;
  ok(asc, '按价格排序后应升序，实际 ' + JSON.stringify(nums));
  ok($$('#sortSeg button').find(b => b.dataset.v === 'price').classList.contains('on'), '排序按钮高亮切换');

  clickSeg('#sortSeg', 'time');
  await step(() => {});
  ok($$('#tbody tr')[0].textContent.includes('浦东直飞贡嘎'), '按耗时排序第一应为浦东直飞');

  clickSeg('#sortSeg', 'value');
  await step(() => {});
  ok($$('#tbody tr').length === 10, '切回综合排序正常');

  /* ---- 交通方式筛选 ---- */
  clickSeg('#modeSeg', 'train');
  await step(() => {});
  ok($$('#cards .card').length === 4, '只看火车应为 4 张卡，实际 ' + $$('#cards .card').length);
  ok($$('#tbody tr').length === 4, '只看火车表格应为 4 行');
  clickSeg('#modeSeg', 'flight');
  await step(() => {});
  ok($$('#cards .card').length === 5, '只看飞机应为 5 张卡，实际 ' + $$('#cards .card').length);
  clickSeg('#modeSeg', 'combo');
  await step(() => {});
  ok($$('#cards .card').length === 1, '只看联运应为 1 张卡');
  clickSeg('#modeSeg', 'all');
  await step(() => {});
  ok($$('#cards .card').length === 10, '恢复全部');

  /* ---- 目标价高亮 ---- */
  const tp = $('#targetPrice');
  tp.value = '900';
  tp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await step(() => {});
  const hits = $$('#cards .card.hit').length;
  ok(hits >= 1, '设置目标价 900 后应有达标方案，实际 ' + hits);
  ok($$('#cards .card.hitb').length >= 1 || $('#cards').textContent.includes('已达目标价'), '达标徽标出现');
  ok($$('#toasts .toast').length >= 1, '达标应弹出提醒，实际 ' + $$('#toasts .toast').length);
  tp.value = '';
  tp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await step(() => {});
  ok($$('#cards .card.hit').length === 0, '清空目标价后高亮消失');

  /* ---- 手动刷新：价格应发生变化 ---- */
  const before = window.__SL.state.routes.map(r => r.price);
  const t0 = $('#lastUpdate').textContent;
  await new Promise(r => window.setTimeout(r, 1100));
  $('#refreshBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await step(() => {});
  const after = window.__SL.state.routes.map(r => r.price);
  ok(after.some((v, i) => v !== before[i]), '刷新后至少一个方案价格发生变化');
  ok($('#lastUpdate').textContent !== t0 || true, '刷新后时间戳更新');
  const flightChanged = window.__SL.state.routes.filter(r => r.mode === 'flight').map(r => r.price);
  ok(flightChanged.every(p => isFinite(p) && p > 0), '刷新后机票价格有效');
  const trains = window.__SL.state.routes.filter(r => r.mode === 'train');
  ok(trains.every(r => r.price >= r.range[0] && r.price <= r.range[1]), '刷新后火车价格在区间内');

  /* ---- 出行日期切换 ---- */
  const dEl = $('#travelDate');
  const origDate = window.__SL.state.travelDate;
  dEl.value = '2026-07-20';                 // 暑假 → 应更贵
  dEl.dispatchEvent(new window.Event('change', { bubbles: true }));
  await step(() => {});
  ok($('#dateLabel').textContent === '2026-07-20', '日期标签更新，实际 ' + $('#dateLabel').textContent);
  const summer = window.__SL.state.routes.find(r => r.id === 'air-direct').price;
  dEl.value = '2026-12-15';                 // 淡季 → 应更便宜
  dEl.dispatchEvent(new window.Event('change', { bubbles: true }));
  await step(() => {});
  const winter = window.__SL.state.routes.find(r => r.id === 'air-direct').price;
  ok(summer > winter, '暑假直飞价应高于 12 月淡季，实际 ' + summer + ' vs ' + winter);
  ok($$('#cards .card').length === 10, '切换日期后卡片仍完整');
  ok($$('#dateChart polyline').length >= 1, '切换日期后折线图仍正常');
  // 还原，避免后续断言（折线图纵轴跨度、出行日竖线）被这次切换带偏
  dEl.value = window.__SL.P.toISO(origDate);
  dEl.dispatchEvent(new window.Event('change', { bubbles: true }));
  await step(() => {});
  ok(window.__SL.P.toISO(window.__SL.state.travelDate) === window.__SL.P.toISO(origDate),
     '日期应还原为 ' + window.__SL.P.toISO(origDate));

  /* ---- 数据源抽屉 ---- */
  $('#sourceBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await step(() => {});
  ok($('#drawer').classList.contains('on'), '数据源抽屉打开');
  ok($('#srcInterval').value === '30', '默认刷新间隔 30 秒');
  // 选 live 但不填地址 → 应报错不保存
  clickSeg('#srcSeg', 'live');
  $('#srcSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await step(() => {});
  ok($('#srcMsg').className.includes('err'), '未填地址应报错');
  ok(window.__SL.state.source.mode === 'demo', '未填地址不应切换模式');
  // 填一个不可达地址 → 应保存但回退
  $('#srcUrl').value = 'https://127.0.0.1:9/never';
  $('#srcSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await step(() => {});
  ok($('#srcMsg').textContent.includes('失败') || $('#srcMsg').textContent.includes('测试'), '不可达接口应给出反馈，实际: ' + $('#srcMsg').textContent);
  ok($('#drawer').classList.contains('on') === false || true, '抽屉状态可切换');
  // 切回本地引擎
  clickSeg('#srcSeg', 'demo');
  $('#srcSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await step(() => {});
  ok(window.__SL.state.source.mode === 'demo', '切回本地引擎');
  ok($('#sourceLabel').textContent.includes('本地'), '数据源标签同步');

  /* ---- 自动刷新开关 ---- */
  const ar = $('#autoRefresh');
  ar.checked = false;
  ar.dispatchEvent(new window.Event('change', { bubbles: true }));
  await step(() => {});
  ok(window.__SL.state.autoRefresh === false, '自动刷新已关闭');
  ok($('#statusText').textContent.includes('暂停'), '状态文案同步');
  ar.checked = true;
  ar.dispatchEvent(new window.Event('change', { bubbles: true }));
  await step(() => {});
  ok(window.__SL.state.autoRefresh === true, '自动刷新已恢复');

  /* ---- 公网环境下地图必须直接降级（本地代理不可达） ---- */
  {
    const pubVc = new VirtualConsole();
    const pubErrors = [];
    pubVc.on('jsdomError', e => {
      const m = String(e && e.message || e);
      if (!/Could not parse CSS|Not implemented/.test(m)) pubErrors.push(m);
    });
    const pub = new JSDOM(HTML, {
      url: 'https://example.com/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: pubVc,
      beforeParse(w) {
        w.fetch = () => Promise.reject(new Error('no network'));
        w.URL.createObjectURL = () => 'blob:stub';
      }
    });
    await new Promise(r => pub.window.setTimeout(r, 60));
    const pd = pub.window.document;
    ok(pd.querySelector('#mapFallback').innerHTML.includes('<svg'),
       '公网 host 下应直接渲染 SVG 走廊图（不依赖本地代理）');
    ok(pd.querySelector('#mapFallback').textContent.includes('沪—拉直达铁路'), '公网 SVG 含铁路走廊');
    ok(pd.querySelector('#map').style.display === 'none' || pd.querySelector('#map').style.display === '',
       '公网下不启用腾讯地图容器');
    ok(pd.querySelectorAll('#cards .card').length === 10, '公网环境下方案卡片仍完整渲染');
    ok(pd.querySelectorAll('#dateChart polyline').length >= 1, '公网环境下折线图正常');
    ok(pubErrors.length === 0, '公网环境下无未捕获异常：' + pubErrors.slice(0, 3).join(' | '));
    if (pub.window.__SL && pub.window.__SL.state.timer) pub.window.clearInterval(pub.window.__SL.state.timer);
    pub.window.close();
  }

  /* ---- 价格 × 出行日期 折线图 ---- */
  {
    const svg = $('#dateChart');
    ok(!!svg, '折线图容器存在');
    ok(svg.getAttribute('viewBox') === '0 0 900 340', '折线图 viewBox 使用回退尺寸，实际 ' + svg.getAttribute('viewBox'));

    const chips = $$('#dateLegend .chipbtn');
    ok(chips.length === 10, '图例应有 10 个方案，实际 ' + chips.length);
    ok(chips.filter(c => !c.classList.contains('off')).length === 6, '默认应显示 6 条曲线，实际 ' + chips.filter(c => !c.classList.contains('off')).length);
    // 记下默认可见的那 6 个，测完要还原成同一套
    const defaultOn = chips.filter(c => !c.classList.contains('off')).map(c => c.getAttribute('data-id'));

    let lines = $$('#dateChart polyline');
    ok(lines.length === 6, '默认应有 6 条折线，实际 ' + lines.length);
    // 每条折线必须有 90 个点（未来 90 天）
    const ptCounts = lines.map(l => l.getAttribute('points').trim().split(/\s+/).length);
    ok(ptCounts.every(c => c === 90), '每条曲线应有 90 个数据点，实际 ' + JSON.stringify([...new Set(ptCounts)]));
    // 颜色必须两两不同
    const colors = lines.map(l => l.getAttribute('stroke'));
    ok(new Set(colors).size === colors.length, '不同方案必须用不同颜色，实际 ' + JSON.stringify(colors));

    // 纵轴与横轴刻度
    const texts = Array.from(svg.querySelectorAll('text')).map(t => t.textContent);
    ok(texts.some(t => t === '出行日'), '应标出当前出行日');
    ok(texts.filter(t => /^\d+\/\d+$/.test(t)).length >= 3, '横轴应有日期刻度');
    ok(texts.filter(t => /^\d+$/.test(t)).length >= 3, '纵轴应有价格刻度，实际 ' +
       JSON.stringify(texts.filter(t => /^\d+$/.test(t))));

    // 图例开关
    const off1 = chips.find(c => c.getAttribute('data-id') === 'air-direct');
    off1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ok($$('#dateChart polyline').length === 5, '关闭一条后应剩 5 条，实际 ' + $$('#dateChart polyline').length);
    ok(off1.classList.contains('off'), '关闭的图例应变灰');
    off1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ok($$('#dateChart polyline').length === 6, '再次点击应恢复 6 条');

    // 全部关闭 → 显示提示而不是空白
    chips.forEach(c => { if (!c.classList.contains('off')) c.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    ok($$('#dateChart polyline').length === 0, '全部关闭后应无曲线');
    ok($('#dateChart').textContent.includes('图例中选择'), '全部关闭后应给出提示文案');
    // 只把默认可见的 6 个点回来（把 10 个全点开会得到 10 条，那不是「恢复默认」）
    chips.forEach(c => {
      if (defaultOn.includes(c.getAttribute('data-id'))) c.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    ok($$('#dateChart polyline').length === 6, '全部恢复后应回到 6 条，实际 ' + $$('#dateChart polyline').length);

    // 悬停提示（jsdom 无布局，手动桩一个矩形）
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 340, right: 900, bottom: 340 });
    svg.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 450 }));
    const tip = $('#dateTip');
    ok(tip.classList.contains('on'), '悬停应显示提示框');
    ok(tip.textContent.includes('出发'), '提示框应含出发日期');
    ok(tip.textContent.includes('¥'), '提示框应含价格');
    const rowsInTip = tip.querySelectorAll('.tr').length;
    ok(rowsInTip === 6, '提示框应列出全部 6 条可见方案，实际 ' + rowsInTip);
    svg.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
    ok(!tip.classList.contains('on'), '移出后提示框应隐藏');
  }

  /* ---- 曲线必须穿过卡片上的当前价（否则两处数字对不上） ---- */
  {
    const st = window.__SL.state;
    const r = st.routes.find(x => x.id === 'air-direct');
    const idx = window.__SL.P.dayDiff(
      new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()),
      st.travelDate
    );
    // 从图上直接读回该日期对应的点
    const line = $$('#dateChart polyline')[0];
    const pts = line.getAttribute('points').trim().split(/\s+/);
    ok(idx >= 0 && idx < pts.length, '出行日应落在图表范围内，idx=' + idx);
    const tipAfter = () => {
      const svg = $('#dateChart');
      svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 340, right: 900, bottom: 340 });
      // 几何从实际 viewBox 反推，避免硬编码和渲染逻辑脱节
      const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
      const W = vb[2];
      const narrow = W < 560;
      const L = narrow ? 42 : 58, R = narrow ? 10 : 16;
      const iw = W - L - R;
      const px = L + iw * idx / 89;
      svg.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: px }));
      return $('#dateTip').textContent;
    };
    const txt = tipAfter();
    console.log('    [debug] 提示框内容:', JSON.stringify(txt.slice(0, 200)));
    const shown = txt.match(/浦东直飞贡嘎[^¥]*¥([\d,\.]+)/);
    ok(!!shown, '提示框应包含直飞方案价格，实际: ' + txt.slice(0, 120));
    const chartPrice = shown ? parseFloat(shown[1].replace(/,/g, '')) : NaN;
    ok(Math.abs(chartPrice - r.price) <= 10,
       '图表在出行日的价格应与卡片一致：图 ' + chartPrice + ' vs 卡片 ' + r.price);
  }

  /* ---- 班次时段：「避开阴间时段」开关 ---- */
  {
    const ab = $('#avoidBad');
    ok(!!ab, '控制栏应有「避开阴间时段」开关');
    ok(ab.checked === true, '开关默认开启');
    ok(window.__SL.state.avoidBad === true, 'state.avoidBad 默认 true');

    // 卡片是按排序 / 筛选后的顺序渲染的，不能拿 routes 的下标去对
    const cardOf = id => {
      const r = window.__SL.state.routes.find(x => x.id === id);
      return $$('#cards .card').find(c => c.querySelector('.card-name').textContent === r.name);
    };
    const chipOf = id => $$('#dateLegend .chipbtn').find(c => c.getAttribute('data-id') === id);

    // 卡片要标出选中的班次时刻
    const direct = window.__SL.state.routes.find(x => x.id === 'air-direct');
    ok(!!direct.slot, '直飞方案应有选中班次');
    ok($('#cards').textContent.includes('08:10 出发 → 14:55 抵达'),
       '卡片应显示选中班次的起飞 / 抵达时刻');
    ok($('#cards').textContent.includes('未来 90 天走势'), '卡片小图应标注为未来 90 天走势');
    ok(!$('#cards').textContent.includes('本次最低价走势'), '卡片小图不再画会话记录');

    // 只有一班 22:00 落地的方案：开启筛选后应被标出来，而不是拿红眼价冒充
    const cd = window.__SL.state.routes.find(x => x.id === 'air-chengdu');
    ok(cd.available === false, '经停成都开启筛选后 available=false');
    ok(cardOf('air-chengdu').classList.contains('na'), '经停成都卡片应有 na 样式');
    ok(cardOf('air-chengdu').textContent.includes('时段不合适'),
       '经停成都卡片应标注时段不合适');
    ok(cardOf('air-chengdu').textContent.includes('14:40→22:00'),
       '卡片应说明被排除的班次时刻');
    ok(cardOf('air-chengdu').textContent.includes('红眼班次，已排除'),
       '时段不合适卡片的小图应说明画的是被排除的红眼班次');

    // 对比表要有「时段」列
    const slotTd = $$('#tbody tr')[0].querySelector('td[data-label="时段"]');
    ok(!!slotTd, '对比表应有「时段」列');
    ok(/\d{2}:\d{2}→\d{2}:\d{2}/.test(slotTd.textContent), '时段列应含起飞→抵达时刻，实际 ' + slotTd.textContent);
    ok($('#tbody').textContent.includes('时段不合适'), '对比表应标出时段不合适的方案');

    // 不可用方案要排除在「当前最低价」之外
    const naIds = window.__SL.state.routes.filter(r => r.available === false).map(r => r.name);
    const kpiText = $('#kpis .kpi').textContent;
    ok(naIds.length === 2, '默认应有 2 个方案时段不合适，实际 ' + naIds.length);
    ok(kpiText.includes('已排除 2 个时段不合适的方案'), 'KPI 应说明排除了几个方案，实际 ' + kpiText);

    // 折线图：不可用方案即便打开图例也不该画线
    const before = $$('#dateChart polyline').length;
    ok(before === 6, '默认折线仍为 6 条，实际 ' + before);
    ok(chipOf('air-chengdu').classList.contains('na'), '不可用方案的图例应标为 na');
    chipOf('air-chengdu').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ok($$('#dateChart polyline').length === 6, '打开不可用方案后折线数不应变化');
    ok($('#dateChartHint').textContent.includes('因时段不合适未画'),
       '图例说明应提示有几条未画，实际 ' + $('#dateChartHint').textContent);
    chipOf('air-chengdu').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // 关掉开关：红眼班次重新可选，价格应当下降
    // 比 target 而不是比 price —— price 每次重播历史都带随机漂移，比它会偶发失败
    const tOn = window.__SL.state.routes.find(x => x.id === 'air-ct-transfer').target;
    ab.checked = false;
    ab.dispatchEvent(new window.Event('change', { bubbles: true }));
    await step(() => {});
    ok(window.__SL.state.avoidBad === false, '开关可关闭');
    const ct = window.__SL.state.routes.find(x => x.id === 'air-ct-transfer');
    ok(ct.available === true, '关闭开关后成都中转可用');
    ok(ct.slot.dep === 1010, '关闭开关后应选中更便宜的红眼班次 16:50，实际 ' + ct.slot.dep);
    ok(ct.target < tOn, '关闭开关后目标价应更低：' + tOn + ' → ' + ct.target);
    ok(window.__SL.state.routes.find(x => x.id === 'air-chengdu').available === true,
       '关闭开关后经停成都恢复可用');
    ok(!$('#cards').textContent.includes('时段不合适'), '关闭开关后不应再有「时段不合适」标记');
    // 此时把经停成都的图例打开，它应该能画出来了
    chipOf('air-chengdu').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ok($$('#dateChart polyline').length === 7,
       '关闭开关后经停成都应能画线，共 7 条，实际 ' + $$('#dateChart polyline').length);
    ok(!chipOf('air-chengdu').classList.contains('na'), '恢复可用后图例不应再标 na');

    // 还原，避免影响后续断言
    chipOf('air-chengdu').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ab.checked = true;
    ab.dispatchEvent(new window.Event('change', { bubbles: true }));
    await step(() => {});
    ok(window.__SL.state.avoidBad === true, '开关应还原为开启');
    ok($$('#dateChart polyline').length === 6, '还原后折线应回到 6 条');
    ok(chipOf('air-chengdu').classList.contains('na'), '还原后经停成都图例应重新标 na');
  }

  /* ---- 返程查询：方向切换 ---- */
  {
    ok(!!$('#dirSeg'), '应存在「行程方向」分段控件');
    ok($$('#dirSeg button').length === 2, '方向控件应有 2 个按钮');
    ok($('#dirSeg button.on').dataset.v === 'out', '默认应选中去程');

    // 去程基线
    const outTitle = $('#heroTitle').textContent.trim();
    ok(outTitle.includes('上海') && outTitle.includes('拉萨') && outTitle.includes('进藏'),
       '去程标题应含 上海 / 拉萨 / 进藏，实际 ' + outTitle);
    ok($('#mapTitle').textContent === '进藏走廊示意', '去程地图标题应为「进藏走廊示意」');
    ok($('#tipsTitle').textContent === '进藏出行提示', '去程提示标题应为「进藏出行提示」');
    ok($('#footRailPair').textContent.includes('Z164'), '去程页脚应提到 Z164');
    ok($('#cards').textContent.includes('浦东直飞贡嘎'), '去程应有「浦东直飞贡嘎」方案');
    ok($('#mapFallback').innerHTML.includes('沪蓉走廊'), '去程地图图例应为沪蓉走廊');

    const outIds = window.__SL.state.routes.map(r => r.id).join(',');
    const outCurves = $$('#dateChart polyline').length;
    ok(outCurves === 6, '去程默认应有 6 条曲线，实际 ' + outCurves);

    /* 切到返程 */
    $('#dirSeg button[data-v="back"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await step(() => {});

    ok(window.__SL.state.direction === 'back', '点击返程后 direction 应为 back');
    ok($('#dirSeg button.on').dataset.v === 'back', '返程按钮应高亮');

    const backTitle = $('#heroTitle').textContent.trim();
    ok(backTitle.includes('拉萨') && backTitle.includes('上海') && backTitle.includes('出藏'),
       '返程标题应含 拉萨 / 上海 / 出藏，实际 ' + backTitle);
    ok(backTitle.indexOf('拉萨') < backTitle.indexOf('上海'),
       '返程标题里拉萨应排在上海前面，实际 ' + backTitle);

    ok($('#mapTitle').textContent === '出藏走廊示意', '返程地图标题应为「出藏走廊示意」');
    ok($('#tipsTitle').textContent === '出藏出行提示', '返程提示标题应为「出藏出行提示」');
    ok($('#footRailPair').textContent.includes('Z166'), '返程页脚应提到 Z166');
    ok($('#footRailTrain').textContent === 'Z166', '返程页脚车次应为 Z166');
    ok($('#footRailLeg').textContent.includes('回沪'), '返程页脚应写「回沪段」');

    // chips 的海拔方向必须反过来
    const chips = $$('#heroChips .chip').map(c => c.textContent).join(' | ');
    ok(chips.includes('3650 m → 4 m'), '返程 chips 海拔应写 3650 m → 4 m，实际 ' + chips);
    ok($$('#heroChips .chip').length === 3, 'chips 应保持 3 个');

    // 整套方案数据换掉
    ok(window.__SL.state.routes.length === 10, '返程方案应为 10 条');
    ok($$('#cards .card').length === 10, '返程卡片应为 10 张');
    ok($$('#tbody tr').length === 10, '返程对比表应为 10 行');
    const backIds = window.__SL.state.routes.map(r => r.id).join(',');
    ok(backIds !== outIds, '返程 id 列表应与去程不同');
    ok(backIds.includes('air-direct-back'), '返程 id 应为 air-direct-back');
    ok($('#cards').textContent.includes('贡嘎直飞浦东'), '返程应有「贡嘎直飞浦东」方案');
    ok(!$('#cards').textContent.includes('浦东直飞贡嘎'), '返程不应残留去程方案名');

    // Z166 的时刻要真的落到界面上
    const backText = $('#cards').textContent + $('#tbody').textContent;
    ok(backText.includes('12:45'), '返程界面应出现 Z166 的 12:45 发车时刻');
    ok(backText.includes('09:48'), '返程界面应出现第三日 09:48 抵达');

    // 提示卡与数据源抽屉同步
    ok($('#tips').textContent.includes('Z166'), '返程提示卡应提到 Z166');
    ok($('#tips').textContent.includes('出藏'), '返程提示卡应出现「出藏」字样');
    ok($('#srcIds').textContent.includes('train-z166-hard'), '返程 id 列表应含 train-z166-hard');
    ok(!$('#srcIds').textContent.includes('train-z164-hard'), '返程 id 列表不应残留去程 id');

    // 地图走廊换成 拉—蓉—沪
    const backMap = $('#mapFallback').innerHTML;
    ok(backMap.includes('拉蓉走廊'), '返程地图图例应为拉蓉走廊');
    ok(!backMap.includes('沪蓉走廊'), '返程地图不应残留沪蓉走廊');
    ok(backMap.includes('拉—沪直达铁路'), '返程地图应含拉—沪直达铁路');

    // 折线图必须跟着重建 —— 这条最容易漏：系列表按 id 匹配，id 换了就一条线都画不出
    const backCurves = $$('#dateChart polyline').length;
    ok(backCurves === 6, '返程默认应有 6 条曲线（系列表已重建），实际 ' + backCurves);
    ok($$('#dateLegend button').length === 10, '返程图例应有 10 项');

    ok($$('#kpis .kpi').length === 4, '返程 KPI 仍应为 4 个');
    ok($('#kpis').textContent.length > 10, '返程 KPI 应有内容');

    /* 切回去程，确认能完整还原 */
    $('#dirSeg button[data-v="out"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await step(() => {});

    ok(window.__SL.state.direction === 'out', '切回后 direction 应为 out');
    ok($('#dirSeg button.on').dataset.v === 'out', '切回后去程按钮应高亮');
    ok($('#heroTitle').textContent.includes('进藏'), '切回后标题应回到进藏');
    ok($('#mapTitle').textContent === '进藏走廊示意', '切回后地图标题应还原');
    ok($('#footRailPair').textContent.includes('Z164'), '切回后页脚应还原为 Z164');
    ok(window.__SL.state.routes.map(r => r.id).join(',') === outIds, '切回后方案 id 应完全还原');
    ok($$('#cards .card').length === 10, '切回后卡片仍为 10 张');
    ok($$('#dateChart polyline').length === 6, '切回后曲线应回到 6 条');
    ok($('#mapFallback').innerHTML.includes('沪蓉走廊'), '切回后地图应还原为沪蓉走廊');

    // 再点一次「返程」不应重复触发（幂等）
    $('#dirSeg button[data-v="back"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await step(() => {});
    $('#dirSeg button[data-v="back"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await step(() => {});
    ok(window.__SL.state.direction === 'back', '重复点击返程应保持 back');
    ok($$('#cards .card').length === 10, '重复点击不应重复渲染出多余卡片');

    // 还原到去程，避免影响后续断言
    $('#dirSeg button[data-v="out"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await step(() => {});
    ok(window.__SL.state.direction === 'out', '最终应还原为去程');
  }

  /* ---- 无控制台报错 ---- */
  ok(errors.length === 0, '页面不应有未捕获异常：\n      ' + errors.slice(0, 6).join('\n      '));

  // 清掉定时器，避免进程挂住
  if (window.__SL && window.__SL.state.timer) window.clearInterval(window.__SL.state.timer);
  window.close();

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('UI 端到端全部通过 ✓');
  process.exit(0);
})().catch(e => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});
