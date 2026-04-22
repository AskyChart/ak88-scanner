// ============================================================
// AK88 AZLS Paper Trader
// Виртуальный бот для тестирования стратегии без реальных денег
// Запускается параллельно со сканером, хранит позиции в JSON
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
  START_BALANCE: 10000,           // стартовый виртуальный депозит $
  RISK_PER_TRADE_PCT: 1.0,        // % риска от баланса на сделку
  MAX_CONCURRENT_POSITIONS: 5,    // одновременно открытых позиций
  MIN_SCORE: 60,                  // минимальный Score для входа
  TP1_FRACTION: 0.333,            // доля закрытия на TP1
  TP2_FRACTION: 0.333,            // доля закрытия на TP2
  TP3_FRACTION: 0.334,            // остаток на TP3
  MOVE_TO_BE_AFTER_TP1: true,     // перенос SL в безубыток после TP1
  SCANNER_URL: 'http://localhost:8081/api/scan',  // адрес сканера
  CHECK_INTERVAL_MS: 10 * 60 * 1000,   // проверка новых сетапов: 10 мин
  TICK_INTERVAL_MS: 5 * 60 * 1000,     // проверка SL/TP открытых позиций: 5 мин
  STATE_FILE: path.join(__dirname, 'paper_state.json'),
  BINANCE: 'https://fapi.binance.com',
  // Telegram notifications
  TELEGRAM_TOKEN: '8629365441:AAEdKh0b_n57t0x_Gqv32n1VMvIH8WbLBkQ',
  TELEGRAM_CHAT_ID: '481990619',
  TELEGRAM_ENABLED: true,
};

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(html) {
  if (!CONFIG.TELEGRAM_ENABLED) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
    const body = {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[paper][tg] send failed:', r.status, errText);
    }
  } catch (e) {
    console.error('[paper][tg] error:', e.message);
  }
}

