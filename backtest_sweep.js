// ============================================================
// AK88 Sweep Backtest — SMC Liquidity Grab strategy
// После sweep pivot high/low с возвратом в зону — вход против пробоя
// Uses same cache as AZLS backtest
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  YEARS_BACK: 2,
  TOP_SYMBOLS: 30,
  TIMEFRAME: '4h',

  // Pivot structure detection
  PIVOT_LEN: 5,
  MIN_MOVE_PCT: 10.0,       // мин. импульс H1→L1
  MAX_AGE_BARS: 60,         // pivot устаревает

  // Sweep detection
  MAX_SWEEP_DEPTH_ATR: 1.0, // sweep максимум 1×ATR выше H1 (иначе реальный пробой)
  SWEEP_RETURN_BARS: 3,     // цена должна вернуться в течение 3 баров
  SL_BUFFER_ATR: 0.25,      // SL буфер за максимумом sweep

  // TP levels (относительно диапазона H1-L1)
  FIB_EQ: 0.5,              // TP1 equilibrium
  FIB_TP3: -0.272,          // TP3 extension
  TP1_FRACTION: 0.333,
  TP2_FRACTION: 0.333,
  TP3_FRACTION: 0.334,
  MOVE_TO_BE_AFTER_TP1: true,

  // Context filter
  CTX_EMA_LEN: 50,          // Weekly EMA50

  // Indicators
  ATR_LEN: 14,

  // Risk
  START_BALANCE: 10000,
  RISK_PCT: 1.0,
  MAX_CONCURRENT: 5,

  // Costs
  COMMISSION_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,

  // API
  BINANCE: 'https://fapi.binance.com',
  KLINES_LIMIT: 1000,
  CONCURRENCY: 5,

  REPORT_FILE: path.join(__dirname, 'sweep_report.html'),
  CACHE_DIR: path.join(__dirname, 'backtest_cache'),
};

