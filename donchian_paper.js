// ============================================================
// AK88 Donchian Paper Trader
// Turtle-style: Entry Donchian(20) / Exit Donchian(10) / 4H
// Крипта, top-30, EMA200 trend filter
// ============================================================

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // Strategy
  TIMEFRAME: '4h',
  ENTRY_PERIOD: 20,
  EXIT_PERIOD: 10,
  ATR_LEN: 14,
  STOP_ATR_MULT: 2.0,
  USE_TREND_FILTER: true,
  TREND_EMA: 200,

  // Watchlist & filters
  TOP_SYMBOLS: 30,
  MAX_ATR_PCT: 10.0,        // пропускать монеты с ATR > 10% (скам)

  // Risk
  START_BALANCE: 10000,
  RISK_PCT: 1.0,
  MAX_CONCURRENT: 3,        // консервативно

  // Loops
  CONCURRENCY: 10,
  KLINES_4H_LIMIT: 500,
  CHECK_INTERVAL_MS: 10 * 60 * 1000,    // проверка сигналов: 10 мин
  TICK_INTERVAL_MS: 5 * 60 * 1000,      // проверка открытых: 5 мин

  // Storage
  STATE_FILE: path.join(__dirname, 'donchian_state.json'),
  BINANCE: 'https://fapi.binance.com',

  // Telegram
  TELEGRAM_TOKEN: '8629365441:AAEdKh0b_n57t0x_Gqv32n1VMvIH8WbLBkQ',
  TELEGRAM_CHAT_ID: '481990619',
  TELEGRAM_ENABLED: true,
};

// ============================================================
// STATE
// ============================================================
let state = {
  balance: CONFIG.START_BALANCE,
  startBalance: CONFIG.START_BALANCE,
  peakBalance: CONFIG.START_BALANCE,
  maxDrawdownPct: 0,
  createdAt: new Date().toISOString(),
  positions: [],
};

// ============================================================
// STORAGE
// ============================================================
async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.STATE_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    state = { ...state, ...loaded };
    console.log(`[dch] loaded: balance=$${state.balance.toFixed(2)}, positions=${state.positions.length}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[dch] no state, fresh start');
      await saveState();
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[dch] save error:', e.message);
  }
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_ENABLED) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text, parse_mode: 'HTML', disable_web_page_preview: true,
      }),
    });
    if (!r.ok) console.error('[dch][tg]', r.status, await r.text());
  } catch (e) {
    console.error('[dch][tg]', e.message);
  }
}

function fmtP(p) {
  if (!p) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

// ============================================================
// DATA
// ============================================================
async function getTopSymbols() {
  const r = await fetch(`${CONFIG.BINANCE}/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`ticker: ${r.status}`);
  const all = await r.json();
  return all
    .filter(s => s.symbol.endsWith('USDT') && !s.symbol.includes('_'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, CONFIG.TOP_SYMBOLS)
    .map(s => s.symbol);
}