function fmtPriceTg(p) {
  if (!p) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

// ============================================================
// STATE
// ============================================================
let state = {
  balance: CONFIG.START_BALANCE,
  startBalance: CONFIG.START_BALANCE,
  peakBalance: CONFIG.START_BALANCE,
  maxDrawdownPct: 0,
  createdAt: new Date().toISOString(),
  positions: [],  // все позиции (open и closed)
};

// ============================================================
// STORAGE
// ============================================================
async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.STATE_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    state = { ...state, ...loaded };
    console.log(`[paper] state loaded: balance=$${state.balance.toFixed(2)}, positions=${state.positions.length}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[paper] no state file, starting fresh');
      await saveState();
    } else {
      console.error('[paper] loadState error:', e.message);
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[paper] saveState error:', e.message);
  }
}

// ============================================================
// MARKET DATA
// ============================================================
async function getCurrentKline(symbol) {
  const url = `${CONFIG.BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=1`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const k = data[0];
    return {
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
function hasOpenPosition(symbol) {
  return state.positions.some(p => p.symbol === symbol && p.status === 'open');
}

function countOpenPositions() {
  return state.positions.filter(p => p.status === 'open').length;
}

function openPosition(setup) {
  if (hasOpenPosition(setup.symbol)) return null;
  if (countOpenPositions() >= CONFIG.MAX_CONCURRENT_POSITIONS) return null;
  if (setup.score < CONFIG.MIN_SCORE) return null;
  if (!setup.triggerNow) return null;

  const entry = setup.currentPrice;
  const sl = setup.slLevel;
  const riskUsd = state.balance * (CONFIG.RISK_PER_TRADE_PCT / 100);
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit === 0) return null;

  // size в монетах (или контрактах для futures)
  const size = riskUsd / riskPerUnit;
  const positionValueUsd = size * entry;

  const pos = {
    id: crypto.randomUUID().slice(0, 8),
    symbol: setup.symbol,
    direction: setup.direction,
    status: 'open',
    openedAt: new Date().toISOString(),
    score: setup.score,
    verdict: setup.verdict,
    entry,
    originalSL: sl,
    currentSL: sl,
    tp1: setup.tp1,
    tp2: setup.tp2,
    tp3: setup.tp3,
    size,
    initialSize: size,
    positionValueUsd,
    riskUsd,
    fills: [],           // частичные закрытия
    pnlRealized: 0,      // реализованная прибыль $
    pnlR: 0,             // в R (риск-юнитах)
    closedAt: null,
    closePrice: null,
    closeReason: null,
  };

  state.positions.push(pos);
  console.log(`[paper] OPENED ${pos.direction} ${pos.symbol} @ ${entry.toFixed(6)} | SL=${sl.toFixed(6)} | risk=$${riskUsd.toFixed(2)} | score=${pos.score}`);

  // Telegram notification
  const dirEmoji = pos.direction === 'BUY' ? '🟢' : '🔴';
  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${pos.symbol}.P&interval=240`;
  const rr2 = Math.abs(pos.tp2 - pos.entry) / Math.abs(pos.originalSL - pos.entry);
  const msg =
    `${dirEmoji} <b>ОТКРЫТА ${pos.direction}</b>\n\n` +
    `<b>${pos.symbol}</b> · Score ${pos.score} (${pos.verdict})\n` +
    `<a href="${tvUrl}">📈 Открыть график</a>\n\n` +
    `Entry: <code>${fmtPriceTg(pos.entry)}</code>\n` +
    `SL: <code>${fmtPriceTg(pos.originalSL)}</code>\n` +
    `TP1: <code>${fmtPriceTg(pos.tp1)}</code>\n` +
    `TP2: <code>${fmtPriceTg(pos.tp2)}</code> (R:R ${rr2.toFixed(2)})\n` +
    `TP3: <code>${fmtPriceTg(pos.tp3)}</code>\n\n` +
    `💵 Размер: $${pos.positionValueUsd.toFixed(2)}\n` +
    `⚠️ Риск: $${pos.riskUsd.toFixed(2)} (1R)\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}`;
  sendTelegram(msg);

  return pos;
}

function checkTPHit(pos, high, low, tpPrice) {
  if (pos.direction === 'SELL') return low <= tpPrice;
  return high >= tpPrice;
}

function checkSLHit(pos, high, low) {
  if (pos.direction === 'SELL') return high >= pos.currentSL;
  return low <= pos.currentSL;
}

function partialClose(pos, fraction, price, reason) {
  const closeSize = pos.initialSize * fraction;
  if (closeSize > pos.size + 0.0001) return;  // уже закрыто

  const pnlPerUnit = pos.direction === 'SELL'
    ? (pos.entry - price)
    : (price - pos.entry);
  const pnlUsd = pnlPerUnit * closeSize;
  const pnlR = pnlUsd / pos.riskUsd;

  pos.size -= closeSize;
  pos.pnlRealized += pnlUsd;
  pos.pnlR += pnlR;
  state.balance += pnlUsd;

  pos.fills.push({
    reason,
    price,
    fraction,
    sizeClosed: closeSize,
    pnlUsd,
    pnlR,
    time: new Date().toISOString(),
  });

  console.log(`[paper] ${reason} ${pos.symbol} @ ${price.toFixed(6)} | pnl=$${pnlUsd.toFixed(2)} (${pnlR.toFixed(2)}R) | balance=$${state.balance.toFixed(2)}`);

  // Telegram
  const tpEmoji = reason === 'tp1' ? '🎯' : '💰';
  const tpName = reason.toUpperCase();
  const beNote = (reason === 'tp1' && CONFIG.MOVE_TO_BE_AFTER_TP1) ? '\n🛡 SL перенесён в безубыток' : '';
  const tgMsg =
    `${tpEmoji} <b>${tpName} достигнут: ${pos.symbol}</b>\n\n` +
    `Цена: <code>${fmtPriceTg(price)}</code>\n` +
    `Закрыто: ${Math.round(fraction * 100)}% позиции\n` +
    `P&L: <b>${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}</b> (${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R)${beNote}\n\n` +
    `Всего по сделке: ${pos.pnlRealized >= 0 ? '+' : ''}$${pos.pnlRealized.toFixed(2)} (${pos.pnlR >= 0 ? '+' : ''}${pos.pnlR.toFixed(2)}R)\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}`;
  sendTelegram(tgMsg);

  // После TP1 — перенос SL в безубыток
  if (reason === 'tp1' && CONFIG.MOVE_TO_BE_AFTER_TP1) {
    pos.currentSL = pos.entry;
  }
}

function closePosition(pos, price, reason) {
  if (pos.size > 0.0001) {
    const pnlPerUnit = pos.direction === 'SELL'
      ? (pos.entry - price)
      : (price - pos.entry);
    const pnlUsd = pnlPerUnit * pos.size;
    const pnlR = pnlUsd / pos.riskUsd;

    pos.pnlRealized += pnlUsd;
    pos.pnlR += pnlR;
    state.balance += pnlUsd;

    pos.fills.push({
      reason,
      price,
      fraction: pos.size / pos.initialSize,
      sizeClosed: pos.size,
      pnlUsd,
      pnlR,
      time: new Date().toISOString(),
    });
    pos.size = 0;
  }

  pos.status = 'closed';
  pos.closedAt = new Date().toISOString();
  pos.closePrice = price;
  pos.closeReason = reason;

  // Обновить peak и drawdown
  if (state.balance > state.peakBalance) {
    state.peakBalance = state.balance;
  }
  const ddPct = (state.peakBalance - state.balance) / state.peakBalance * 100;
  if (ddPct > state.maxDrawdownPct) {
    state.maxDrawdownPct = ddPct;
  }

  console.log(`[paper] CLOSED ${pos.symbol} reason=${reason} total_pnl=$${pos.pnlRealized.toFixed(2)} (${pos.pnlR.toFixed(2)}R)`);

  // Telegram
  let closeEmoji, closeTitle;
  if (reason === 'stop') { closeEmoji = '🛑'; closeTitle = 'СТОП ЗАКРЫТ'; }
  else if (reason === 'be') { closeEmoji = '🛡'; closeTitle = 'Закрыто в безубыток'; }
  else if (reason === 'tp3') { closeEmoji = '🏆'; closeTitle = 'TP3 — полное закрытие'; }
  else { closeEmoji = '📉'; closeTitle = 'Закрыто'; }

  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${pos.symbol}.P&interval=240`;
  const pnlSign = pos.pnlRealized >= 0 ? '+' : '';
  const closeTgMsg =
    `${closeEmoji} <b>${closeTitle}: ${pos.symbol}</b>\n\n` +
    `<a href="${tvUrl}">📈 График</a>\n\n` +
    `Close: <code>${fmtPriceTg(price)}</code>\n` +
    `Итог: <b>${pnlSign}$${pos.pnlRealized.toFixed(2)}</b> (${pnlSign}${pos.pnlR.toFixed(2)}R)\n\n` +
    `💰 Баланс: <b>$${state.balance.toFixed(2)}</b>\n` +
    `📊 Total P&L: ${(state.balance - state.startBalance) >= 0 ? '+' : ''}$${(state.balance - state.startBalance).toFixed(2)}`;
  sendTelegram(closeTgMsg);
}

async function updateOpenPosition(pos) {
  const kline = await getCurrentKline(pos.symbol);
  if (!kline) return;

  const { high, low, close } = kline;

  // Проверяем SL первым (для безопасности)
  if (checkSLHit(pos, high, low)) {
    closePosition(pos, pos.currentSL, pos.currentSL === pos.originalSL ? 'stop' : 'be');
    return;
  }

  // TP1 ещё не взят?
  const tp1Filled = pos.fills.some(f => f.reason === 'tp1');
  if (!tp1Filled && checkTPHit(pos, high, low, pos.tp1)) {
    partialClose(pos, CONFIG.TP1_FRACTION, pos.tp1, 'tp1');
  }

  // TP2?
  const tp2Filled = pos.fills.some(f => f.reason === 'tp2');
  if (!tp2Filled && checkTPHit(pos, high, low, pos.tp2)) {
    partialClose(pos, CONFIG.TP2_FRACTION, pos.tp2, 'tp2');
  }

  // TP3? (закрытие остатка)
  const tp3Filled = pos.fills.some(f => f.reason === 'tp3');
  if (!tp3Filled && checkTPHit(pos, high, low, pos.tp3)) {
    closePosition(pos, pos.tp3, 'tp3');
  }
}

// ============================================================
// MAIN LOOPS
// ============================================================
async function checkNewSetups() {
  try {
    const r = await fetch(CONFIG.SCANNER_URL);
    if (!r.ok) {
      console.error('[paper] scanner fetch failed:', r.status);
      return;
    }
    const data = await r.json();
    const setups = data.results || [];
    for (const setup of setups) {
      if (setup.triggerNow) {
        const opened = openPosition(setup);
        if (opened) await saveState();
      }
    }
  } catch (e) {
    console.error('[paper] checkNewSetups error:', e.message);
  }
}

async function tickOpenPositions() {
  const open = state.positions.filter(p => p.status === 'open');
  if (open.length === 0) return;

  for (const pos of open) {
    await updateOpenPosition(pos);
  }
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
  const totalPnlPct = totalPnl / state.startBalance * 100;
  const winrate = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p.pnlRealized, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p.pnlRealized, 0) / losses.length : 0;
  const grossWin = wins.reduce((s, p) => s + p.pnlRealized, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnlRealized, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgR = closed.length > 0 ? closed.reduce((s, p) => s + p.pnlR, 0) / closed.length : 0;

  const longs = closed.filter(p => p.direction === 'BUY');
  const shorts = closed.filter(p => p.direction === 'SELL');

  return {
    balance: state.balance,
    startBalance: state.startBalance,
    totalPnl, totalPnlPct,
    maxDrawdownPct: state.maxDrawdownPct,
    openCount: open.length,
    closedCount: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    winrate, avgWin, avgLoss, avgR, profitFactor,
    longCount: longs.length,
    shortCount: shorts.length,
    longWins: longs.filter(p => p.pnlRealized > 0).length,
    shortWins: shorts.filter(p => p.pnlRealized > 0).length,
  };
}

// ============================================================
// HTML RENDERING
// ============================================================
function fmtPrice(p) {
  if (!p) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
}

function renderPositionsTable(positions, title, emptyMsg) {
  if (positions.length === 0) {
    return `<h2>${title}</h2><div class="empty">${emptyMsg}</div>`;
  }
  const rows = positions.map(p => {
    const pnlClass = p.pnlRealized > 0 ? 'pnl-win' : p.pnlRealized < 0 ? 'pnl-loss' : 'pnl-neutral';
    const dirColor = p.direction === 'BUY' ? '#10b981' : '#ef4444';
    const statusColor = p.status === 'open' ? '#3b82f6' : (p.closeReason === 'stop' ? '#ef4444' : p.closeReason === 'be' ? '#6b7280' : '#10b981');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${p.symbol}.P&interval=240`;
    const tp1Done = p.fills.some(f => f.reason === 'tp1') ? '✓' : '—';
    const tp2Done = p.fills.some(f => f.reason === 'tp2') ? '✓' : '—';
    const tp3Done = p.fills.some(f => f.reason === 'tp3') ? '✓' : '—';
    return `
      <tr>
        <td><a href="${tvUrl}" target="_blank">${p.symbol}</a></td>
        <td><span class="badge" style="background:${dirColor}">${p.direction}</span></td>
        <td class="score">${p.score}</td>
        <td><span class="badge" style="background:${statusColor}">${p.status === 'open' ? 'OPEN' : p.closeReason.toUpperCase()}</span></td>
        <td class="num">${fmtPrice(p.entry)}</td>
        <td class="num">${fmtPrice(p.currentSL)}</td>
        <td class="tp">${tp1Done} ${fmtPrice(p.tp1)}</td>
        <td class="tp">${tp2Done} ${fmtPrice(p.tp2)}</td>
        <td class="tp">${tp3Done} ${fmtPrice(p.tp3)}</td>
        <td class="num">$${p.riskUsd.toFixed(2)}</td>
        <td class="num ${pnlClass}">${p.pnlRealized >= 0 ? '+' : ''}$${p.pnlRealized.toFixed(2)}</td>
        <td class="num ${pnlClass}">${p.pnlR >= 0 ? '+' : ''}${p.pnlR.toFixed(2)}R</td>
        <td class="time">${fmtTime(p.openedAt)}</td>
        <td class="time">${fmtTime(p.closedAt)}</td>
      </tr>`;
  }).join('');
  return `<h2>${title} <span class="count">(${positions.length})</span></h2>
    <table><thead><tr>
      <th>Символ</th><th>Напр</th><th>Score</th><th>Статус</th>
      <th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th>
      <th>Risk</th><th>P&L $</th><th>P&L R</th><th>Open</th><th>Close</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHTML() {
  const s = computeStats();
  const open = state.positions.filter(p => p.status === 'open')
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  const closed = state.positions.filter(p => p.status === 'closed')
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, 100);

  const pnlColor = s.totalPnl > 0 ? '#10b981' : s.totalPnl < 0 ? '#ef4444' : '#9ca3af';

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 Paper Trader</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:15px}
  h1{margin:0;font-size:22px;color:#fff}h1 span{color:#6b7280;font-weight:400;font-size:14px}
  h2{color:#e5e7eb;font-size:16px;margin:30px 0 10px 0}.count{color:#6b7280;font-weight:400;font-size:14px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
  .stat-box{background:#1f2937;padding:12px 15px;border-radius:6px;border:1px solid #374151}
  .stat-box b{color:#fff;font-size:20px;display:block}
  .stat-box span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  .stat-big{background:linear-gradient(135deg,#1f2937,#111827);grid-column:span 2}
  .stat-big b{font-size:28px}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px;margin-bottom:20px}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151}
  td{padding:9px 8px;border-bottom:1px solid #1f2937;white-space:nowrap}
  tr:hover{background:#1a2332}
  a{color:#60a5fa;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}
  .num{text-align:right;font-variant-numeric:tabular-nums;color:#d1d5db}
  .score{text-align:center;color:#fbbf24;font-weight:600}
  .tp{color:#34d399;font-size:12px}
  .pnl-win{color:#10b981;font-weight:600}
  .pnl-loss{color:#ef4444;font-weight:600}
  .pnl-neutral{color:#9ca3af}
  .time{color:#6b7280;font-size:11px}
  .badge{color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .empty{text-align:center;padding:30px;color:#6b7280;background:#111827;border-radius:8px}
  .refresh{background:#2563eb;color:#fff;padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;text-decoration:none}
  .refresh:hover{background:#1d4ed8}
  .warning{background:#422006;padding:10px 15px;border-radius:6px;margin-bottom:15px;font-size:13px;color:#fbbf24;border-left:3px solid #fbbf24}
</style></head><body>
<div class="header">
  <h1>AK88 Paper Trader <span>· виртуальные сделки · риск ${CONFIG.RISK_PER_TRADE_PCT}% на позицию</span></h1>
  <a href="/" class="refresh">↻ Обновить</a>
</div>
<div class="warning">⚠️ Paper trading — все сделки виртуальные. Реальные деньги не задействованы.</div>

<div class="stats">
  <div class="stat-box stat-big">
    <b style="color:${pnlColor}">$${s.balance.toFixed(2)}</b>
    <span>Баланс (старт $${s.startBalance})</span>
  </div>
  <div class="stat-box">
    <b style="color:${pnlColor}">${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}</b>
    <span>P&amp;L total</span>
  </div>
  <div class="stat-box">
    <b style="color:${pnlColor}">${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}%</b>
    <span>P&amp;L %</span>
  </div>
  <div class="stat-box">
    <b style="color:#ef4444">-${s.maxDrawdownPct.toFixed(2)}%</b>
    <span>Max DD</span>
  </div>
  <div class="stat-box">
    <b>${s.winrate.toFixed(1)}%</b>
    <span>Winrate (${s.winCount}/${s.closedCount})</span>
  </div>
  <div class="stat-box">
    <b>${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}</b>
    <span>Profit Factor</span>
  </div>
  <div class="stat-box">
    <b style="color:${s.avgR >= 0 ? '#10b981' : '#ef4444'}">${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R</b>
    <span>Avg per trade</span>
  </div>
  <div class="stat-box">
    <b>${s.openCount}</b>
    <span>Открытых</span>
  </div>
  <div class="stat-box">
    <b style="color:#10b981">${s.longWins}/${s.longCount}</b>
    <span>BUY wins</span>
  </div>
  <div class="stat-box">
    <b style="color:#ef4444">${s.shortWins}/${s.shortCount}</b>
    <span>SELL wins</span>
  </div>
</div>

${renderPositionsTable(open, '🔵 Открытые позиции', 'Нет открытых позиций')}
${renderPositionsTable(closed, '📊 Закрытые (последние 100)', 'Нет закрытых позиций. Бот следит за сканером — при появлении триггера откроет виртуальную сделку.')}

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Стратегия: AK88 AZLS · Min score ${CONFIG.MIN_SCORE} · Max concurrent ${CONFIG.MAX_CONCURRENT_POSITIONS} · TP: ${Math.round(CONFIG.TP1_FRACTION*100)}/${Math.round(CONFIG.TP2_FRACTION*100)}/${Math.round(CONFIG.TP3_FRACTION*100)} · Move to BE after TP1: ${CONFIG.MOVE_TO_BE_AFTER_TP1 ? 'да' : 'нет'}<br>
  Проверка сетапов: каждые ${CONFIG.CHECK_INTERVAL_MS/60000} мин · Проверка позиций: каждые ${CONFIG.TICK_INTERVAL_MS/60000} мин
</div>
</body></html>`;
}

