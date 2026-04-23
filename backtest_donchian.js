// ============================================================
// AK88 Donchian Backtest — Turtle-style Trend Following
// Classic: Entry Donchian(20) / Exit Donchian(10) / 4H
// Reuses cached data from AZLS backtest
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // Data
  YEARS_BACK: 2,
  TOP_SYMBOLS: 30,
  TIMEFRAME: '4h',

  // Donchian params
  ENTRY_PERIOD: 20,      // пробой high/low за N баров — вход
  EXIT_PERIOD: 10,       // пробой обратной стороны за N баров — выход
  ATR_LEN: 14,
  STOP_ATR_MULT: 2.0,    // стоп = 2 × ATR от входа

  // Optional trend filter
  USE_TREND_FILTER: true,
  TREND_EMA: 200,        // long только если close > EMA200

  // Risk
  START_BALANCE: 10000,
  RISK_PCT: 1.0,
  MAX_CONCURRENT: 5,
  COMMISSION_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,

  // API
  BINANCE: 'https://fapi.binance.com',
  KLINES_LIMIT: 1000,
  CONCURRENCY: 5,

  // Paths
  REPORT_FILE: path.join(__dirname, 'donchian_report.html'),
  CACHE_DIR: path.join(__dirname, 'backtest_cache'),
};