async function getKlines(symbol, interval, limit) {
  const url = `${CONFIG.BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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
function highestN(k, start, end, field) {
  let m = -Infinity;
  for (let i = start; i < end; i++) if (k[i][field] > m) m = k[i][field];
  return m;
}
function lowestN(k, start, end, field) {
  let m = Infinity;
  for (let i = start; i < end; i++) if (k[i][field] < m) m = k[i][field];
  return m;
}

function computeATR(k, length) {
  if (k.length < length + 1) return null;
  const trs = [];
  for (let i = 1; i < k.length; i++) {
    const tr1 = k[i].high - k[i].low;
    const tr2 = Math.abs(k[i].high - k[i - 1].close);
    const tr3 = Math.abs(k[i].low - k[i - 1].close);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  let atr = trs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < trs.length; i++) {
    atr = (atr * (length - 1) + trs[i]) / length;
  }
  return atr;
}

function computeEMA(values, length) {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let ema = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// ============================================================
// SIGNAL DETECTION
// ============================================================
function detectSignal(k) {
  if (!k || k.length < Math.max(CONFIG.ENTRY_PERIOD, CONFIG.TREND_EMA) + 5) return null;
  const lastIdx = k.length - 1;
  const last = k[lastIdx];

  // Donchian за предыдущие N баров (не включая текущий)
  const entryUpper = highestN(k, lastIdx - CONFIG.ENTRY_PERIOD, lastIdx, 'high');
  const entryLower = lowestN(k, lastIdx - CONFIG.ENTRY_PERIOD, lastIdx, 'low');

  const atr = computeATR(k, CONFIG.ATR_LEN);
  if (atr === null) return null;

  // ATR filter — не торгуем монеты с дикими движениями
  const atrPct = atr / last.close * 100;
  if (atrPct > CONFIG.MAX_ATR_PCT) return null;

  const closes = k.map(b => b.close);
  const ema = computeEMA(closes, CONFIG.TREND_EMA);

  // Breakout check
  const longBreakout = last.high > entryUpper;
  const shortBreakout = last.low < entryLower;

  let direction = null;
  let entry = null;
  if (longBreakout && (!CONFIG.USE_TREND_FILTER || last.close > ema)) {
    direction = 'LONG';
    entry = entryUpper;  // вход по уровню пробоя
  } else if (shortBreakout && (!CONFIG.USE_TREND_FILTER || last.close < ema)) {
    direction = 'SHORT';
    entry = entryLower;
  }
  if (!direction) return null;

  const sl = direction === 'LONG' ? entry - atr * CONFIG.STOP_ATR_MULT : entry + atr * CONFIG.STOP_ATR_MULT;

  return { direction, entry, sl, atr, atrPct, ema };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
function hasOpen(symbol) {
  return state.positions.some(p => p.symbol === symbol && p.status === 'open');
}
function countOpen() {
  return state.positions.filter(p => p.status === 'open').length;
}

function openPosition(symbol, signal) {
  if (hasOpen(symbol)) return null;
  if (countOpen() >= CONFIG.MAX_CONCURRENT) return null;

  const stopDist = Math.abs(signal.entry - signal.sl);
  const riskUsd = state.balance * CONFIG.RISK_PCT / 100;
  const size = riskUsd / stopDist;
  const notional = size * signal.entry;

  const pos = {
    id: crypto.randomUUID().slice(0, 8),
    symbol, direction: signal.direction,
    status: 'open',
    openedAt: new Date().toISOString(),
    entry: signal.entry,
    sl: signal.sl,
    atr: signal.atr,
    atrPct: signal.atrPct,
    size, initialSize: size,
    notional, riskUsd,
    pnlRealized: 0, pnlR: 0,
    closedAt: null, closePrice: null, closeReason: null,
  };

  state.positions.push(pos);
  console.log(`[dch] OPEN ${pos.direction} ${symbol} @ ${signal.entry.toFixed(6)} SL=${signal.sl.toFixed(6)}`);

  const emoji = pos.direction === 'LONG' ? '🟢' : '🔴';
  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P&interval=240`;
  const msg =
    `${emoji} <b>DCH ${pos.direction}: ${symbol}</b>\n\n` +
    `<a href="${tvUrl}">📈 График 4H</a>\n\n` +
    `Entry: <code>${fmtP(signal.entry)}</code>\n` +
    `Stop: <code>${fmtP(signal.sl)}</code>\n` +
    `Trailing exit: Donchian(${CONFIG.EXIT_PERIOD})\n\n` +
    `ATR: ${signal.atrPct.toFixed(2)}%\n` +
    `💵 Размер: $${notional.toFixed(2)}\n` +
    `⚠️ Риск: $${riskUsd.toFixed(2)} (1R)\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}`;
  sendTelegram(msg);
  return pos;
}