// ============================================================
// HTTP SERVER
// ============================================================
const PORT = process.env.PORT || 8082;

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
        balance: CONFIG.START_BALANCE,
        startBalance: CONFIG.START_BALANCE,
        peakBalance: CONFIG.START_BALANCE,
        maxDrawdownPct: 0,
        createdAt: new Date().toISOString(),
        positions: [],
      };
      await saveState();
      res.writeHead(302, { Location: '/' });
      res.end('reset done');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;padding:40px"><h2>Подтвердить сброс?</h2><p>Это удалит ВСЕ позиции и сбросит баланс на $' + CONFIG.START_BALANCE + '</p><a href="/reset?confirm=yes" style="background:#ef4444;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">Да, сбросить</a> &nbsp; <a href="/" style="color:#60a5fa">Отмена</a></body></html>');
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
// STARTUP
// ============================================================
async function main() {
  await loadState();
  server.listen(PORT, () => {
    console.log(`[paper] AK88 Paper Trader listening on port ${PORT}`);
  });

  // Стартовое сообщение в Telegram
  const startMsg =
    `🚀 <b>AK88 Paper Trader запущен</b>\n\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}\n` +
    `📊 Открытых: ${state.positions.filter(p => p.status === 'open').length}\n` +
    `📈 Всего сделок: ${state.positions.length}\n\n` +
    `⚙️ Риск: ${CONFIG.RISK_PER_TRADE_PCT}% на позицию\n` +
    `🎯 Max concurrent: ${CONFIG.MAX_CONCURRENT_POSITIONS}\n` +
    `📉 Min Score: ${CONFIG.MIN_SCORE}\n\n` +
    `Следу за сканером каждые ${CONFIG.CHECK_INTERVAL_MS/60000} мин`;
  sendTelegram(startMsg);

  // Первый тик через 30 сек после старта
  setTimeout(async () => {
    await checkNewSetups();
    await tickOpenPositions();
  }, 30000);

  // Циклы
  setInterval(checkNewSetups, CONFIG.CHECK_INTERVAL_MS);
  setInterval(tickOpenPositions, CONFIG.TICK_INTERVAL_MS);
}

main().catch(e => {
  console.error('[paper] fatal:', e);
  process.exit(1);
});
