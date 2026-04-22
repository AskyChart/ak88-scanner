// ============================================================
// AK88 AZLS Scanner — Digital Ocean App Platform
// Binance USDT-M perpetuals · Timeframe: 4H · Context: Weekly EMA50
// ============================================================

import http from 'node:http';

const CONFIG = {
  TOP_SYMBOLS: 150,
  CONCURRENCY: 15,
  KLINES_4H_LIMIT: 500,
  KLINES_1W_LIMIT: 100,
  PIVOT_LEN: 5,
  MIN_MOVE_PCT: 10.0,
  MAX_AGE_BARS: 60,
  FIB_ZONE_LOW: 0.705,
  FIB_ZONE_HIGH: 0.886,
  FIB_EQ: 0.5,
  FIB_TP3: -0.272,
  ATR_LEN: 14,
  SL_BUFF_ATR: 1.0,
  EMA_FAST: 20,
  EMA_SLOW: 50,
  EMA_LONG: 200,
  ADX_LEN: 14,
  RSI_LEN: 14,
  CTX_EMA_LEN: 50,
  MIN_SCORE: 60,
  CACHE_TTL_MS: 60 * 1000,  // кэш на 60 сек
};

const BINANCE = 'https://fapi.binance.com';

// ============================================================
// CACHE (простой in-memory)
// ============================================================
let cache = { data: null, timestamp: 0 };

// ============================================================
// DATA FETCHING (Binance futures)
// ============================================================
async function getSymbols() {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`ticker/24hr failed: ${r.status}`);
  const all = await r.json();
  return all
    .filter(s => s.symbol.endsWith('USDT') && !s.symbol.includes('_'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, CONFIG.TOP_SYMBOLS)
    .map(s => ({ symbol: s.symbol, volume24h: parseFloat(s.quoteVolume) }));
}