function closePos(pos, price, reason) {
  const pnlPerUnit = pos.direction === 'LONG' ? price - pos.entry : pos.entry - price;
  const pnlUsd = pnlPerUnit * pos.size;
  const pnlR = pnlUsd / pos.riskUsd;
  pos.pnlRealized = pnlUsd;
  pos.pnlR = pnlR;
  state.balance += pnlUsd;
  pos.status = 'closed';
  pos.closedAt = new Date().toISOString();
  pos.closePrice = price;
  pos.closeReason = reason;

  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd = (state.peakBalance - state.balance) / state.peakBalance * 100;
  if (dd > state.maxDrawdownPct) state.maxDrawdownPct = dd;

  console.log(`[dch] CLOSE ${pos.symbol} ${reason} pnl=$${pnlUsd.toFixed(2)} (${pnlR.toFixed(2)}R)`);

  let emoji, title;
  if (reason === 'stop') { emoji = '🛑'; title = 'STOP'; }
  else if (reason === 'donchian_exit') { emoji = '🎯'; title = 'Donchian Exit (trail)'; }
  else { emoji = '📉'; title = reason.toUpperCase(); }

  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${pos.symbol}.P&interval=240`;
  const sign = pnlUsd >= 0 ? '+' : '';
  const msg =
    `${emoji} <b>DCH ${title}: ${pos.symbol}</b>\n\n` +
    `<a href="${tvUrl}">📈 График</a>\n\n` +
    `Close: <code>${fmtP(price)}</code>\n` +
    `Итог: <b>${sign}$${pnlUsd.toFixed(2)}</b> (${sign}${pnlR.toFixed(2)}R)\n\n` +
    `💰 Баланс: <b>$${state.balance.toFixed(2)}</b>\n` +
    `📊 Total: ${(state.balance - state.startBalance) >= 0 ? '+' : ''}$${(state.balance - state.startBalance).toFixed(2)}`;
  sendTelegram(msg);
}

async function updatePosition(pos) {
  const k = await getKlines(pos.symbol, CONFIG.TIMEFRAME, CONFIG.EXIT_PERIOD + 5);
  if (!k || k.length === 0) return;
  const last = k[k.length - 1];

  // 1. SL check first
  const slHit = pos.direction === 'LONG' ? last.low <= pos.sl : last.high >= pos.sl;
  if (slHit) {
    closePos(pos, pos.sl, 'stop');
    return;
  }

  // 2. Donchian trailing exit
  const prevIdx = k.length - 1;
  if (pos.direction === 'LONG') {
    const exitLow = lowestN(k, prevIdx - CONFIG.EXIT_PERIOD, prevIdx, 'low');
    if (last.low <= exitLow) {
      closePos(pos, exitLow, 'donchian_exit');
    }
  } else {
    const exitHigh = highestN(k, prevIdx - CONFIG.EXIT_PERIOD, prevIdx, 'high');
    if (last.high >= exitHigh) {
      closePos(pos, exitHigh, 'donchian_exit');
    }
  }
}

// ============================================================
// PIPELINE
// ============================================================
async function analyzeSymbol(symbol) {
  try {
    const k = await getKlines(symbol, CONFIG.TIMEFRAME, CONFIG.KLINES_4H_LIMIT);
    const sig = detectSignal(k);
    return sig ? { symbol, signal: sig } : null;
  } catch (e) { return null; }
}

async function checkSignals() {
  try {
    const symbols = await getTopSymbols();
    const results = [];
    for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
      const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
      const r = await Promise.all(batch.map(analyzeSymbol));
      results.push(...r.filter(x => x));
    }
    for (const r of results) {
      const pos = openPosition(r.symbol, r.signal);
      if (pos) await saveState();
    }
  } catch (e) {
    console.error('[dch] checkSignals', e.message);
  }
}

async function tickPositions() {
  const open = state.positions.filter(p => p.status === 'open');
  if (open.length === 0) return;
  for (const p of open) await updatePosition(p);
  await saveState();
}

// ============================================================
// STATS
// ============================================================
function computeStats() {
  const closed = state.positions.filter(p => p.status === 'closed');
  const open = state.positions.filter(p => p.status === 'open');
  const wins = closed.filter(p => p.pnlRealized > 0);
  const losses = closed.filter(p => p.pnlRealized <= 0);
  const totalPnl = state.balance - state.startBalance;
  const winrate = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const grossW = wins.reduce((s, p) => s + p.pnlRealized, 0);
  const grossL = Math.abs(losses.reduce((s, p) => s + p.pnlRealized, 0));
  const pf = grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0);
  const avgR = closed.length > 0 ? closed.reduce((s, p) => s + p.pnlR, 0) / closed.length : 0;
  const longs = closed.filter(p => p.direction === 'LONG');
  const shorts = closed.filter(p => p.direction === 'SHORT');
  return {
    balance: state.balance, startBalance: state.startBalance,
    totalPnl, totalPnlPct: totalPnl / state.startBalance * 100,
    maxDrawdownPct: state.maxDrawdownPct,
    openCount: open.length, closedCount: closed.length,
    winCount: wins.length, lossCount: losses.length,
    winrate, pf, avgR,
    longCount: longs.length, shortCount: shorts.length,
    longWins: longs.filter(p => p.pnlRealized > 0).length,
    shortWins: shorts.filter(p => p.pnlRealized > 0).length,
  };
}

// ============================================================
// HTML
// ============================================================
function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
}

function renderTable(positions, title, empty) {
  if (positions.length === 0) return `<h2>${title}</h2><div class="empty">${empty}</div>`;
  const rows = positions.map(p => {
    const pnlCls = p.pnlRealized > 0 ? 'win' : p.pnlRealized < 0 ? 'loss' : 'neu';
    const dirClr = p.direction === 'LONG' ? '#10b981' : '#ef4444';
    const stClr = p.status === 'open' ? '#3b82f6' :
      p.closeReason === 'stop' ? '#ef4444' :
      p.closeReason === 'donchian_exit' ? '#10b981' : '#8b5cf6';
    const st = p.status === 'open' ? 'OPEN' : p.closeReason.toUpperCase();
    const tv = `https://www.tradingview.com/chart/?symbol=BINANCE:${p.symbol}.P&interval=240`;
    return `<tr>
      <td><a href="${tv}" target="_blank">${p.symbol}</a></td>
      <td><span class="bdg" style="background:${dirClr}">${p.direction}</span></td>
      <td><span class="bdg" style="background:${stClr}">${st}</span></td>
      <td class="num">${fmtP(p.entry)}</td>
      <td class="num sl">${fmtP(p.sl)}</td>
      <td class="num">${p.atrPct?.toFixed(2) || '-'}%</td>
      <td class="num">$${p.riskUsd.toFixed(2)}</td>
      <td class="num ${pnlCls}">${p.pnlRealized >= 0 ? '+' : ''}$${p.pnlRealized.toFixed(2)}</td>
      <td class="num ${pnlCls}">${p.pnlR >= 0 ? '+' : ''}${p.pnlR.toFixed(2)}R</td>
      <td class="tm">${fmtTime(p.openedAt)}</td>
      <td class="tm">${fmtTime(p.closedAt)}</td>
    </tr>`;
  }).join('');
  return `<h2>${title} <span class="cnt">(${positions.length})</span></h2>
    <table><thead><tr>
      <th>Символ</th><th>Напр</th><th>Статус</th><th>Entry</th><th>SL</th>
      <th>ATR%</th><th>Risk</th><th>P&L $</th><th>P&L R</th><th>Open</th><th>Close</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHTML() {
  const s = computeStats();
  const open = state.positions.filter(p => p.status === 'open')
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  const closed = state.positions.filter(p => p.status === 'closed')
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, 100);
  const pnlClr = s.totalPnl > 0 ? '#10b981' : s.totalPnl < 0 ? '#ef4444' : '#9ca3af';

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 Donchian Paper</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px}
  h1{margin:0 0 5px 0;font-size:22px;color:#fff}h1 span{color:#6b7280;font-weight:400;font-size:14px}
  h2{color:#e5e7eb;font-size:16px;margin:30px 0 10px 0}.cnt{color:#6b7280;font-weight:400;font-size:14px}
  .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:15px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
  .sb{background:#1f2937;padding:12px 15px;border-radius:6px;border:1px solid #374151}
  .sb b{color:#fff;font-size:20px;display:block}
  .sb span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  .sb.big{background:linear-gradient(135deg,#1f2937,#111827);grid-column:span 2}.sb.big b{font-size:28px}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px;margin-bottom:20px}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151}
  td{padding:9px 8px;border-bottom:1px solid #1f2937;white-space:nowrap}
  tr:hover{background:#1a2332}
  a{color:#60a5fa;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}
  .num{text-align:right;font-variant-numeric:tabular-nums;color:#d1d5db}
  .sl{color:#f87171}.win{color:#10b981;font-weight:600}.loss{color:#ef4444;font-weight:600}.neu{color:#9ca3af}
  .tm{color:#6b7280;font-size:11px}
  .bdg{color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .empty{text-align:center;padding:30px;color:#6b7280;background:#111827;border-radius:8px}
  .rfr{background:#2563eb;color:#fff;padding:8px 18px;border:none;border-radius:6px;font-size:13px;text-decoration:none}
  .warn{background:#422006;padding:10px 15px;border-radius:6px;margin-bottom:15px;font-size:13px;color:#fbbf24;border-left:3px solid #fbbf24}
</style></head><body>
<div class="hdr">
  <div><h1>AK88 Donchian Paper <span>· Turtle 20/10 · 4H крипта · top-${CONFIG.TOP_SYMBOLS}</span></h1></div>
  <a href="/" class="rfr">↻ Обновить</a>
</div>
<div class="warn">Paper trading · Donchian(${CONFIG.ENTRY_PERIOD})→вход, Donchian(${CONFIG.EXIT_PERIOD})→выход · Stop ${CONFIG.STOP_ATR_MULT}×ATR · EMA${CONFIG.TREND_EMA} filter</div>

<div class="stats">
  <div class="sb big"><b style="color:${pnlClr}">$${s.balance.toFixed(2)}</b><span>Баланс (старт $${s.startBalance})</span></div>
  <div class="sb"><b style="color:${pnlClr}">${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}</b><span>P&amp;L</span></div>
  <div class="sb"><b style="color:${pnlClr}">${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}%</b><span>P&amp;L %</span></div>
  <div class="sb"><b style="color:#ef4444">-${s.maxDrawdownPct.toFixed(2)}%</b><span>Max DD</span></div>
  <div class="sb"><b>${s.winrate.toFixed(1)}%</b><span>Winrate (${s.winCount}/${s.closedCount})</span></div>
  <div class="sb"><b>${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}</b><span>Profit Factor</span></div>
  <div class="sb"><b style="color:${s.avgR >= 0 ? '#10b981' : '#ef4444'}">${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R</b><span>Avg per trade</span></div>
  <div class="sb"><b>${s.openCount}</b><span>Открытых</span></div>
  <div class="sb"><b style="color:#10b981">${s.longWins}/${s.longCount}</b><span>LONG wins</span></div>
  <div class="sb"><b style="color:#ef4444">${s.shortWins}/${s.shortCount}</b><span>SHORT wins</span></div>
</div>

${renderTable(open, '🔵 Открытые', 'Нет открытых позиций')}
${renderTable(closed, '📊 Закрытые (последние 100)', 'Пока нет закрытых сделок.')}

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Turtle Trend Following (modified) · Max concurrent ${CONFIG.MAX_CONCURRENT} · Risk ${CONFIG.RISK_PCT}% · ATR filter ≤ ${CONFIG.MAX_ATR_PCT}%<br>
  Проверка сигналов: ${CONFIG.CHECK_INTERVAL_MS/60000} мин · Tick: ${CONFIG.TICK_INTERVAL_MS/60000} мин
</div>
</body></html>`;
}