// ============================================================
// DATA (same as other backtests)
// ============================================================
async function getTopSymbols() {
  const r = await fetch(`${CONFIG.BINANCE}/fapi/v1/ticker/24hr`);
  const all = await r.json();
  return all
    .filter(s => s.symbol.endsWith('USDT') && !s.symbol.includes('_'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, CONFIG.TOP_SYMBOLS)
    .map(s => s.symbol);
}

async function fetchKlinesPage(symbol, interval, endTime, limit) {
  const url = `${CONFIG.BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return Array.isArray(data) ? data.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  })) : null;
}

async function fetchAllKlines(symbol, interval, years) {
  const now = Date.now();
  const startT = now - years * 365 * 24 * 60 * 60 * 1000;
  const all = [];
  let endTime = now;
  for (let i = 0; i < 20; i++) {
    const page = await fetchKlinesPage(symbol, interval, endTime, CONFIG.KLINES_LIMIT);
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page[0].time <= startT) break;
    endTime = page[0].time - 1;
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = new Set();
  const unique = all.filter(k => !seen.has(k.time) && seen.add(k.time));
  unique.sort((a, b) => a.time - b.time);
  return unique.filter(k => k.time >= startT);
}

async function loadOrFetch(symbol, interval, years, cacheDir) {
  const cache = path.join(cacheDir, `${symbol}_${interval}_${years}y.json`);
  try {
    const raw = await fs.readFile(cache, 'utf-8');
    const d = JSON.parse(raw);
    if (Date.now() - d[d.length - 1].time < 24 * 60 * 60 * 1000) return d;
  } catch (e) {}
  const data = await fetchAllKlines(symbol, interval, years);
  if (data && data.length > 0) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cache, JSON.stringify(data));
  }
  return data;
}

// ============================================================
// INDICATORS
// ============================================================
function computeATRSeries(k, length) {
  const out = new Array(k.length).fill(null);
  if (k.length < length + 1) return out;
  const trs = [];
  for (let i = 1; i < k.length; i++) {
    const tr1 = k[i].high - k[i].low;
    const tr2 = Math.abs(k[i].high - k[i - 1].close);
    const tr3 = Math.abs(k[i].low - k[i - 1].close);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  let atr = trs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length] = atr;
  for (let i = length + 1; i < k.length; i++) {
    atr = (atr * (length - 1) + trs[i - 1]) / length;
    out[i] = atr;
  }
  return out;
}

function computeEMASeries(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let ema = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = ema;
  for (let i = length; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function findPivotsHistorical(k, pivotLen) {
  const pivots = [];
  for (let i = pivotLen; i < k.length - pivotLen; i++) {
    let isH = true, isL = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j === i) continue;
      if (k[j].high >= k[i].high) isH = false;
      if (k[j].low <= k[i].low) isL = false;
    }
    if (isH) pivots.push({ index: i, type: 'H', price: k[i].high, confirmedAt: i + pivotLen });
    if (isL) pivots.push({ index: i, type: 'L', price: k[i].low, confirmedAt: i + pivotLen });
  }
  return pivots;
}

function computeWeeklyContext(k4h, k1w) {
  const wCloses = k1w.map(k => k.close);
  const wEmaArr = computeEMASeries(wCloses, CONFIG.CTX_EMA_LEN);
  const wTimesEnd = k1w.map(k => k.time + 7 * 24 * 60 * 60 * 1000);
  const weeklyCloseAt = new Array(k4h.length).fill(null);
  const weeklyEmaAt = new Array(k4h.length).fill(null);
  let wIdx = 0;
  for (let i = 0; i < k4h.length; i++) {
    const t = k4h[i].time;
    while (wIdx + 1 < k1w.length && wTimesEnd[wIdx + 1] <= t) wIdx++;
    if (wTimesEnd[wIdx] <= t && wEmaArr[wIdx] !== null) {
      weeklyCloseAt[i] = k1w[wIdx].close;
      weeklyEmaAt[i] = wEmaArr[wIdx];
    }
  }
  return { weeklyCloseAt, weeklyEmaAt };
}

// ============================================================
// SWEEP DETECTION
// ============================================================
// Для каждого pivot (H или L) ищем: был ли sweep — т.е. цена пробила pivot
// ВРЕМЕННО (в течение 1-3 баров) и вернулась обратно.
// Возвращает массив sweep-событий
function findSweeps(k, pivots, atrArr) {
  const sweeps = [];

  for (const piv of pivots) {
    // Ищем sweep для pivot High (SELL сценарий)
    if (piv.type === 'H') {
      // После подтверждения pivot ищем бар где high > piv.price
      for (let i = piv.confirmedAt; i < Math.min(piv.confirmedAt + CONFIG.MAX_AGE_BARS, k.length); i++) {
        const bar = k[i];
        if (bar.high > piv.price) {
          const atr = atrArr[i];
          if (atr === null) continue;

          // Проверяем что sweep не слишком глубокий
          const sweepDepth = bar.high - piv.price;
          if (sweepDepth > atr * CONFIG.MAX_SWEEP_DEPTH_ATR) break; // слишком глубоко = реальный пробой

          // Ищем возврат в течение SWEEP_RETURN_BARS
          let returnedIdx = -1;
          let sweepHigh = bar.high;
          for (let j = i; j < Math.min(i + CONFIG.SWEEP_RETURN_BARS, k.length); j++) {
            if (k[j].high > sweepHigh) sweepHigh = k[j].high;
            if (k[j].close < piv.price) {
              returnedIdx = j;
              break;
            }
          }

          if (returnedIdx >= 0) {
            // Sweep валидный — фиксируем
            sweeps.push({
              pivot: piv,
              direction: 'SELL',
              sweepStartIdx: i,
              sweepEndIdx: returnedIdx,
              sweepHigh,
              entryPrice: k[returnedIdx].close,
              entryBar: returnedIdx,
            });
          }
          break; // рассматриваем только первый sweep этого pivot
        }
        // Если цена сильно упала ниже — pivot устарел, не ждём sweep
        if (bar.low < piv.price * 0.9) break;
      }
    }

    // Pivot Low → sweep вниз → BUY scenario
    if (piv.type === 'L') {
      for (let i = piv.confirmedAt; i < Math.min(piv.confirmedAt + CONFIG.MAX_AGE_BARS, k.length); i++) {
        const bar = k[i];
        if (bar.low < piv.price) {
          const atr = atrArr[i];
          if (atr === null) continue;

          const sweepDepth = piv.price - bar.low;
          if (sweepDepth > atr * CONFIG.MAX_SWEEP_DEPTH_ATR) break;

          let returnedIdx = -1;
          let sweepLow = bar.low;
          for (let j = i; j < Math.min(i + CONFIG.SWEEP_RETURN_BARS, k.length); j++) {
            if (k[j].low < sweepLow) sweepLow = k[j].low;
            if (k[j].close > piv.price) {
              returnedIdx = j;
              break;
            }
          }

          if (returnedIdx >= 0) {
            sweeps.push({
              pivot: piv,
              direction: 'BUY',
              sweepStartIdx: i,
              sweepEndIdx: returnedIdx,
              sweepLow,
              entryPrice: k[returnedIdx].close,
              entryBar: returnedIdx,
            });
          }
          break;
        }
        if (bar.high > piv.price * 1.1) break;
      }
    }
  }

  return sweeps;
}

// Найти L1 (предшествующий low) для H1 sweep — для расчёта TP
function findTargetAfterPivot(pivots, piv, minMovePct) {
  // Для H1 ищем L1 (pivotLow) ПОСЛЕ pivot.index но ДО sweep
  const targetType = piv.type === 'H' ? 'L' : 'H';

  for (let i = 0; i < pivots.length; i++) {
    const p = pivots[i];
    if (p.index <= piv.index) continue;
    if (p.type !== targetType) continue;

    const movePct = piv.type === 'H'
      ? (piv.price - p.price) / piv.price * 100
      : (p.price - piv.price) / piv.price * 100;

    if (movePct >= minMovePct) return p;
  }
  return null;
}

// ============================================================
// SIMULATION
// ============================================================
function simulateTicker(symbol, k4h, k1w) {
  if (k4h.length < 250 || k1w.length < 55) return { trades: [] };

  const atrArr = computeATRSeries(k4h, CONFIG.ATR_LEN);
  const { weeklyCloseAt, weeklyEmaAt } = computeWeeklyContext(k4h, k1w);

  const allPivots = findPivotsHistorical(k4h, CONFIG.PIVOT_LEN);
  const sweeps = findSweeps(k4h, allPivots, atrArr);

  // Фильтруем sweeps по контексту и находим target (L1 для SELL, H1 для BUY)
  const validSweeps = [];
  for (const sweep of sweeps) {
    const i = sweep.entryBar;
    const wClose = weeklyCloseAt[i];
    const wEma = weeklyEmaAt[i];
    if (wClose === null || wEma === null) continue;

    const isLong = sweep.direction === 'BUY';
    const weeklyOk = isLong ? wClose > wEma : wClose < wEma;
    if (!weeklyOk) continue;

    // Find target pivot (the opposite-type pivot that preceded sweep and defines the range)
    // For H1 sweep: L1 нужен ПЕРЕД sweep (anchor на H1, target на L1)
    // Ищем pivot противоположного типа после pivot.index но до sweep
    let target = null;
    const targetType = sweep.pivot.type === 'H' ? 'L' : 'H';
    let bestMove = 0;
    for (const p of allPivots) {
      if (p.index <= sweep.pivot.index) continue;
      if (p.index >= sweep.sweepStartIdx) break;
      if (p.type !== targetType) continue;
      const movePct = sweep.pivot.type === 'H'
        ? (sweep.pivot.price - p.price) / sweep.pivot.price * 100
        : (p.price - sweep.pivot.price) / sweep.pivot.price * 100;
      if (movePct >= CONFIG.MIN_MOVE_PCT && movePct > bestMove) {
        target = p;
        bestMove = movePct;
      }
    }
    if (!target) continue;

    sweep.target = target;
    validSweeps.push(sweep);
  }

  // Сортируем по времени входа
  validSweeps.sort((a, b) => a.entryBar - b.entryBar);

  const trades = [];
  let openPos = null;

  for (const sweep of validSweeps) {
    const i = sweep.entryBar;
    if (openPos) {
      // проверяем позицию до точки этого сигнала
      while (openPos && openPos.status === 'open') {
        const bar = k4h[openPos.currentBar];
        updatePos(openPos, bar, trades);
        if (openPos.status === 'closed') {
          openPos = null;
          break;
        }
        openPos.currentBar++;
        if (openPos.currentBar >= k4h.length) {
          closeRemaining(openPos, k4h[k4h.length - 1], 'eof');
          trades.push(openPos);
          openPos = null;
          break;
        }
        if (openPos.currentBar >= i) break;
      }
    }
    if (openPos) continue;

    const atr = atrArr[i];
    if (atr === null) continue;

    // Построение SL/TP
    const bar = k4h[i];
    const range = Math.abs(sweep.pivot.price - sweep.target.price);
    let entry, sl, tp1, tp2, tp3;
    if (sweep.direction === 'SELL') {
      entry = sweep.entryPrice * (1 - CONFIG.SLIPPAGE_PCT / 100);
      sl = sweep.sweepHigh + atr * CONFIG.SL_BUFFER_ATR;
      tp1 = sweep.target.price + range * CONFIG.FIB_EQ;
      tp2 = sweep.target.price;
      tp3 = sweep.target.price + range * CONFIG.FIB_TP3;
    } else {
      entry = sweep.entryPrice * (1 + CONFIG.SLIPPAGE_PCT / 100);
      sl = sweep.sweepLow - atr * CONFIG.SL_BUFFER_ATR;
      tp1 = sweep.target.price - range * CONFIG.FIB_EQ;
      tp2 = sweep.target.price;
      tp3 = sweep.target.price - range * CONFIG.FIB_TP3;
    }

    const riskPerUnit = Math.abs(entry - sl);
    if (riskPerUnit <= 0) continue;

    // Разумность R:R — не открываем если tp1 ближе стопа
    const tp1Dist = Math.abs(tp1 - entry);
    if (tp1Dist < riskPerUnit * 0.5) continue; // TP1 должен быть хотя бы 0.5R

    openPos = {
      symbol, direction: sweep.direction,
      openBar: i, openTime: bar.time, currentBar: i + 1,
      entry, originalSL: sl, currentSL: sl,
      tp1, tp2, tp3,
      riskPerUnit, atr,
      pivotH1: sweep.pivot.type === 'H' ? sweep.pivot.price : sweep.target.price,
      pivotL1: sweep.pivot.type === 'L' ? sweep.pivot.price : sweep.target.price,
      sweepHigh: sweep.sweepHigh,
      sweepLow: sweep.sweepLow,
      status: 'open', fills: [],
      tp1Hit: false, tp2Hit: false,
    };
  }

  // Закрыть оставшуюся позицию
  if (openPos && openPos.status === 'open') {
    while (openPos.currentBar < k4h.length && openPos.status === 'open') {
      updatePos(openPos, k4h[openPos.currentBar], trades);
      openPos.currentBar++;
    }
    if (openPos.status === 'open') {
      closeRemaining(openPos, k4h[k4h.length - 1], 'eof');
      trades.push(openPos);
    }
  }

  return { trades };
}

function updatePos(pos, bar, trades) {
  const { high, low } = bar;

  // SL first
  const slHit = pos.direction === 'SELL' ? high >= pos.currentSL : low <= pos.currentSL;
  if (slHit) {
    const reason = pos.currentSL === pos.originalSL ? 'stop' : 'be';
    closeRemaining(pos, bar, reason, pos.currentSL);
    trades.push(pos);
    return;
  }

  // TP1
  if (!pos.tp1Hit) {
    const tp1Hit = pos.direction === 'SELL' ? low <= pos.tp1 : high >= pos.tp1;
    if (tp1Hit) {
      recordFill(pos, CONFIG.TP1_FRACTION, pos.tp1, 'tp1');
      pos.tp1Hit = true;
      if (CONFIG.MOVE_TO_BE_AFTER_TP1) pos.currentSL = pos.entry;
    }
  }

  // TP2
  if (!pos.tp2Hit) {
    const tp2Hit = pos.direction === 'SELL' ? low <= pos.tp2 : high >= pos.tp2;
    if (tp2Hit) {
      recordFill(pos, CONFIG.TP2_FRACTION, pos.tp2, 'tp2');
      pos.tp2Hit = true;
    }
  }

  // TP3
  const tp3Hit = pos.direction === 'SELL' ? low <= pos.tp3 : high >= pos.tp3;
  if (tp3Hit) {
    closeRemaining(pos, bar, 'tp3', pos.tp3);
    trades.push(pos);
  }
}

function recordFill(pos, fraction, price, reason) {
  const pnlPerUnit = pos.direction === 'SELL' ? (pos.entry - price) : (price - pos.entry);
  const pnlR = (pnlPerUnit / pos.riskPerUnit) * fraction;
  const comm = 2 * CONFIG.COMMISSION_PCT / 100 * fraction;
  pos.fills.push({ reason, price, fraction, pnlR: pnlR - comm });
}

function closeRemaining(pos, bar, reason, price) {
  const done = pos.fills.reduce((s, f) => s + f.fraction, 0);
  const rem = 1 - done;
  if (rem > 0.0001) {
    const closePrice = price !== undefined ? price : bar.close;
    const pnlPerUnit = pos.direction === 'SELL' ? (pos.entry - closePrice) : (closePrice - pos.entry);
    const pnlR = (pnlPerUnit / pos.riskPerUnit) * rem;
    const comm = 2 * CONFIG.COMMISSION_PCT / 100 * rem;
    pos.fills.push({ reason, price: closePrice, fraction: rem, pnlR: pnlR - comm });
  }
  pos.status = 'closed';
  pos.closeTime = bar.time;
  pos.closeReason = reason;
  pos.totalR = pos.fills.reduce((s, f) => s + f.pnlR, 0);
}

// ============================================================
// PORTFOLIO
// ============================================================
function simulatePortfolio(allTrades) {
  allTrades.sort((a, b) => a.openTime - b.openTime);
  let balance = CONFIG.START_BALANCE;
  let peak = balance;
  let maxDD = 0;
  const open = [];
  const equity = [{ time: allTrades[0]?.openTime || Date.now(), balance }];
  const executed = [], skipped = [];

  for (const t of allTrades) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].closeTime <= t.openTime) {
        const p = open[i];
        balance += p.riskUsd * p.totalR;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        equity.push({ time: p.closeTime, balance });
        open.splice(i, 1);
      }
    }
    if (open.length >= CONFIG.MAX_CONCURRENT) {
      skipped.push(t);
      continue;
    }
    t.riskUsd = balance * CONFIG.RISK_PCT / 100;
    open.push(t);
    executed.push(t);
  }
  for (const p of open) {
    balance += p.riskUsd * p.totalR;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    equity.push({ time: p.closeTime, balance });
  }
  return { balance, maxDD, equityPoints: equity, executed, skipped };
}

// ============================================================
// STATS
// ============================================================
function computeStats(trades) {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.totalR > 0);
  const losses = trades.filter(t => t.totalR <= 0);
  const totalR = trades.reduce((s, t) => s + t.totalR, 0);
  const avgR = totalR / trades.length;
  const winrate = wins.length / trades.length * 100;
  const gW = wins.reduce((s, t) => s + t.totalR, 0);
  const gL = Math.abs(losses.reduce((s, t) => s + t.totalR, 0));
  const pf = gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0);
  const avgW = wins.length > 0 ? gW / wins.length : 0;
  const avgL = losses.length > 0 ? gL / losses.length : 0;
  return { count: trades.length, wins: wins.length, losses: losses.length, winrate, totalR, avgR, avgWin: avgW, avgLoss: avgL, pf };
}

function statsByDirection(trades) {
  return {
    BUY: computeStats(trades.filter(t => t.direction === 'BUY')),
    SELL: computeStats(trades.filter(t => t.direction === 'SELL')),
  };
}

function statsByReason(trades) {
  const r = {};
  for (const t of trades) r[t.closeReason] = (r[t.closeReason] || 0) + 1;
  return r;
}

// ============================================================
// HTML
// ============================================================
function fmtR(r) { return r === null ? '-' : (r >= 0 ? '+' : '') + r.toFixed(2) + 'R'; }
function fmtPct(p) { return p === null ? '-' : p.toFixed(1) + '%'; }
function fmtUSD(v) { return '$' + v.toFixed(2); }
function fmtDate(ts) { return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); }

function renderStatsRow(name, s) {
  if (!s) return `<tr><td>${name}</td><td colspan="8" class="empty">Нет сделок</td></tr>`;
  const rClass = s.avgR >= 0 ? 'pnl-win' : 'pnl-loss';
  const wrClass = s.winrate >= 50 ? 'pnl-win' : s.winrate >= 40 ? 'pnl-neutral' : 'pnl-loss';
  const pfClass = s.pf >= 1.5 ? 'pnl-win' : s.pf >= 1 ? 'pnl-neutral' : 'pnl-loss';
  return `<tr>
    <td><b>${name}</b></td>
    <td class="num">${s.count}</td>
    <td class="num ${wrClass}">${fmtPct(s.winrate)}</td>
    <td class="num ${rClass}">${fmtR(s.totalR)}</td>
    <td class="num ${rClass}">${fmtR(s.avgR)}</td>
    <td class="num">${fmtR(s.avgWin)}</td>
    <td class="num">${fmtR(-s.avgLoss)}</td>
    <td class="num ${pfClass}">${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}</td>
  </tr>`;
}

function renderEquitySVG(points) {
  if (points.length < 2) return '';
  const w = 900, h = 300;
  const minB = Math.min(...points.map(p => p.balance));
  const maxB = Math.max(...points.map(p => p.balance));
  const minT = points[0].time;
  const maxT = points[points.length - 1].time;
  const pts = points.map(p => {
    const x = (p.time - minT) / (maxT - minT) * (w - 50) + 30;
    const y = h - 30 - (p.balance - minB) / (maxB - minB) * (h - 60);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = h - 30 - (CONFIG.START_BALANCE - minB) / (maxB - minB) * (h - 60);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;background:#111827;border-radius:8px;margin:20px 0">
    <line x1="30" y1="${zeroY}" x2="${w - 20}" y2="${zeroY}" stroke="#6b7280" stroke-width="1" stroke-dasharray="4 4"/>
    <polyline points="${pts}" fill="none" stroke="#10b981" stroke-width="2"/>
    <text x="35" y="${zeroY - 5}" fill="#6b7280" font-size="11">Start $${CONFIG.START_BALANCE}</text>
    <text x="35" y="20" fill="#9ca3af" font-size="12">Max: $${maxB.toFixed(0)}</text>
    <text x="35" y="${h - 10}" fill="#9ca3af" font-size="12">Min: $${minB.toFixed(0)}</text>
    <text x="${w - 200}" y="20" fill="#9ca3af" font-size="12">Final: $${points[points.length - 1].balance.toFixed(0)}</text>
  </svg>`;
}

function renderHTML(data) {
  const { portfolio, statsAll, statsDir, reasonBreakdown, symbolsUsed, executedCount, skippedCount } = data;
  const pnlUsd = portfolio.balance - CONFIG.START_BALANCE;
  const pnlPct = pnlUsd / CONFIG.START_BALANCE * 100;
  const pnlColor = pnlUsd >= 0 ? '#10b981' : '#ef4444';
  const top10W = [...portfolio.executed].sort((a, b) => b.totalR - a.totalR).slice(0, 10);
  const top10L = [...portfolio.executed].sort((a, b) => a.totalR - b.totalR).slice(0, 10);

  const wRows = top10W.map(t => `<tr>
    <td>${t.symbol}</td>
    <td><span class="badge" style="background:${t.direction === 'BUY' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num pnl-win">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const lRows = top10L.map(t => `<tr>
    <td>${t.symbol}</td>
    <td><span class="badge" style="background:${t.direction === 'BUY' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num pnl-loss">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const reasonRows = Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1])
    .map(([r, c]) => `<tr><td>${r}</td><td class="num">${c}</td><td class="num">${fmtPct(c / portfolio.executed.length * 100)}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 Sweep Backtest</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px;max-width:1200px;margin-left:auto;margin-right:auto}
  h1{color:#fff;font-size:24px;margin:0 0 10px 0}h1 span{color:#6b7280;font-weight:400;font-size:14px}
  h2{color:#e5e7eb;font-size:18px;margin:30px 0 10px 0;padding-bottom:8px;border-bottom:1px solid #374151}
  .meta{color:#9ca3af;font-size:13px;margin-bottom:20px}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:20px 0}
  .card{background:#1f2937;padding:14px;border-radius:8px;border:1px solid #374151}
  .card b{color:#fff;font-size:24px;display:block}.card span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  .card.big{grid-column:span 2;background:linear-gradient(135deg,#1f2937,#111827)}.card.big b{font-size:32px}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px;margin:10px 0}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151}
  td{padding:9px 8px;border-bottom:1px solid #1f2937}tr:hover{background:#1a2332}
  .num{text-align:right;font-variant-numeric:tabular-nums}.time{color:#6b7280;font-size:12px}
  .pnl-win{color:#10b981;font-weight:600}.pnl-loss{color:#ef4444;font-weight:600}.pnl-neutral{color:#fbbf24}
  .empty{color:#6b7280;text-align:center;font-style:italic}
  .badge{color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .warn{background:#422006;padding:12px;border-radius:6px;color:#fbbf24;font-size:13px;margin:15px 0;border-left:3px solid #fbbf24}
</style></head><body>
<h1>AK88 Sweep (Liquidity Grab) Backtest <span>· ${CONFIG.YEARS_BACK} года · top-${CONFIG.TOP_SYMBOLS}</span></h1>
<div class="meta">
  ${symbolsUsed} тикеров · ${portfolio.executed.length} сделок (${executedCount} исполнены, ${skippedCount} пропущены из-за лимита ${CONFIG.MAX_CONCURRENT})<br>
  Комиссия: ${CONFIG.COMMISSION_PCT}%×2 · Slippage: ${CONFIG.SLIPPAGE_PCT}% · Риск: ${CONFIG.RISK_PCT}% · BE после TP1: ${CONFIG.MOVE_TO_BE_AFTER_TP1 ? 'да' : 'нет'}
</div>

<div class="warn">⚠️ Sweep стратегия: вход ПОСЛЕ пробоя H1/L1 с возвратом в зону (stop hunt). Детекция sweep параметризована — может overfit'иться.</div>

<h2>📊 Итоги портфеля</h2>
<div class="summary">
  <div class="card big"><b style="color:${pnlColor}">${fmtUSD(portfolio.balance)}</b><span>Итоговый баланс (старт ${fmtUSD(CONFIG.START_BALANCE)})</span></div>
  <div class="card"><b style="color:${pnlColor}">${pnlUsd >= 0 ? '+' : ''}${fmtUSD(pnlUsd)}</b><span>P&amp;L total</span></div>
  <div class="card"><b style="color:${pnlColor}">${pnlPct >= 0 ? '+' : ''}${fmtPct(pnlPct)}</b><span>P&amp;L %</span></div>
  <div class="card"><b style="color:#ef4444">-${fmtPct(portfolio.maxDD)}</b><span>Max Drawdown</span></div>
  <div class="card"><b>${statsAll ? fmtPct(statsAll.winrate) : '-'}</b><span>Winrate</span></div>
  <div class="card"><b>${statsAll && statsAll.pf !== Infinity ? statsAll.pf.toFixed(2) : '∞'}</b><span>Profit Factor</span></div>
  <div class="card"><b style="color:${statsAll && statsAll.avgR >= 0 ? '#10b981' : '#ef4444'}">${statsAll ? fmtR(statsAll.avgR) : '-'}</b><span>Avg per trade</span></div>
</div>

<h2>📈 Equity curve</h2>
${renderEquitySVG(portfolio.equityPoints)}

<h2>🎯 Статистика</h2>
<table><thead><tr><th>Группа</th><th>Сделок</th><th>Winrate</th><th>Total R</th><th>Avg R</th><th>Avg Win</th><th>Avg Loss</th><th>PF</th></tr></thead><tbody>
${renderStatsRow('Все сделки', statsAll)}
${renderStatsRow('BUY', statsDir.BUY)}
${renderStatsRow('SELL', statsDir.SELL)}
</tbody></table>

<h2>📋 Исходы сделок</h2>
<table><thead><tr><th>Исход</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${reasonRows}</tbody></table>

<h2>🏆 Топ-10 прибыльных</h2>
<table><thead><tr><th>Символ</th><th>Напр</th><th>R</th><th>Период</th><th>Исход</th></tr></thead><tbody>${wRows}</tbody></table>

<h2>💀 Топ-10 убыточных</h2>
<table><thead><tr><th>Символ</th><th>Напр</th><th>R</th><th>Период</th><th>Исход</th></tr></thead><tbody>${lRows}</tbody></table>

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Sweep params: pivot ${CONFIG.PIVOT_LEN}, min impulse ${CONFIG.MIN_MOVE_PCT}%, max sweep depth ${CONFIG.MAX_SWEEP_DEPTH_ATR}×ATR, return within ${CONFIG.SWEEP_RETURN_BARS} bars<br>
  SL buffer: ${CONFIG.SL_BUFFER_ATR}×ATR · TP1 eq(${CONFIG.FIB_EQ}), TP2 target, TP3 ext(${CONFIG.FIB_TP3}) · Fractions ${CONFIG.TP1_FRACTION}/${CONFIG.TP2_FRACTION}/${CONFIG.TP3_FRACTION}<br>
  Выполнено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}
</div>
</body></html>`;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('AK88 Sweep Backtest');
  console.log('='.repeat(60));
  console.log(`Pivot ${CONFIG.PIVOT_LEN}, min impulse ${CONFIG.MIN_MOVE_PCT}%, sweep depth ≤ ${CONFIG.MAX_SWEEP_DEPTH_ATR}×ATR, return ≤ ${CONFIG.SWEEP_RETURN_BARS} bars`);
  console.log('');

  const symbols = await getTopSymbols();
  console.log(`[sw] symbols: ${symbols.length}`);

  const allTrades = [];
  let done = 0;
  for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
    const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
    const res = await Promise.all(batch.map(async (sym) => {
      try {
        const [k4h, k1w] = await Promise.all([
          loadOrFetch(sym, CONFIG.TIMEFRAME, CONFIG.YEARS_BACK, CONFIG.CACHE_DIR),
          loadOrFetch(sym, '1w', CONFIG.YEARS_BACK + 1, CONFIG.CACHE_DIR),
        ]);
        if (!k4h || !k1w) return { symbol: sym, trades: [] };
        const { trades } = simulateTicker(sym, k4h, k1w);
        return { symbol: sym, trades };
      } catch (e) {
        return { symbol: sym, trades: [] };
      }
    }));
    for (const r of res) {
      done++;
      console.log(`[sw] ${done}/${symbols.length} ${r.symbol}: ${r.trades.length} trades`);
      allTrades.push(...r.trades);
    }
  }

  console.log(`\n[sw] total: ${allTrades.length}`);
  if (allTrades.length === 0) {
    console.log('[sw] no trades');
    return;
  }

  const portfolio = simulatePortfolio(allTrades);
  const statsAll = computeStats(portfolio.executed);
  const statsDir = statsByDirection(portfolio.executed);
  const reasonBreakdown = statsByReason(portfolio.executed);

  const html = renderHTML({
    portfolio, statsAll, statsDir, reasonBreakdown,
    symbolsUsed: symbols.length,
    executedCount: portfolio.executed.length,
    skippedCount: portfolio.skipped.length,
  });

  await fs.writeFile(CONFIG.REPORT_FILE, html, 'utf-8');
  console.log('');
  console.log(`[sw] ✅ report: ${CONFIG.REPORT_FILE}`);
  console.log(`[sw] winrate: ${statsAll.winrate.toFixed(1)}% | avgR: ${statsAll.avgR.toFixed(2)} | PF: ${statsAll.pf.toFixed(2)}`);
  console.log(`[sw] final: $${portfolio.balance.toFixed(2)} (${((portfolio.balance - CONFIG.START_BALANCE) / CONFIG.START_BALANCE * 100).toFixed(1)}%)`);
  console.log(`[sw] max DD: ${portfolio.maxDD.toFixed(2)}%`);
}

main().catch(e => {
  console.error('[sw] fatal:', e);
  process.exit(1);
});
