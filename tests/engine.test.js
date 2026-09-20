// 从 HTML 中抽出 PARSER 块，对价格引擎做单元测试
const fs = require('fs');
const path = require('path');
const HTML = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

// 用索引定位，避免非贪婪正则被分节注释提前截断
const a = html.indexOf('PARSER_START');
const b = html.indexOf('PARSER_END');
if (a < 0 || b < 0) { console.error('未找到 PARSER 标记'); process.exit(1); }
const startCut = html.indexOf('*/', a) + 2;
const endCut = html.lastIndexOf('/*', b);
const code = html.slice(startCut, endCut);
fs.writeFileSync(path.join(__dirname, '_extracted.js'), code);
const P = require('./_extracted.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function near(x, y, eps, msg) { ok(Math.abs(x - y) <= eps, msg + ` (got ${x}, want ${y}±${eps})`); }
// 确定性伪随机，便于复现
function mkRnd(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ---------- 1. 数据完整性 ---------- */
ok(Array.isArray(P.ROUTES) && P.ROUTES.length === 10, '方案数应为 10，实际 ' + P.ROUTES.length);
const ids = new Set();
P.ROUTES.forEach(r => {
  ok(!ids.has(r.id), 'id 重复: ' + r.id); ids.add(r.id);
  ok(typeof r.basePrice === 'number' && r.basePrice > 0, r.id + ' basePrice 非法');
  ok(Array.isArray(r.range) && r.range.length === 2 && r.range[0] <= r.basePrice && r.basePrice <= r.range[1],
     r.id + ' 基准价不在区间内');
  ok(typeof r.durationMin === 'number' && r.durationMin > 0, r.id + ' 时长非法');
  ok(['flight', 'train', 'combo'].includes(r.mode), r.id + ' mode 非法');
  ok(Array.isArray(r.pros) && r.pros.length > 0, r.id + ' 缺少优势');
  ok(Array.isArray(r.cons) && r.cons.length > 0, r.id + ' 缺少注意项');
});
// 火车票价必须与 12306 公布全价一致
const t = id => P.ROUTES.find(r => r.id === id);
ok(t('train-z164-seat').basePrice === 402.5, 'Z164 硬座应为 402.5');
ok(t('train-z164-hard').basePrice === 841.5, 'Z164 硬卧下应为 841.5');
ok(t('train-z164-soft').basePrice === 1310.5, 'Z164 软卧下应为 1310.5');
ok(t('train-transfer').basePrice === 985.5, '上海-西宁-拉萨硬卧下应为 985.5 (464.5+521)');
ok(t('train-z164-hard').durationMin === 2703, 'Z164 全程应为 2703 分钟 (45h03m)');

/* ---------- 2. 日期工具 ---------- */
ok(P.toISO(new Date(2026, 8, 19)) === '2026-09-19', 'toISO 补零');
ok(P.toISO(new Date(2026, 0, 5)) === '2026-01-05', 'toISO 单位数月份');
ok(P.dayDiff(new Date(2026, 8, 1), new Date(2026, 8, 19)) === 18, 'dayDiff 18 天');
ok(P.dayDiff(new Date(2026, 8, 19), new Date(2026, 8, 19)) === 0, 'dayDiff 同天');
ok(P.dayDiff(new Date(2026, 8, 19), new Date(2026, 7, 19)) === -31, 'dayDiff 负数');
ok(P.parseDate('2026-09-19') instanceof Date, 'parseDate 正常');
ok(P.parseDate('') === null && P.parseDate('abc') === null && P.parseDate(null) === null, 'parseDate 非法输入返回 null');

/* ---------- 3. 价格因子单调性与边界 ---------- */
ok(P.seasonFactor(new Date(2026, 6, 15)) > P.seasonFactor(new Date(2026, 8, 15)), '暑假应贵于 9 月');
ok(P.seasonFactor(new Date(2026, 0, 15)) < P.seasonFactor(new Date(2026, 8, 15)), '1 月淡季应低于 9 月');
ok(P.seasonFactor(new Date(2026, 9, 3)) === 1.30, '国庆应为 1.30');
ok(P.weekdayFactor(new Date(2026, 8, 22)) < P.weekdayFactor(new Date(2026, 8, 25)), '周二应低于周五');
ok(P.leadFactor(20) < P.leadFactor(3), '提前 20 天应低于提前 3 天');
ok(P.leadFactor(20) <= P.leadFactor(1), '提前 20 天应低于提前 1 天');
ok(P.leadFactor(20) < P.leadFactor(90), '黄金窗口应低于过早预订');
ok(P.leadFactor(-1) === 1.50, '过期日期取最高系数');
// 火车浮动幅度必须被压制
const flightRoute = t('air-direct'), trainRoute = t('train-z164-hard');
const fF = P.contextFactor(flightRoute, new Date(2026, 6, 15), new Date(2026, 5, 15));
const fT = P.contextFactor(trainRoute, new Date(2026, 6, 15), new Date(2026, 5, 15));
ok(Math.abs(fT - 1) < Math.abs(fF - 1), '火车浮动幅度应小于机票');
ok(Math.abs(fT - 1) < 0.06, '火车浮动幅度应小于 6%');

/* ---------- 4. 目标价永远落在区间内 ---------- */
const dates = [];
for (let m = 0; m < 12; m++) for (const d of [1, 8, 15, 22, 28]) dates.push(new Date(2026, m, d));
P.ROUTES.forEach(r => {
  dates.forEach(d => {
    const v = P.targetPriceOf(r, d, new Date(d.getTime() - 20 * 86400000));
    ok(v >= r.range[0] - 1e-9 && v <= r.range[1] + 1e-9,
       `${r.id} @${P.toISO(d)} 目标价 ${v} 越界 [${r.range[0]},${r.range[1]}]`);
  });
});

/* ---------- 5. 价格步进不会越界、不会 NaN ---------- */
const rnd = mkRnd(20260919);
P.ROUTES.forEach(r => {
  let p = r.basePrice;
  for (let i = 0; i < 3000; i++) {
    const tgt = P.targetPriceOf(r, new Date(2026, 6, 20), new Date(2026, 6, 1));
    p = P.roundPrice(P.stepPriceFrom(p, r, tgt, rnd), r);
    if (!isFinite(p) || p < r.range[0] - 1e-9 || p > r.range[1] + 1e-9) {
      ok(false, r.id + ' 第 ' + i + ' 步越界: ' + p);
      return;
    }
  }
  ok(true, r.id + ' 3000 步内保持在区间');
});
// 固定价火车：区间上下限相同 → 价格恒定
const fixed = t('train-z164-seat');
near(P.roundPrice(P.stepPriceFrom(fixed.basePrice, fixed, 9999, rnd), fixed), 402.5, 0.001, '固定价车次价格不应变化');
// 均值回归：从区间顶端出发，多步后应回落
let hiStart = t('air-direct').range[1];
let hp = hiStart;
const tgtDirect = P.targetPriceOf(t('air-direct'), new Date(2026, 8, 19), new Date(2026, 8, 1));
for (let i = 0; i < 400; i++) hp = P.stepPriceFrom(hp, t('air-direct'), tgtDirect, rnd);
ok(hp < hiStart, '应从区间顶端向目标价回落');

/* ---------- 6. 余票状态机 ---------- */
P.STOCK_LEVELS.forEach(s => ok(P.STOCK_CLASS[s] !== undefined, 'STOCK_CLASS 缺少 ' + s));
ok(P.STOCK_LEVELS.length === 4, '余票档位应为 4 档');
let stk = '有票';
for (let i = 0; i < 500; i++) {
  stk = P.stepStock(stk, rnd);
  if (!P.STOCK_LEVELS.includes(stk)) { ok(false, '余票状态越界: ' + stk); break; }
}
ok(P.STOCK_LEVELS.includes(stk), '余票状态始终合法');
ok(P.stepStock('未知值', mkRnd(1)) === P.STOCK_LEVELS[1] || P.STOCK_LEVELS.includes(P.stepStock('未知值', mkRnd(1))),
   '未知余票状态有兜底');

/* ---------- 7. 历史序列 ---------- */
const hist = P.seedHistory(t('air-ct-transfer'), new Date(2026, 9, 10), new Date(2026, 8, 19), 1758300000000, 30, 360000, mkRnd(7));
ok(hist.length === 30, '历史点应为 30 个，实际 ' + hist.length);
let mono = true;
for (let i = 1; i < hist.length; i++) if (hist[i].t <= hist[i - 1].t) mono = false;
ok(mono, '历史时间戳必须严格递增');
ok(hist[hist.length - 1].t === 1758300000000, '最后一个点应为 now');
ok(hist.every(h => h.p >= t('air-ct-transfer').range[0] && h.p <= t('air-ct-transfer').range[1]), '历史价格在区间内');

/* ---------- 8. 排序 / 筛选 / 统计 ---------- */
const base = P.ROUTES.map(r => ({ ...r, price: r.basePrice }));
const byPrice = P.sortRoutes(base, 'price');
for (let i = 1; i < byPrice.length; i++) ok(byPrice[i].price >= byPrice[i - 1].price, 'price 排序非递减');
const byTime = P.sortRoutes(base, 'time');
for (let i = 1; i < byTime.length; i++) ok(byTime[i].durationMin >= byTime[i - 1].durationMin, 'time 排序非递减');
ok(P.sortRoutes(base, 'value')[0].id !== undefined, 'value 排序有结果');
ok(P.sortRoutes(base, 'price')[0].id === 'train-z164-seat', '最便宜应为硬座 402.5');
ok(P.sortRoutes(base, 'time')[0].id === 'air-direct', '最快应为浦东直飞 405 分钟');
ok(P.filterRoutes(base, 'train').length === 4, '火车方案应为 4 条');
ok(P.filterRoutes(base, 'flight').length === 5, '飞机方案应为 5 条');
ok(P.filterRoutes(base, 'combo').length === 1, '联运方案应为 1 条');
ok(P.filterRoutes(base, 'all').length === 10, '全部应为 10 条');
ok(P.filterRoutes(base, null).length === 10, 'null 筛选等同全部');
ok(P.filterRoutes(base, '不存在').length === 10, '未知筛选值应兜底为全部');
ok(P.computeStats([]) === null, '空列表统计返回 null');
const s = P.computeStats(base);
ok(s.cheapest.id === 'train-z164-seat', '最低价统计');
ok(s.fastest.id === 'air-direct', '最快统计');
ok(s.count === 10, '统计计数');
// 性价比推荐不应是最慢最贵的极端项
ok(s.best.mode !== undefined, '推荐项存在');
ok(s.best.id !== 'train-transfer', '不应推荐又慢又贵的中转火车');
ok(s.best.id !== 'train-z164-seat', '不应推荐 45 小时硬座');

/* ---------- 9. 每小时成本 ---------- */
near(P.hourlyCost({ price: 1200, durationMin: 600 }), 120, 1e-9, '每小时成本 = 120');
near(P.hourlyCost({ price: 402.5, durationMin: 2703 }), 402.5 / 45.05, 1e-6, '硬座每小时成本');

/* ---------- 10. 格式化 ---------- */
ok(P.formatMoney(1680) === '¥1,680', 'formatMoney 千分位，实际 ' + P.formatMoney(1680));
ok(P.formatMoney(402.5) === '¥402.5', 'formatMoney 小数');
ok(P.formatMoney(1310.5) === '¥1,310.5', 'formatMoney 千分位+小数');
ok(P.formatMoney(0) === '¥0', 'formatMoney 0');
ok(P.formatMoney(null) === '—' && P.formatMoney(NaN) === '—', 'formatMoney 非法输入');
ok(P.formatDuration(405) === '6 小时 45 分', 'formatDuration 6h45m，实际 ' + P.formatDuration(405));
ok(P.formatDuration(2703) === '1 天 21 小时 3 分', 'formatDuration 跨天，实际 ' + P.formatDuration(2703));
ok(P.formatDuration(3203) === '2 天 5 小时 23 分', 'formatDuration 两段火车，实际 ' + P.formatDuration(3203));
ok(P.formatClock(0) === '08:00:00' || /^\d{2}:\d{2}:\d{2}$/.test(P.formatClock(0)), 'formatClock 格式');
ok(P.formatClock(null) === '—', 'formatClock 非法输入');

/* ---------- 11. 涨跌 ---------- */
near(P.pctChange(1000, 1100), 10, 1e-9, '涨幅 10%');
near(P.pctChange(1000, 900), -10, 1e-9, '跌幅 10%');
ok(P.pctChange(0, 100) === 0, '分母为 0 不产生 Infinity');
ok(P.pctChange(NaN, 100) === 0, '非法输入返回 0');
ok(P.trendWord(5).cls === 'up', '上涨类名');
ok(P.trendWord(-5).cls === 'down', '下跌类名');
ok(P.trendWord(0.01).cls === 'flat', '微幅波动视为持平');
ok(P.trendWord(-5).text.includes('5.0%'), '跌幅文案含数值');

/* ---------- 12. 外部接口数据归一化 ---------- */
let n1 = P.normalizeLive({ updatedAt: '2026-09-19T19:43:00+08:00', prices: { 'air-direct': 1680, 'train-z164-hard': 841.5 } });
ok(Object.keys(n1.prices).length === 2, '{prices:{}} 格式解析出 2 条');
ok(n1.prices['air-direct'] === 1680, '取值正确');
ok(n1.updatedAt === '2026-09-19T19:43:00+08:00', 'updatedAt 透传');
let n2 = P.normalizeLive([{ id: 'air-direct', price: '2000' }, { id: 'x', price: 'abc' }, { nope: 1 }]);
ok(Object.keys(n2.prices).length === 1, '数组格式只收合法项，实际 ' + JSON.stringify(n2.prices));
ok(n2.prices['air-direct'] === 2000, '字符串数字应转成数字');
ok(Object.keys(P.normalizeLive(null).prices).length === 0, 'null 输入返回空');
ok(Object.keys(P.normalizeLive({}).prices).length === 0, '空对象返回空');
ok(Object.keys(P.normalizeLive({ prices: { a: { price: 100 } } }).prices).length === 1, '嵌套 {price} 对象可解析');

// applyLive：未知 id 忽略、越界夹紧、返回计数
const liveRoutes = P.ROUTES.map(r => ({ ...r, price: r.basePrice }));
const applied = P.applyLive(liveRoutes, { 'air-direct': 99999, 'air-ct-transfer': 5, 'ghost-route': 100 });
ok(applied.applied === 2, '应应用 2 条，实际 ' + applied.applied);
ok(applied.unknown.length === 1 && applied.unknown[0] === 'ghost-route', '应报告 1 个未知 id');
const dRoute = liveRoutes.find(r => r.id === 'air-direct');
ok(dRoute.price <= dRoute.range[1], '超上限应被夹紧，实际 ' + dRoute.price);
const ctRoute = liveRoutes.find(r => r.id === 'air-ct-transfer');
ok(ctRoute.price >= ctRoute.range[0], '超下限应被夹紧，实际 ' + ctRoute.price);
// 火车固定价即使接口给了别的值也被夹到全价
const liveTrain = P.ROUTES.map(r => ({ ...r, price: r.basePrice }));
P.applyLive(liveTrain, { 'train-z164-seat': 999 });
ok(liveTrain.find(r => r.id === 'train-z164-seat').price === 402.5, '固定价车次不受接口影响');

/* ---------- 13. 边界：极大极小值不应爆栈 ---------- */
const BIG = [];
for (let i = 0; i < 400000; i++) BIG.push(i % 9973);
let minLoop = BIG[0];
for (let i = 1; i < BIG.length; i++) if (BIG[i] < minLoop) minLoop = BIG[i];
ok(minLoop === 0, '循环求最小值');
// 证明 Math.min.apply 在这个规模下确实会炸（说明代码里没这么用是必要的）
let blew = false;
try { Math.min.apply(null, BIG); } catch (e) { blew = e instanceof RangeError; }
ok(blew, '400k 元素下 Math.min.apply 应抛 RangeError（对照断言）');

/* ---------- 14. 价格 × 日期序列（折线图数据） ---------- */
{
  const r0 = P.ROUTES.find(r => r.id === 'air-direct');
  const base = new Date(2026, 8, 19);
  const book = new Date(2026, 8, 19);
  const travel = new Date(2026, 9, 10);            // 21 天后
  const off = 37;
  const ps = P.priceSeries(r0, base, 90, book, off);

  ok(ps.length === 90, '序列长度应为 90，实际 ' + ps.length);
  let inc = true;
  for (let i = 1; i < ps.length; i++) if (ps[i].t <= ps[i - 1].t) inc = false;
  ok(inc, '时间戳必须严格递增');
  ok(ps[0].t === base.getTime(), '首个点应为起始日');
  ok(ps.every(p => p.p >= r0.range[0] && p.p <= r0.range[1]), '所有点必须落在价格区间内');
  ok(ps.every(p => isFinite(p.p)), '所有点必须是有限数');

  // 关键性质：曲线必须精确穿过「当前价」，否则和卡片数字对不上
  const idx = P.dayDiff(base, travel);
  const want = P.roundPrice(P.clamp(P.targetPriceOf(r0, travel, book) + off, r0.range[0], r0.range[1]), r0);
  near(ps[idx].p, want, 0.001, '曲线在出行日应等于 当前价（含 offset）');

  // offset = 0 时应等于纯目标价
  const ps0 = P.priceSeries(r0, base, 90, book, 0);
  const d5 = new Date(2026, 8, 24);
  near(ps0[5].p, P.roundPrice(P.targetPriceOf(r0, d5, book), r0), 0.001, 'offset=0 时应等于目标价');

  // 缺省 offset
  const psNo = P.priceSeries(r0, base, 10, book);
  ok(psNo.length === 10 && isFinite(psNo[0].p), '不传 offset 也要可用');

  // 跨月 / 跨年不越界
  const psYear = P.priceSeries(r0, new Date(2026, 11, 20), 60, new Date(2026, 11, 1), 0);
  ok(psYear.length === 60, '跨年序列长度正确');
  ok(psYear[59].date.getFullYear() === 2027, '跨年后年份应为 2027');
  ok(psYear.every(p => p.p >= r0.range[0] && p.p <= r0.range[1]), '跨年序列价格仍在区间内');

  // 火车固定价：整条曲线应为水平直线
  const rt = P.ROUTES.find(r => r.id === 'train-z164-seat');
  const psT = P.priceSeries(rt, base, 90, book, 0);
  ok(psT.every(p => p.p === 402.5), '固定价车次曲线必须水平，实际 ' + JSON.stringify([...new Set(psT.map(p => p.p))]));

  // 暑假应明显高于淡季（曲线形状有意义）——需要一整年序列才取得到
  const psYearAll = P.priceSeries(r0, base, 365, book, 0);
  const summer = psYearAll[P.dayDiff(base, new Date(2027, 6, 15))];
  const winter = psYearAll[P.dayDiff(base, new Date(2026, 11, 15))];
  ok(summer && winter, '全年序列应覆盖暑假与淡季两个取样点');
  ok(summer.p > winter.p, '曲线应体现淡旺季差异：暑假 ' + summer.p + ' > 淡季 ' + winter.p);
}

/* ---------- 15. 刻度生成 ---------- */
{
  const t1 = P.niceTicks(0, 100, 5);
  ok(t1.length >= 3 && t1.length <= 8, '刻度数量应合理，实际 ' + t1.length);
  ok(t1.every(v => v >= 0 && v <= 100), '刻度必须落在范围内');
  let even = true;
  for (let i = 2; i < t1.length; i++) if (Math.abs((t1[i] - t1[i - 1]) - (t1[1] - t1[0])) > 1e-6) even = false;
  ok(even, '刻度必须等距');

  const t2 = P.niceTicks(402, 3600, 5);
  ok(t2.length >= 3, '大跨度应有刻度，实际 ' + t2.length);
  ok(t2.every(v => v >= 402 && v <= 3600), '大跨度刻度必须在范围内');

  const t3 = P.niceTicks(1400, 1500, 5);
  ok(t3.length >= 2 && t3.every(v => v >= 1400 && v <= 1500), '窄跨度刻度，实际 ' + JSON.stringify(t3));

  /* 回归：跨度 2700 求 5 条，取整档位算出步长 1000，只剩 1000/2000 两条线，
     纵轴看起来像没有刻度。回退到更细一档后应至少有 4 条。 */
  const t4 = P.niceTicks(141, 2841, 5);
  ok(t4.length >= 4, '大跨度也应给出足够刻度（曾只剩 2 条），实际 ' + JSON.stringify(t4));
  ok(t4.every(v => v >= 141 && v <= 2841), '大跨度回退后刻度仍须在范围内');
  // 窄屏用 4 条目标，同样不能退化成两条
  const t5 = P.niceTicks(141, 2841, 4);
  ok(t5.length >= 3, '窄屏目标 4 条时也应给出至少 3 条，实际 ' + JSON.stringify(t5));

  // 任意跨度 × 任意目标条数，实际条数都不应塌到 3 条以下
  let thin = [];
  for (let s = 40; s <= 4000; s += 3) {
    for (const c of [4, 5]) {
      const t = P.niceTicks(100, 100 + s, c);
      if (t.length < 3) thin.push('span=' + s + ',want=' + c + '→' + JSON.stringify(t));
    }
  }
  ok(thin.length === 0, '刻度条数普遍偏少：' + thin.slice(0, 6).join(' | '));

  ok(P.niceTicks(5, 5, 5).length <= 1, '零跨度不应产生一堆刻度');
  ok(P.niceTicks(10, 5, 5).length <= 1, '反向区间不应产生刻度');
  ok(P.niceTicks(NaN, 10, 5).length === 0, '非法输入返回空数组');
  ok(P.niceTicks(0, 1e9, 5).length <= 24, '超大跨度应被数量上限截断');
}

/* ---------- 16. 日期短格式 ---------- */
ok(P.formatMonthDay(new Date(2026, 9, 10)) === '10/10', 'formatMonthDay 正常');
ok(P.formatMonthDay(new Date(2026, 0, 5)) === '1/5', 'formatMonthDay 不补零');
ok(P.formatMonthDay('bad') === '', 'formatMonthDay 非法输入返回空');

/* ---------- 17. modeLabel ---------- */
ok(P.modeLabel('flight') === '飞机', 'modeLabel flight');
ok(P.modeLabel('train') === '火车', 'modeLabel train');
ok(P.modeLabel('combo') === '空铁联运', 'modeLabel combo');
ok(P.modeLabel('other') === '其他', 'modeLabel 兜底');

/* ---------- 18. 班次时段与「避开阴间时段」 ---------- */
{
  const now = new Date();
  const travel = new Date(2026, 9, 10);

  // 数据完整性：每个方案都得有班次表，否则筛选逻辑会静默失效
  P.ROUTES.forEach(r => {
    ok(Array.isArray(r.slots) && r.slots.length >= 1, r.id + ' 应有至少 1 个班次');
    r.slots.forEach((s, i) => {
      ok(P.isNum(s.dep) && s.dep >= 0 && s.dep < 1440, r.id + ' 第 ' + i + ' 班起飞时刻合法');
      ok(P.isNum(s.arr) && s.arr > s.dep, r.id + ' 第 ' + i + ' 班抵达晚于起飞');
      ok(P.isNum(s.k) && s.k > 0 && s.k < 2, r.id + ' 第 ' + i + ' 班折扣系数合法');
      ok(typeof s.tag === 'string' && s.tag.length > 0, r.id + ' 第 ' + i + ' 班有时段名');
    });
  });

  // clockText：补零 + 跨天取模
  ok(P.clockText(0) === '00:00', 'clockText 零点');
  ok(P.clockText(390) === '06:30', 'clockText 06:30');
  ok(P.clockText(1113) === '18:33', 'clockText 18:33');
  ok(P.clockText(3816) === '15:36', 'clockText 跨天取模到当天时刻');
  ok(P.clockText(NaN) === '', 'clockText 非法输入返回空');

  // 跨天班次的「第几天」判定
  ok(P.slotArrDayOffset({ dep:1113, arr:3816 }) === 2, 'Z164 抵达是第 3 天（偏移 2）');
  ok(P.slotArrDayOffset({ dep:490, arr:895 }) === 0, '当天航班偏移为 0');

  // 阴间时段边界：06:00 与 22:00 是分界线，必须精确
  ok(P.isBadSlot({ dep:359, arr:600 }) === true,  '05:59 起飞算红眼');
  ok(P.isBadSlot({ dep:360, arr:600 }) === false, '06:00 起飞不算红眼（边界）');
  ok(P.isBadSlot({ dep:480, arr:1319 }) === false, '21:59 抵达可接受（边界内）');
  ok(P.isBadSlot({ dep:480, arr:1320 }) === true,  '22:00 抵达算落地太晚（边界）');
  ok(P.isBadSlot({ dep:480, arr:120 }) === true,   '凌晨 02:00 抵达算红眼');
  ok(P.isBadSlot({ dep:480, arr:1559 }) === true,  '次日 01:59 抵达算红眼');
  // 跨天班次也要按当地时刻判：18:33 发车 / 第三日 15:36 抵达是正常时段
  ok(P.isBadSlot({ dep:1113, arr:3816 }) === false, 'Z164 跨天抵达 15:36 属于正常时段');
  ok(P.isBadSlot({ dep:1140, arr:4343 }) === true,  '两段中转 00:23 抵达算阴间时段');
  ok(P.isBadSlot(null) === true, '空班次视为不可用');

  // 开关打开时，选中的班次一定不是阴间时段
  let pickedBad = [];
  P.ROUTES.forEach(r => {
    const res = P.pickSlot(r, travel, now, true);
    if (res.best && res.best.bad) pickedBad.push(r.id);
  });
  ok(pickedBad.length === 0, '开启筛选后不应选中阴间班次：' + pickedBad.join(','));

  // 开启筛选后只会更贵或持平（把红眼便宜票排除掉了）
  let cheaperWhenOn = [];
  P.ROUTES.forEach(r => {
    const on = P.pickSlot(r, travel, now, true);
    const off = P.pickSlot(r, travel, now, false);
    if (on.best && off.best && on.best.price < off.best.price) cheaperWhenOn.push(r.id);
  });
  ok(cheaperWhenOn.length === 0, '开启筛选后不应反而更便宜：' + cheaperWhenOn.join(','));

  // 关掉筛选时，每个方案都必须有可用班次
  const offAll = P.ROUTES.filter(r => !P.pickSlot(r, travel, now, false).available);
  ok(offAll.length === 0, '关闭筛选后所有方案都应可用：' + offAll.map(r => r.id).join(','));

  // 中转方案确实因为筛选而涨价（数据里专门留了红眼低价班次）
  const ct = P.ROUTES.find(r => r.id === 'air-ct-transfer');
  const ctOn = P.pickSlot(ct, travel, now, true);
  const ctOff = P.pickSlot(ct, travel, now, false);
  ok(ctOn.available && ctOff.available, '成都中转两种模式都可用');
  ok(ctOff.best.price < ctOn.best.price, '关闭筛选后能拿到更便宜的红眼价');
  ok(ctOn.best.bad === false, '开启筛选后选中的班次本身必须是正常时段');
  ok(ctOff.best.bad === true, '关闭筛选后选中的正是那个被排除的阴间班次');
  ok(ctOn.excluded >= 1, '成都中转应至少有 1 个班次被排除，实际 ' + ctOn.excluded);

  // 只有单一阴间班次的方案：开启筛选后应标记不可用，而不是硬塞一个红眼价
  const cd = P.ROUTES.find(r => r.id === 'air-chengdu');
  const cdOn = P.pickSlot(cd, travel, now, true);
  ok(cdOn.available === false, '经停成都（22:00 落地）在开启筛选后应不可用');
  ok(cdOn.best === null, '不可用时不应给出价格');
  ok(P.pickSlot(cd, travel, now, false).available === true, '关闭筛选后经停成都恢复可用');

  const tt = P.ROUTES.find(r => r.id === 'train-transfer');
  ok(P.pickSlot(tt, travel, now, true).available === false, '两段中转（00:23 抵达）应不可用');

  // 每个方案选中的班次必须来自它自己的班次表，且价格落在区间内
  P.ROUTES.forEach(r => {
    const res = P.pickSlot(r, travel, now, true);
    if (!res.best) return;
    ok(r.slots.indexOf(res.best.slot) >= 0, r.id + ' 选中的班次应来自自身班次表');
    ok(res.best.price >= r.range[0] - 0.01 && res.best.price <= r.range[1] + 0.01,
       r.id + ' 班次价格应在区间内，实际 ' + res.best.price);
  });

  // slotOptions 的班次数应与 slots 一致
  P.ROUTES.forEach(r => {
    ok(P.slotOptions(r, travel, now).length === r.slots.length, r.id + ' 班次选项数应一致');
  });

  // 没有 slots 的方案不应抛异常，退回系数 1
  ok(P.slotFactor({ basePrice: 100, range: [50, 200], mode: 'flight' }, travel, now, true) === 1,
     '无班次方案退回系数 1');

  // 价格系数确实影响 priceSeries
  const r0 = P.ROUTES.find(r => r.id === 'air-direct');
  const base = new Date(2026, 8, 19);
  const s1 = P.priceSeries(r0, base, 30, now, 0, 1);
  const s2 = P.priceSeries(r0, base, 30, now, 0, 1.2);
  ok(s2[0].p > s1[0].p, '系数 >1 应把曲线整体抬高，实际 ' + s1[0].p + ' → ' + s2[0].p);
  ok(s1.length === 30 && s2.length === 30, '带系数的序列长度不变');
}

/* ---------- 19. 返程方向（拉萨 → 上海） ---------- */

{
  // 方向 API
  ok(P.routesFor('out') === P.ROUTES, 'routesFor(out) 应返回去程数据');
  ok(P.routesFor('back') === P.ROUTES_BACK, 'routesFor(back) 应返回返程数据');
  ok(P.routesFor(undefined) === P.ROUTES, 'routesFor(undefined) 退回去程');
  ok(P.routesFor('xxx') === P.ROUTES, '非法方向退回去程');
  ok(P.isDirection('out') && P.isDirection('back'), 'isDirection 认得两个合法值');
  ok(!P.isDirection('') && !P.isDirection(null) && !P.isDirection('OUT'),
     'isDirection 拒绝空值 / 大小写不符');

  ok(P.directionOf('back').kind === '出藏', '返程方向词应为「出藏」');
  ok(P.directionOf('out').kind === '进藏', '去程方向词应为「进藏」');
  ok(P.directionOf('zzz').key === 'out', '非法方向退回 directionOf(out)');
  ok(P.directionOf('back').from === '拉萨' && P.directionOf('back').to === '上海',
     '返程起终点应为 拉萨 → 上海');

  // 返程数据完整性
  ok(P.ROUTES_BACK.length === P.ROUTES.length,
     '返程方案数应与去程一致，实际 ' + P.ROUTES_BACK.length);

  const backIds = P.ROUTES_BACK.map(r => r.id);
  ok(new Set(backIds).size === backIds.length, '返程方案 id 不应重复');
  const outIdSet = new Set(P.ROUTES.map(r => r.id));
  ok(backIds.every(id => !outIdSet.has(id)),
     '返程 id 不应与去程撞车（数据源是按 id 取价的）');

  P.ROUTES_BACK.forEach(r => {
    ['id', 'mode', 'name', 'path', 'schedule', 'clock', 'durationMin',
     'basePrice', 'range', 'unit', 'stops', 'note', 'pros', 'cons'].forEach(f => {
      ok(r[f] !== undefined && r[f] !== null && r[f] !== '', r.id + ' 缺少字段 ' + f);
    });
    ok(Array.isArray(r.pros) && r.pros.length > 0, r.id + ' pros 应非空');
    ok(Array.isArray(r.cons) && r.cons.length > 0, r.id + ' cons 应非空');
    ok(Array.isArray(r.slots) && r.slots.length > 0, r.id + ' 应有班次数据');
    ok(r.range[0] <= r.basePrice && r.basePrice <= r.range[1], r.id + ' basePrice 应落在 range 内');
    ok(r.range[0] <= r.range[1], r.id + ' range 上下限反了');
    ok(r.durationMin > 0, r.id + ' 时长应为正');
    ok(['flight', 'train', 'combo'].includes(r.mode), r.id + ' mode 非法：' + r.mode);
    // 火车票价固定，区间应当收成一个点
    if (r.mode === 'train' && r.id.indexOf('transfer') < 0) {
      ok(r.range[0] === r.range[1], r.id + ' 火车票价应固定');
    }
  });

  // Z166 直达：与 Z164 对开，班次时刻是本方向的核心锚点
  const z166 = P.ROUTES_BACK.find(r => r.id === 'train-z166-hard');
  ok(!!z166, '应存在 train-z166-hard');
  ok(z166.durationMin === 2703, 'Z166 全程应与 Z164 对称（2703 分钟），实际 ' + z166.durationMin);
  ok(P.clockText(z166.slots[0].dep) === '12:45',
     'Z166 应 12:45 发车，实际 ' + P.clockText(z166.slots[0].dep));
  ok(P.clockText(z166.slots[0].arr) === '09:48',
     'Z166 应第三日 09:48 抵达，实际 ' + P.clockText(z166.slots[0].arr));
  ok(P.slotArrDayOffset(z166.slots[0]) === 2, 'Z166 抵达应落在第三日');

  // 三种铺位同车次同班期，只有票价不同
  const zSoft = P.ROUTES_BACK.find(r => r.id === 'train-z166-soft');
  const zSeat = P.ROUTES_BACK.find(r => r.id === 'train-z166-seat');
  ok(zSoft.slots[0].dep === z166.slots[0].dep && zSoft.slots[0].arr === z166.slots[0].arr,
     '软卧 / 硬卧应同一班次');
  ok(zSeat.slots[0].dep === z166.slots[0].dep, '硬座应与硬卧同班次');
  ok(zSoft.basePrice > z166.basePrice && z166.basePrice > zSeat.basePrice,
     '铺位价格应满足 软卧 > 硬卧 > 硬座');

  // 拉萨出港集中在上午（贡嘎午后风大），不能出现下午才起飞的直飞
  const directBack = P.ROUTES_BACK.find(r => r.id === 'air-direct-back');
  ok(P.clockText(directBack.slots[0].dep) === '10:20',
     '贡嘎直飞应上午起飞，实际 ' + P.clockText(directBack.slots[0].dep));

  // 离藏需求集中：返程机票不应比去程便宜
  P.ROUTES_BACK.forEach(rb => {
    const ro = P.ROUTES.find(r => r.id === rb.id.replace(/-back$/, ''));
    if (!ro || ro.mode !== 'flight') return;      // 火车同价，不参与比较
    ok(rb.basePrice >= ro.basePrice,
       rb.id + ' 返程票价不应低于去程 ' + ro.basePrice + '，实际 ' + rb.basePrice);
  });

  // 返程班次同样要过「避开阴间时段」的筛
  const now2 = new Date(2026, 8, 19);
  const travel2 = new Date(2026, 11, 10);
  P.ROUTES_BACK.forEach(r => {
    const pick = P.pickSlot(r, travel2, now2, true);
    ok(pick.options.length === r.slots.length, r.id + ' 返程班次选项数应一致');
    if (pick.best) {
      ok(!P.isBadSlot(pick.best.slot), r.id + ' 开启筛选后不应选中阴间时段');
      ok(pick.best.price >= r.range[0] && pick.best.price <= r.range[1],
         r.id + ' 返程班次价格应在区间内');
    }
  });

  // 两个中转方案各有两个红眼班次，验证筛选确实在起作用
  ['air-ct-transfer-back', 'air-cq-transfer-back'].forEach(id => {
    const r = P.ROUTES_BACK.find(x => x.id === id);
    const pick = P.pickSlot(r, travel2, now2, true);
    ok(pick.excluded === 2, id + ' 应排除 2 个红眼班次，实际 ' + pick.excluded);
    ok(pick.available === true, id + ' 仍应有可用班次');
    const all = P.pickSlot(r, travel2, now2, false);
    ok(all.best.price < pick.best.price,
       id + ' 关掉筛选后应能拿到更低价，实际 ' + all.best.price + ' vs ' + pick.best.price);
  });

  // 出藏航班集中在上午，反而没有「全军覆没」的方案
  const naBack = P.ROUTES_BACK.filter(r => !P.pickSlot(r, travel2, now2, true).best).length;
  ok(naBack === 0, '返程不应有时段完全不合适的方案，实际 ' + naBack + ' 个');

  // 两个方向不能共用同一份对象，否则改一边会污染另一边
  ok(P.ROUTES[0] !== P.ROUTES_BACK[0], '两个方向的数据不应是同一份引用');

  // 返程方向的价格序列同样可用
  const sr = P.priceSeries(P.ROUTES_BACK[0], new Date(2026, 8, 19), 30, now2, 0, 1);
  ok(sr.length === 30, '返程价格序列应为 30 天');
  ok(sr.every(x => x.p >= P.ROUTES_BACK[0].range[0] && x.p <= P.ROUTES_BACK[0].range[1]),
     '返程价格序列应全部落在区间内');
}

/* ---------- 输出 ---------- */
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细：');
  failures.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('全部断言通过 ✓');
}