// ============================================================
// HTTP
// ============================================================
const PORT = process.env.PORT || 8087;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ stats: computeStats(), positions: state.positions }));
    return;
  }
  if (url.pathname === '/reset') {
    if (url.searchParams.get('confirm') === 'yes') {
      state = {
        balance: CONFIG.START_BALANCE, startBalance: CONFIG.START_BALANCE,
        peakBalance: CONFIG.START_BALANCE, maxDrawdownPct: 0,
        createdAt: new Date().toISOString(), positions: [],
      };
      await saveState();
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;padding:40px"><h2>Сбросить DCH?</h2><a href="/reset?confirm=yes" style="background:#ef4444;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">Да</a> &nbsp; <a href="/" style="color:#60a5fa">Отмена</a></body></html>');
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHTML());
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ============================================================
// MAIN
// ============================================================
async function main() {
  await loadState();
  server.listen(PORT, () => console.log(`[dch] Donchian Paper listening on ${PORT}`));

  sendTelegram(
    `🚀 <b>Donchian Paper запущен</b>\n\n` +
    `Turtle Classic · 4H · top-${CONFIG.TOP_SYMBOLS}\n\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}\n` +
    `📊 Открытых: ${state.positions.filter(p => p.status === 'open').length}\n\n` +
    `⚙️ Risk ${CONFIG.RISK_PCT}% · Max concurrent ${CONFIG.MAX_CONCURRENT}\n` +
    `🎯 Entry Donchian(${CONFIG.ENTRY_PERIOD}), Exit Donchian(${CONFIG.EXIT_PERIOD})\n\n` +
    `Проверка каждые ${CONFIG.CHECK_INTERVAL_MS/60000} мин`
  );

  setTimeout(async () => {
    await checkSignals();
    await tickPositions();
  }, 30000);

  setInterval(checkSignals, CONFIG.CHECK_INTERVAL_MS);
  setInterval(tickPositions, CONFIG.TICK_INTERVAL_MS);
}

main().catch(e => {
  console.error('[dch] fatal:', e);
  process.exit(1);
});