// ============================================================
// DATA
// ============================================================
async function getTopSymbols() {
  console.log('[dch] fetching top symbols...');
  const r = await fetch(`${CONFIG.BINANCE}/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`ticker failed: ${r.status}`);
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

async function fetchAllKlines(symbol, interval, years) {
  const now = Date.now();
  const startTarget = now - years * 365 * 24 * 60 * 60 * 1000;
  const all = [];
  let endTime = now;

  for (let iter = 0; iter < 20; iter++) {
    const page = await fetchKlinesPage(symbol, interval, endTime, CONFIG.KLINES_LIMIT);
    if (!page || page.length === 0) break;
    all.push(...page);
    const oldest = page[0].time;
    if (oldest <= startTarget) break;
    endTime = oldest - 1;
    await new Promise(r => setTimeout(r, 100));
  }

  const seen = new Set();
  const unique = all.filter(k => !seen.has(k.time) && seen.add(k.time));
  unique.sort((a, b) => a.time - b.time);
  return unique.filter(k => k.time >= startTarget);
}

async function loadOrFetch(symbol, interval, years, cacheDir) {
  const cacheFile = path.join(cacheDir, `${symbol}_${interval}_${years}y.json`);
  try {
    const raw = await fs.readFile(cacheFile, 'utf-8');
    const cached = JSON.parse(raw);
    const ageMs = Date.now() - cached[cached.length - 1].time;
    if (ageMs < 24 * 60 * 60 * 1000) return cached;
  } catch (e) {}

  const data = await fetchAllKlines(symbol, interval, years);
  if (data && data.length > 0) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(data), 'utf-8');
  }
  return data;
}

// ============================================================
// INDICATORS
// ============================================================
function computeDonchianSeries(klines, period) {
  const upper = new Array(klines.length).fill(null);
  const lower = new Array(klines.length).fill(null);
  for (let i = period; i < klines.length; i++) {
    let maxH = -Infinity, minL = Infinity;
    for (let j = i - period; j < i; j++) {   // пред. N баров (не включая текущий)
      if (klines[j].high > maxH) maxH = klines[j].high;
      if (klines[j].low < minL) minL = klines[j].low;
    }
    upper[i] = maxH;
    lower[i] = minL;
  }
  return { upper, lower };
}

function computeATRSeries(klines, length) {
  const out = new Array(klines.length).fill(null);
  if (klines.length < length + 1) return out;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const tr1 = klines[i].high - klines[i].low;
    const tr2 = Math.abs(klines[i].high - klines[i - 1].close);
    const tr3 = Math.abs(klines[i].low - klines[i - 1].close);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  let atr = trs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length] = atr;
  for (let i = length + 1; i < klines.length; i++) {
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

// ============================================================
// BACKTEST
// ============================================================
function simulateTicker(symbol, k) {
  const needed = Math.max(CONFIG.ENTRY_PERIOD, CONFIG.TREND_EMA) + 50;
  if (k.length < needed) return { trades: [] };

  const entryDon = computeDonchianSeries(k, CONFIG.ENTRY_PERIOD);
  const exitDon = computeDonchianSeries(k, CONFIG.EXIT_PERIOD);
  const atrArr = computeATRSeries(k, CONFIG.ATR_LEN);
  const closes = k.map(b => b.close);
  const emaArr = computeEMASeries(closes, CONFIG.TREND_EMA);

  const trades = [];
  let pos = null;
  const startBar = needed;

  for (let i = startBar; i < k.length; i++) {
    const bar = k[i];

    // 1. Update open position
    if (pos) {
      const { high, low } = bar;

      // Stop loss check
      const slHit = pos.direction === 'LONG' ? low <= pos.sl : high >= pos.sl;
      if (slHit) {
        closePos(pos, bar, 'stop', pos.sl);
        trades.push(pos);
        pos = null;
        continue;
      }

      // Donchian exit check (trailing)
      if (pos.direction === 'LONG') {
        const exitLow = exitDon.lower[i];
        if (exitLow !== null && low <= exitLow) {
          closePos(pos, bar, 'donchian_exit', exitLow);
          trades.push(pos);
          pos = null;
          continue;
        }
      } else {
        const exitHigh = exitDon.upper[i];
        if (exitHigh !== null && high >= exitHigh) {
          closePos(pos, bar, 'donchian_exit', exitHigh);
          trades.push(pos);
          pos = null;
          continue;
        }
      }
    }

    if (pos) continue;

    // 2. Check for new entry signal
    const eUpper = entryDon.upper[i];
    const eLower = entryDon.lower[i];
    const atr = atrArr[i];
    const ema = emaArr[i];

    if (eUpper === null || eLower === null || atr === null) continue;

    // Long signal: breakout above 20-bar high
    const longSignal = bar.high > eUpper;
    // Short signal: breakdown below 20-bar low
    const shortSignal = bar.low < eLower;

    // Trend filter
    let canLong = longSignal;
    let canShort = shortSignal;
    if (CONFIG.USE_TREND_FILTER && ema !== null) {
      canLong = longSignal && bar.close > ema;
      canShort = shortSignal && bar.close < ema;
    }

    if (canLong) {
      const slippageMult = 1 + CONFIG.SLIPPAGE_PCT / 100;
      const entry = eUpper * slippageMult;
      const sl = entry - atr * CONFIG.STOP_ATR_MULT;
      const riskPerUnit = entry - sl;
      pos = {
        symbol, direction: 'LONG',
        openTime: bar.time, openBar: i,
        entry, sl, riskPerUnit, atr,
        status: 'open', fills: [],
      };
    } else if (canShort) {
      const slippageMult = 1 - CONFIG.SLIPPAGE_PCT / 100;
      const entry = eLower * slippageMult;
      const sl = entry + atr * CONFIG.STOP_ATR_MULT;
      const riskPerUnit = sl - entry;
      pos = {
        symbol, direction: 'SHORT',
        openTime: bar.time, openBar: i,
        entry, sl, riskPerUnit, atr,
        status: 'open', fills: [],
      };
    }
  }

  // Close remaining
  if (pos && pos.status === 'open') {
    closePos(pos, k[k.length - 1], 'eof', k[k.length - 1].close);
    trades.push(pos);
  }

  return { trades };
}

function closePos(pos, bar, reason, price) {
  const pnlPerUnit = pos.direction === 'LONG' ? price - pos.entry : pos.entry - price;
  const pnlR = pnlPerUnit / pos.riskPerUnit;
  const comm = 2 * CONFIG.COMMISSION_PCT / 100;
  pos.totalR = pnlR - comm;
  pos.status = 'closed';
  pos.closeTime = bar.time;
  pos.closeReason = reason;
  pos.closePrice = price;
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
  const executed = [];
  const skipped = [];

  for (const t of allTrades) {
    // Close expired positions
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
  const grossWin = wins.reduce((s, t) => s + t.totalR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.totalR, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  return { count: trades.length, wins: wins.length, losses: losses.length, winrate, totalR, avgR, avgWin, avgLoss, pf };
}

function statsByDirection(trades) {
  return {
    LONG: computeStats(trades.filter(t => t.direction === 'LONG')),
    SHORT: computeStats(trades.filter(t => t.direction === 'SHORT')),
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
  const wrClass = s.winrate >= 50 ? 'pnl-win' : s.winrate >= 35 ? 'pnl-neutral' : 'pnl-loss';
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
    <td><span class="badge" style="background:${t.direction === 'LONG' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num pnl-win">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const lRows = top10L.map(t => `<tr>
    <td>${t.symbol}</td>
    <td><span class="badge" style="background:${t.direction === 'LONG' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num pnl-loss">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const reasonRows = Object.entries(reasonBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([r, c]) => `<tr><td>${r}</td><td class="num">${c}</td><td class="num">${fmtPct(c / portfolio.executed.length * 100)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 Donchian Backtest</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px;max-width:1200px;margin-left:auto;margin-right:auto}
  h1{color:#fff;font-size:24px;margin:0 0 10px 0}
  h1 span{color:#6b7280;font-weight:400;font-size:14px}
  h2{color:#e5e7eb;font-size:18px;margin:30px 0 10px 0;padding-bottom:8px;border-bottom:1px solid #374151}
  .meta{color:#9ca3af;font-size:13px;margin-bottom:20px}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:20px 0}
  .card{background:#1f2937;padding:14px;border-radius:8px;border:1px solid #374151}
  .card b{color:#fff;font-size:24px;display:block}
  .card span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  .card.big{grid-column:span 2;background:linear-gradient(135deg,#1f2937,#111827)}
  .card.big b{font-size:32px}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px;margin:10px 0}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151}
  td{padding:9px 8px;border-bottom:1px solid #1f2937}
  tr:hover{background:#1a2332}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .time{color:#6b7280;font-size:12px}
  .pnl-win{color:#10b981;font-weight:600}
  .pnl-loss{color:#ef4444;font-weight:600}
  .pnl-neutral{color:#fbbf24}
  .empty{color:#6b7280;text-align:center;font-style:italic}
  .badge{color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .warn{background:#422006;padding:12px;border-radius:6px;color:#fbbf24;font-size:13px;margin:15px 0;border-left:3px solid #fbbf24}
</style></head><body>
<h1>AK88 Donchian Backtest <span>· Turtle Classic · Entry ${CONFIG.ENTRY_PERIOD} / Exit ${CONFIG.EXIT_PERIOD} / ${CONFIG.TIMEFRAME}</span></h1>
<div class="meta">
  ${symbolsUsed} тикеров · ${portfolio.executed.length} сделок (${executedCount} исполнены, ${skippedCount} пропущены из-за лимита ${CONFIG.MAX_CONCURRENT})<br>
  Stop: ${CONFIG.STOP_ATR_MULT}×ATR · Trend filter EMA${CONFIG.TREND_EMA}: ${CONFIG.USE_TREND_FILTER ? 'да' : 'нет'} · Комиссия: ${CONFIG.COMMISSION_PCT}%×2 · Slippage: ${CONFIG.SLIPPAGE_PCT}%
</div>

<div class="warn">Turtle Trend Following: пробой Donchian(${CONFIG.ENTRY_PERIOD}) → вход, пробой Donchian(${CONFIG.EXIT_PERIOD}) → выход. Стоп 2×ATR от входа.</div>

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
${renderStatsRow('LONG', statsDir.LONG)}
${renderStatsRow('SHORT', statsDir.SHORT)}
</tbody></table>

<h2>📋 Исходы сделок</h2>
<table><thead><tr><th>Исход</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${reasonRows}</tbody></table>

<h2>🏆 Топ-10 прибыльных</h2>
<table><thead><tr><th>Символ</th><th>Напр</th><th>R</th><th>Период</th><th>Исход</th></tr></thead><tbody>${wRows}</tbody></table>

<h2>💀 Топ-10 убыточных</h2>
<table><thead><tr><th>Символ</th><th>Напр</th><th>R</th><th>Период</th><th>Исход</th></tr></thead><tbody>${lRows}</tbody></table>

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Donchian Turtle System · ${CONFIG.YEARS_BACK} года ${CONFIG.TIMEFRAME} · top-${CONFIG.TOP_SYMBOLS} Binance USDT-M<br>
  Выполнено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}
</div>
</body></html>`;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('AK88 Donchian Turtle Backtest');
  console.log('='.repeat(60));
  console.log(`Entry: Donchian(${CONFIG.ENTRY_PERIOD}) | Exit: Donchian(${CONFIG.EXIT_PERIOD}) | ${CONFIG.TIMEFRAME}`);
  console.log(`Stop: ${CONFIG.STOP_ATR_MULT}×ATR | Trend filter: EMA${CONFIG.TREND_EMA} ${CONFIG.USE_TREND_FILTER ? 'ON' : 'OFF'}`);
  console.log('');

  const symbols = await getTopSymbols();
  console.log(`[dch] symbols: ${symbols.length}`);

  const allTrades = [];
  let done = 0;

  for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
    const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
    const res = await Promise.all(batch.map(async (sym) => {
      try {
        const k = await loadOrFetch(sym, CONFIG.TIMEFRAME, CONFIG.YEARS_BACK, CONFIG.CACHE_DIR);
        if (!k) return { symbol: sym, trades: [] };
        const { trades } = simulateTicker(sym, k);
        return { symbol: sym, trades };
      } catch (e) {
        return { symbol: sym, trades: [] };
      }
    }));
    for (const r of res) {
      done++;
      console.log(`[dch] ${done}/${symbols.length} ${r.symbol}: ${r.trades.length} trades`);
      allTrades.push(...r.trades);
    }
  }

  console.log(`\n[dch] total: ${allTrades.length} trades`);
  if (allTrades.length === 0) {
    console.log('[dch] no trades — exiting');
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
  console.log(`[dch] ✅ report saved: ${CONFIG.REPORT_FILE}`);
  console.log(`[dch] winrate: ${statsAll.winrate.toFixed(1)}% | avgR: ${statsAll.avgR.toFixed(2)} | PF: ${statsAll.pf.toFixed(2)}`);
  console.log(`[dch] final balance: $${portfolio.balance.toFixed(2)} (${((portfolio.balance - CONFIG.START_BALANCE) / CONFIG.START_BALANCE * 100).toFixed(1)}%)`);
  console.log(`[dch] max DD: ${portfolio.maxDD.toFixed(2)}%`);
}

main().catch(e => {
  console.error('[dch] fatal:', e);
  process.exit(1);
});