async function getKlines(symbol, interval, limit) {
  const url = `${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  if (!Array.isArray(data)) return null;
  return data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ============================================================
// INDICATORS
// ============================================================
function computeEMA(series, length) {
  if (series.length < length) return null;
  const k = 2 / (length + 1);
  let ema = series.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < series.length; i++) {
    ema = series[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeRSI(closes, length) {
  if (closes.length < length + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / length;
  let avgLoss = losses / length;
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (length - 1) + g) / length;
    avgLoss = (avgLoss * (length - 1) + l) / length;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeATR(klines, length) {
  if (klines.length < length + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const tr1 = klines[i].high - klines[i].low;
    const tr2 = Math.abs(klines[i].high - klines[i - 1].close);
    const tr3 = Math.abs(klines[i].low - klines[i - 1].close);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  let atr = trs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < trs.length; i++) {
    atr = (atr * (length - 1) + trs[i]) / length;
  }
  return atr;
}

function computeADX(klines, length) {
  if (klines.length < length * 2 + 1) return null;
  const tr = [], dmP = [], dmM = [];
  for (let i = 1; i < klines.length; i++) {
    const c = klines[i], p = klines[i - 1];
    const tr1 = c.high - c.low;
    const tr2 = Math.abs(c.high - p.close);
    const tr3 = Math.abs(c.low - p.close);
    tr.push(Math.max(tr1, tr2, tr3));
    const up = c.high - p.high;
    const dn = p.low - c.low;
    dmP.push(up > dn && up > 0 ? up : 0);
    dmM.push(dn > up && dn > 0 ? dn : 0);
  }
  let trS = tr.slice(0, length).reduce((a, b) => a + b, 0);
  let pS = dmP.slice(0, length).reduce((a, b) => a + b, 0);
  let mS = dmM.slice(0, length).reduce((a, b) => a + b, 0);
  let diP = 100 * pS / trS;
  let diM = 100 * mS / trS;
  const dxArr = [(diP + diM) === 0 ? 0 : 100 * Math.abs(diP - diM) / (diP + diM)];
  for (let i = length; i < tr.length; i++) {
    trS = trS - trS / length + tr[i];
    pS = pS - pS / length + dmP[i];
    mS = mS - mS / length + dmM[i];
    diP = 100 * pS / trS;
    diM = 100 * mS / trS;
    const dx = (diP + diM) === 0 ? 0 : 100 * Math.abs(diP - diM) / (diP + diM);
    dxArr.push(dx);
  }
  if (dxArr.length < length) return null;
  let adx = dxArr.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < dxArr.length; i++) {
    adx = (adx * (length - 1) + dxArr[i]) / length;
  }
  return { adx, diPlus: diP, diMinus: diM };
}

function findPivots(klines, pivotLen) {
  const pivots = [];
  for (let i = pivotLen; i < klines.length - pivotLen; i++) {
    let isH = true, isL = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isH = false;
      if (klines[j].low <= klines[i].low) isL = false;
    }
    if (isH) pivots.push({ index: i, type: 'H', price: klines[i].high });
    if (isL) pivots.push({ index: i, type: 'L', price: klines[i].low });
  }
  return pivots;
}

// ============================================================
// SETUP ANALYSIS
// ============================================================
function analyze(symbol, k4h, k1w) {
  if (!k4h || k4h.length < 220) return null;
  if (!k1w || k1w.length < 55) return null;

  const last = k4h[k4h.length - 1];
  const weeklyCloses = k1w.map(k => k.close);
  const weeklyEma = computeEMA(weeklyCloses, CONFIG.CTX_EMA_LEN);
  if (weeklyEma === null) return null;
  const weeklyClose = weeklyCloses[weeklyCloses.length - 1];
  const isLong = weeklyClose > weeklyEma;
  const isShort = !isLong;

  const pivots = findPivots(k4h, CONFIG.PIVOT_LEN);
  if (pivots.length < 2) return null;

  let anchor = null, target = null;
  const anchorType = isShort ? 'H' : 'L';
  const targetType = isShort ? 'L' : 'H';

  outer: for (let i = pivots.length - 1; i >= 0; i--) {
    if (pivots[i].type !== anchorType) continue;
    const a = pivots[i];
    for (let j = i + 1; j < pivots.length; j++) {
      if (pivots[j].type !== targetType) continue;
      const t = pivots[j];
      const movePct = isShort
        ? (a.price - t.price) / a.price * 100
        : (t.price - a.price) / a.price * 100;
      if (movePct >= CONFIG.MIN_MOVE_PCT) {
        anchor = a;
        target = t;
        break outer;
      }
    }
  }
  if (!anchor || !target) return null;

  if (isShort && last.close > anchor.price) return null;
  if (isLong && last.close < anchor.price) return null;

  const ageBars = k4h.length - 1 - target.index;
  if (ageBars > CONFIG.MAX_AGE_BARS) return null;

  const range = Math.abs(anchor.price - target.price);
  const atr = computeATR(k4h, CONFIG.ATR_LEN);
  if (atr === null) return null;

  let zoneLow, zoneHigh, equilibr, slLevel, tp1, tp2, tp3;
  if (isShort) {
    zoneLow = target.price + range * CONFIG.FIB_ZONE_LOW;
    zoneHigh = target.price + range * CONFIG.FIB_ZONE_HIGH;
    equilibr = target.price + range * CONFIG.FIB_EQ;
    slLevel = anchor.price + atr * CONFIG.SL_BUFF_ATR;
    tp1 = equilibr;
    tp2 = target.price;
    tp3 = target.price + range * CONFIG.FIB_TP3;
  } else {
    zoneHigh = target.price - range * CONFIG.FIB_ZONE_LOW;
    zoneLow = target.price - range * CONFIG.FIB_ZONE_HIGH;
    equilibr = target.price - range * CONFIG.FIB_EQ;
    slLevel = anchor.price - atr * CONFIG.SL_BUFF_ATR;
    tp1 = equilibr;
    tp2 = target.price;
    tp3 = target.price - range * CONFIG.FIB_TP3;
  }

  const touchedZone = isShort ? last.high >= zoneLow : last.low <= zoneHigh;
  const insideZone = last.close >= zoneLow && last.close <= zoneHigh;

  const bRange = last.high - last.low;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  const bearRej = bRange > 0 && upper / bRange >= 0.5 && last.close < last.open && last.high >= zoneLow;
  const bullRej = bRange > 0 && lower / bRange >= 0.5 && last.close > last.open && last.low <= zoneHigh;
  const triggerNow = touchedZone && ((isShort && bearRej) || (isLong && bullRej));

  const closes = k4h.map(k => k.close);

  let htfScore = 0;
  if (isShort) {
    if (weeklyClose < weeklyEma) htfScore = 25;
    else if (weeklyClose < weeklyEma * 1.02) htfScore = 12;
  } else {
    if (weeklyClose > weeklyEma) htfScore = 25;
    else if (weeklyClose > weeklyEma * 0.98) htfScore = 12;
  }

  const emaFast = computeEMA(closes, CONFIG.EMA_FAST);
  const emaSlow = computeEMA(closes, CONFIG.EMA_SLOW);
  const emaLongV = computeEMA(closes, CONFIG.EMA_LONG);
  let trendScore = 0;
  if (emaFast !== null && emaSlow !== null && emaLongV !== null) {
    if (isShort) {
      if (emaFast < emaSlow && emaSlow < emaLongV && last.close < emaFast) trendScore = 20;
      else if (emaFast < emaSlow && last.close < emaSlow) trendScore = 12;
      else if (last.close < emaSlow) trendScore = 6;
    } else {
      if (emaFast > emaSlow && emaSlow > emaLongV && last.close > emaFast) trendScore = 20;
      else if (emaFast > emaSlow && last.close > emaSlow) trendScore = 12;
      else if (last.close > emaSlow) trendScore = 6;
    }
  }

  const adxData = computeADX(k4h, CONFIG.ADX_LEN);
  let adxScore = 0;
  let adxVal = 0;
  if (adxData) {
    adxVal = adxData.adx;
    if (isShort) {
      if (adxData.adx > 25 && adxData.diMinus > adxData.diPlus) adxScore = 15;
      else if (adxData.adx > 20 && adxData.diMinus > adxData.diPlus) adxScore = 10;
      else if (adxData.diMinus > adxData.diPlus) adxScore = 5;
    } else {
      if (adxData.adx > 25 && adxData.diPlus > adxData.diMinus) adxScore = 15;
      else if (adxData.adx > 20 && adxData.diPlus > adxData.diMinus) adxScore = 10;
      else if (adxData.diPlus > adxData.diMinus) adxScore = 5;
    }
  }

  const barsInMove = Math.max(target.index - anchor.index, 1);
  const movePct = range / (isShort ? anchor.price : target.price) * 100;
  const speed = movePct / barsInMove;
  let impulseScore = 0;
  if (speed >= 1.5) impulseScore = 15;
  else if (speed >= 0.8) impulseScore = 10;
  else if (speed >= 0.4) impulseScore = 5;

  const vols = k4h.map(k => k.volume);
  const v10 = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const v30 = vols.slice(-30).reduce((a, b) => a + b, 0) / 30;
  const volRatio = v30 > 0 ? v10 / v30 : 1;
  let volScore = 0;
  if (volRatio < 0.7) volScore = 15;
  else if (volRatio < 0.9) volScore = 10;
  else if (volRatio < 1.1) volScore = 5;

  const rsi = computeRSI(closes, CONFIG.RSI_LEN);
  let momScore = 0;
  if (rsi !== null) {
    if (isShort) {
      if (touchedZone && rsi > 60) momScore = 10;
      else if (touchedZone && rsi > 50) momScore = 5;
      else if (rsi > 60) momScore = 3;
    } else {
      if (touchedZone && rsi < 40) momScore = 10;
      else if (touchedZone && rsi < 50) momScore = 5;
      else if (rsi < 40) momScore = 3;
    }
  }

  const totalScore = Math.round(htfScore + trendScore + adxScore + impulseScore + volScore + momScore);

  let verdict;
  if (totalScore >= 80) verdict = 'ОЧЕНЬ СИЛЬНЫЙ';
  else if (totalScore >= 60) verdict = 'СИЛЬНЫЙ';
  else if (totalScore >= 40) verdict = 'СРЕДНИЙ';
  else if (totalScore >= 20) verdict = 'СЛАБЫЙ';
  else verdict = 'НЕ ТОРГУЙ';

  let status, statusKey;
  if (triggerNow) { status = 'ТРИГГЕР'; statusKey = 'trigger'; }
  else if (insideZone) { status = 'В ЗОНЕ'; statusKey = 'inzone'; }
  else if (touchedZone) { status = 'Коснулся'; statusKey = 'touched'; }
  else { status = 'Жду возврата'; statusKey = 'waiting'; }

  const entryMid = (zoneLow + zoneHigh) / 2;
  const distPct = (last.close - entryMid) / last.close * 100;
  const risk = Math.abs(slLevel - entryMid);
  const rr2 = risk > 0 ? Math.abs(tp2 - entryMid) / risk : 0;

  return {
    symbol,
    direction: isLong ? 'BUY' : 'SELL',
    score: totalScore,
    verdict,
    status,
    statusKey,
    triggerNow,
    insideZone,
    touchedZone,
    currentPrice: last.close,
    zoneLow, zoneHigh, slLevel, tp1, tp2, tp3,
    rr2,
    distPct,
    ageBars,
    rsi: rsi !== null ? Math.round(rsi) : null,
    adx: Math.round(adxVal),
    components: { htfScore, trendScore, adxScore, impulseScore, volScore, momScore },
  };
}

// ============================================================
// PIPELINE
// ============================================================
async function analyzeSymbol(symbolObj) {
  try {
    const [k4h, k1w] = await Promise.all([
      getKlines(symbolObj.symbol, '4h', CONFIG.KLINES_4H_LIMIT),
      getKlines(symbolObj.symbol, '1w', CONFIG.KLINES_1W_LIMIT),
    ]);
    const r = analyze(symbolObj.symbol, k4h, k1w);
    if (r) r.volume24h = symbolObj.volume24h;
    return r;
  } catch (e) {
    return null;
  }
}

async function scanBatch(symbols) {
  const results = [];
  for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
    const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
    const batchResults = await Promise.all(batch.map(analyzeSymbol));
    results.push(...batchResults.filter(r => r !== null));
  }
  return results;
}

async function runScan() {
  const t0 = Date.now();
  const symbols = await getSymbols();
  const results = await scanBatch(symbols);
  const filtered = results
    .filter(r => r.score >= CONFIG.MIN_SCORE)
    .sort((a, b) => {
      const order = { trigger: 0, inzone: 1, touched: 2, waiting: 3 };
      if (order[a.statusKey] !== order[b.statusKey]) {
        return order[a.statusKey] - order[b.statusKey];
      }
      return b.score - a.score;
    });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { results: filtered, scannedCount: symbols.length, elapsed, generatedAt: new Date().toISOString() };
}

// ============================================================
// HTML RENDERING
// ============================================================
function fmtPrice(p) {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

function fmtVolume(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

function scoreColor(s) {
  if (s >= 80) return '#ef4444';
  if (s >= 70) return '#f97316';
  if (s >= 60) return '#eab308';
  return '#6b7280';
}

function statusBadge(key, text) {
  const colors = { trigger: '#ef4444', inzone: '#f97316', touched: '#eab308', waiting: '#3b82f6' };
  return `<span class="badge" style="background:${colors[key]}">${text}</span>`;
}

function directionBadge(dir) {
  const color = dir === 'BUY' ? '#10b981' : '#ef4444';
  return `<span class="dir-badge" style="background:${color}">${dir}</span>`;
}

function renderHTML(data) {
  const { results, scannedCount, elapsed, generatedAt } = data;
  const rows = results.map(r => {
    const tvSymbol = `BINANCE:${r.symbol}.P`;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}&interval=240`;
    const comp = r.components;
    const compStr = `${comp.htfScore}/${comp.trendScore}/${comp.adxScore} · ${comp.impulseScore}/${comp.volScore}/${comp.momScore}`;
    return `
      <tr class="row-${r.statusKey}">
        <td class="sym"><a href="${tvUrl}" target="_blank">${r.symbol}</a></td>
        <td>${directionBadge(r.direction)}</td>
        <td class="score" style="color:${scoreColor(r.score)}"><b>${r.score}</b></td>
        <td class="verdict">${r.verdict}</td>
        <td>${statusBadge(r.statusKey, r.status)}</td>
        <td class="num">${fmtPrice(r.currentPrice)}</td>
        <td class="num">${fmtPrice(r.zoneLow)} — ${fmtPrice(r.zoneHigh)}</td>
        <td class="num dist">${r.distPct > 0 ? '+' : ''}${r.distPct.toFixed(1)}%</td>
        <td class="num sl">${fmtPrice(r.slLevel)}</td>
        <td class="num tp">${fmtPrice(r.tp2)}</td>
        <td class="num rr">${r.rr2.toFixed(2)}</td>
        <td class="num rsi">${r.rsi ?? '-'}</td>
        <td class="num adx">${r.adx}</td>
        <td class="comp">${compStr}</td>
        <td class="num age">${r.ageBars}</td>
        <td class="num vol">${fmtVolume(r.volume24h)}</td>
      </tr>`;
  }).join('');

  const longCount = results.filter(r => r.direction === 'BUY').length;
  const shortCount = results.filter(r => r.direction === 'SELL').length;
  const triggerCount = results.filter(r => r.triggerNow).length;
  const inzoneCount = results.filter(r => r.insideZone).length;
  const genTime = new Date(generatedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 AZLS Scanner</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:15px}
  h1{margin:0;font-size:22px;color:#fff}h1 span{color:#6b7280;font-weight:400;font-size:14px}
  .stats{display:flex;gap:15px;font-size:13px;flex-wrap:wrap}
  .stat-box{background:#1f2937;padding:8px 14px;border-radius:6px;border:1px solid #374151}
  .stat-box b{color:#fff;font-size:18px;display:block}.stat-box span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  .refresh{background:#2563eb;color:#fff;padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;text-decoration:none}
  .refresh:hover{background:#1d4ed8}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151;position:sticky;top:0}
  td{padding:9px 8px;border-bottom:1px solid #1f2937;white-space:nowrap}
  tr:hover{background:#1a2332}
  .row-trigger{background:rgba(239,68,68,0.08)}.row-inzone{background:rgba(249,115,22,0.05)}
  .sym a{color:#60a5fa;text-decoration:none;font-weight:600}.sym a:hover{text-decoration:underline}
  .score{font-size:16px;text-align:center}.verdict{font-size:12px;color:#d1d5db}
  .num{text-align:right;font-variant-numeric:tabular-nums;color:#d1d5db}
  .sl{color:#f87171}.tp{color:#34d399}.rr{color:#fbbf24;font-weight:600}
  .comp{color:#6b7280;font-size:11px;font-family:monospace}.dist{color:#9ca3af}
  .age,.vol,.rsi,.adx{color:#9ca3af;font-size:12px}
  .badge{color:#fff;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;display:inline-block}
  .dir-badge{color:#fff;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px}
  .empty{text-align:center;padding:60px 20px;color:#6b7280;font-size:15px}
  .footer{margin-top:20px;color:#6b7280;font-size:12px;text-align:center}
  .filter-info{background:#1e293b;padding:10px 15px;border-radius:6px;margin-bottom:15px;font-size:12px;color:#94a3b8;border-left:3px solid #3b82f6}
</style></head><body>
<div class="header">
  <h1>AK88 AZLS Scanner <span>· 4H · Binance USDT-M · Score ≥ ${CONFIG.MIN_SCORE}</span></h1>
  <div class="stats">
    <div class="stat-box"><b>${results.length}</b><span>Setups</span></div>
    <div class="stat-box"><b style="color:#ef4444">${triggerCount}</b><span>Триггер</span></div>
    <div class="stat-box"><b style="color:#f97316">${inzoneCount}</b><span>В зоне</span></div>
    <div class="stat-box"><b style="color:#10b981">${longCount}</b><span>BUY</span></div>
    <div class="stat-box"><b style="color:#ef4444">${shortCount}</b><span>SELL</span></div>
  </div>
  <a href="/" class="refresh">↻ Обновить</a>
</div>
<div class="filter-info">
  Проверено ${scannedCount} монет за ${elapsed}с · Обновлено: ${genTime} · Контекст: Weekly EMA50 · Pivot: ${CONFIG.PIVOT_LEN} · Min impulse: ${CONFIG.MIN_MOVE_PCT}% · Max age: ${CONFIG.MAX_AGE_BARS} баров · Кэш: ${CONFIG.CACHE_TTL_MS / 1000}с
</div>
${results.length === 0 ? '<div class="empty">Нет сетапов со Score ≥ ' + CONFIG.MIN_SCORE + '. Попробуй позже.</div>' : `
<table><thead><tr>
<th>Символ</th><th>Напр</th><th>Score</th><th>Вердикт</th><th>Статус</th><th>Цена</th>
<th>Зона входа</th><th>Δ до зоны</th><th>SL</th><th>TP2</th><th>R:R</th>
<th>RSI</th><th>ADX</th><th>HTF/EMA/ADX · Имп/Об/RSI</th><th>Age</th><th>Vol 24h</th>
</tr></thead><tbody>${rows}</tbody></table>`}
<div class="footer">
  Premium Zone Short / Discount Zone Long · Направление = Weekly EMA50 · R:R до TP2
</div>
</body></html>`;
}

// ============================================================
// HTTP SERVER
// ============================================================
const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check для DO
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  // JSON API
  if (url.pathname === '/api/scan') {
    try {
      const now = Date.now();
      let data;
      if (cache.data && (now - cache.timestamp) < CONFIG.CACHE_TTL_MS) {
        data = cache.data;
      } else {
        data = await runScan();
        cache = { data, timestamp: now };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Main HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const now = Date.now();
      let data;
      if (cache.data && (now - cache.timestamp) < CONFIG.CACHE_TTL_MS) {
        data = cache.data;
      } else {
        data = await runScan();
        cache = { data, timestamp: now };
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHTML(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<pre style="font-family:monospace;padding:20px;background:#111;color:#f88">Error: ${e.message}\n\n${e.stack}</pre>`);
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`AK88 AZLS Scanner listening on port ${PORT}`);
});
