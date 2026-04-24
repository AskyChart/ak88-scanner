// ============================================================
// AK88 SL Guardian — автоматический риск-менеджер
// Binance USDT-M Futures
//
// Что делает:
//   - Каждые 30 сек читает все открытые позиции
//   - Считает правильный SL: max(1%, 2×ATR(14, 4H))
//   - Если SL нет → ставит
//   - Если SL ДАЛЬШЕ расчётного (больший риск) → зажимает до расчётного
//   - Если SL БЛИЖЕ расчётного (юзер сам зажал) → НЕ трогает
//
// Что НЕ делает:
//   - Не открывает позиции
//   - Не закрывает позиции
//   - Не трогает Take Profit
//   - Не выводит средства
//
// ============================================================

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // API — берутся из переменных окружения (НЕ хранить в коде!)
  API_KEY: process.env.BINANCE_API_KEY,
  API_SECRET: process.env.BINANCE_API_SECRET,

  // URLs
  FAPI: 'https://fapi.binance.com',

  // SL calculation
  SL_MIN_PCT: 1.0,            // минимум 1% от цены
  SL_ATR_MULT: 2.0,           // 2 × ATR
  ATR_TIMEFRAME: '4h',        // ATR считаем на 4H
  ATR_LEN: 14,

  // Tolerances
  SL_ADJUST_THRESHOLD: 0.2,   // не дёргаем стоп если отличие менее 0.2% от правильного

  // Loops
  CHECK_INTERVAL_MS: 30 * 1000,     // каждые 30 сек
  RECV_WINDOW: 5000,

  // Telegram
  TELEGRAM_TOKEN: '8629365441:AAEdKh0b_n57t0x_Gqv32n1VMvIH8WbLBkQ',
  TELEGRAM_CHAT_ID: '481990619',
  TELEGRAM_ENABLED: true,

  // Storage (для истории действий)
  LOG_FILE: path.join(__dirname, 'sl_guardian_log.json'),

  // HTTP
  PORT: process.env.PORT || 8088,
};

// ============================================================
// STATE (для дедупликации алертов)
// ============================================================
let state = {
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  lastError: null,
  actions: [],      // последние 100 действий
  knownPositions: {},  // symbol -> { lastSL, lastSize, lastCheck }
};

// ============================================================
// LOGGING
// ============================================================
async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.LOG_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    state = { ...state, ...loaded, startedAt: state.startedAt };
    console.log(`[sl] state loaded, actions: ${state.actions.length}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[sl] loadState error:', e.message);
  }
}

async function saveState() {
  try {
    // Не храним больше 500 действий
    if (state.actions.length > 500) state.actions = state.actions.slice(-500);
    await fs.writeFile(CONFIG.LOG_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[sl] saveState:', e.message);
  }
}

function logAction(type, details) {
  const entry = { time: new Date().toISOString(), type, ...details };
  state.actions.push(entry);
  console.log(`[sl] ${type}:`, JSON.stringify(details));
  return entry;
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
    if (!r.ok) console.error('[sl][tg]', r.status, await r.text());
  } catch (e) {
    console.error('[sl][tg]', e.message);
  }
}

function fmtPrice(p) {
  if (!p) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

// ============================================================
// BINANCE API (signed requests)
// ============================================================
function signQuery(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', CONFIG.API_SECRET).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function bnSignedRequest(method, path, params = {}) {
  if (!CONFIG.API_KEY || !CONFIG.API_SECRET) {
    throw new Error('API_KEY or API_SECRET not set');
  }

  params.timestamp = Date.now();
  params.recvWindow = CONFIG.RECV_WINDOW;
  const qs = signQuery(params);

  const url = method === 'GET' ? `${CONFIG.FAPI}${path}?${qs}` : `${CONFIG.FAPI}${path}`;
  const options = {
    method,
    headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
  };
  if (method !== 'GET') {
    options.body = qs;
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Binance ${method} ${path}: ${r.status} ${text}`);
  }
  return JSON.parse(text);
}

async function bnPublicRequest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${CONFIG.FAPI}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance public ${path}: ${r.status}`);
  return r.json();
}

// ============================================================
// POSITIONS & ORDERS
// ============================================================
async function getPositions() {
  // positionRisk даёт все позиции (включая закрытые с amt=0)
  const data = await bnSignedRequest('GET', '/fapi/v2/positionRisk');
  return data.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
    symbol: p.symbol,
    side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
    positionAmt: Math.abs(parseFloat(p.positionAmt)),
    entryPrice: parseFloat(p.entryPrice),
    markPrice: parseFloat(p.markPrice),
    unRealizedProfit: parseFloat(p.unRealizedProfit),
    leverage: parseFloat(p.leverage),
    marginType: p.marginType,       // isolated / cross
    isolatedWallet: parseFloat(p.isolatedWallet || 0),
    positionSide: p.positionSide,   // BOTH / LONG / SHORT (hedge mode)
  }));
}

async function getOpenOrders(symbol) {
  return bnSignedRequest('GET', '/fapi/v1/openOrders', { symbol });
}

// Найти существующий STOP_MARKET для этой позиции (reduceOnly=true)
function findActiveStopOrder(orders, positionSide) {
  return orders.find(o =>
    (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
    o.reduceOnly === true &&
    // В hedge mode positionSide либо LONG либо SHORT; в one-way BOTH
    (o.positionSide === positionSide || o.positionSide === 'BOTH')
  );
}

async function cancelOrder(symbol, orderId) {
  return bnSignedRequest('DELETE', '/fapi/v1/order', { symbol, orderId });
}

// Поставить STOP_MARKET закрывающий всю позицию
async function placeStopMarket(position, stopPrice) {
  // Для LONG → side='SELL', для SHORT → side='BUY'
  const side = position.side === 'LONG' ? 'SELL' : 'BUY';

  // stopPrice нужно округлить до правильного tick size
  const symbolInfo = await getSymbolFilters(position.symbol);
  const priceStr = roundToTick(stopPrice, symbolInfo.tickSize);

  const params = {
    symbol: position.symbol,
    side,
    type: 'STOP_MARKET',
    stopPrice: priceStr,
    closePosition: 'true',           // закрывает всю позицию
    workingType: 'MARK_PRICE',       // триггер по mark price (стандарт)
    priceProtect: 'true',
  };

  // hedge mode: указываем positionSide; one-way: можно BOTH
  if (position.positionSide !== 'BOTH') {
    params.positionSide = position.positionSide;
  }

  return bnSignedRequest('POST', '/fapi/v1/order', params);
}

// ============================================================
// SYMBOL FILTERS (для округления до валидного tick size)
// ============================================================
let exchangeInfoCache = null;
let exchangeInfoTs = 0;

async function getExchangeInfo() {
  // кэш на 1 час
  if (exchangeInfoCache && Date.now() - exchangeInfoTs < 60 * 60 * 1000) {
    return exchangeInfoCache;
  }
  const data = await bnPublicRequest('/fapi/v1/exchangeInfo');
  exchangeInfoCache = data;
  exchangeInfoTs = Date.now();
  return data;
}

async function getSymbolFilters(symbol) {
  const info = await getExchangeInfo();
  const sym = info.symbols.find(s => s.symbol === symbol);
  if (!sym) throw new Error(`Symbol ${symbol} not found`);
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    tickSize: parseFloat(priceFilter.tickSize),
    pricePrecision: sym.pricePrecision,
  };
}

function roundToTick(price, tickSize) {
  const rounded = Math.round(price / tickSize) * tickSize;
  // определяем precision по tickSize
  const precision = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return rounded.toFixed(precision);
}

// ============================================================
// ATR CALCULATION
// ============================================================
async function getATR(symbol) {
  const klines = await bnPublicRequest('/fapi/v1/klines', {
    symbol,
    interval: CONFIG.ATR_TIMEFRAME,
    limit: CONFIG.ATR_LEN + 50,
  });
  if (!klines || klines.length < CONFIG.ATR_LEN + 1) return null;

  const bars = klines.map(k => ({
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr1 = bars[i].high - bars[i].low;
    const tr2 = Math.abs(bars[i].high - bars[i - 1].close);
    const tr3 = Math.abs(bars[i].low - bars[i - 1].close);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  let atr = trs.slice(0, CONFIG.ATR_LEN).reduce((a, b) => a + b, 0) / CONFIG.ATR_LEN;
  for (let i = CONFIG.ATR_LEN; i < trs.length; i++) {
    atr = (atr * (CONFIG.ATR_LEN - 1) + trs[i]) / CONFIG.ATR_LEN;
  }
  return atr;
}

// ============================================================
// SL CALCULATION
// ============================================================
function calculateTargetSL(position, atr) {
  const entry = position.entryPrice;
  const pctDist = entry * (CONFIG.SL_MIN_PCT / 100);
  const atrDist = atr * CONFIG.SL_ATR_MULT;
  const stopDist = Math.max(pctDist, atrDist);

  if (position.side === 'LONG') {
    return {
      targetSL: entry - stopDist,
      stopDist,
      pctDist,
      atrDist,
      method: atrDist > pctDist ? 'atr' : 'pct',
    };
  } else {
    return {
      targetSL: entry + stopDist,
      stopDist,
      pctDist,
      atrDist,
      method: atrDist > pctDist ? 'atr' : 'pct',
    };
  }
}

// ============================================================
// MAIN LOGIC
// ============================================================
async function processPosition(position) {
  const { symbol, side, entryPrice } = position;

  // 1. Получить ATR и рассчитать правильный SL
  const atr = await getATR(symbol);
  if (atr === null) {
    logAction('error', { symbol, msg: 'ATR not available' });
    return;
  }
  const calc = calculateTargetSL(position, atr);

  // 2. Получить текущие открытые ордера по символу
  const orders = await getOpenOrders(symbol);
  const existingStop = findActiveStopOrder(orders, position.positionSide);

  // 3. Принять решение
  if (!existingStop) {
    // НЕТ стопа → ставим
    try {
      await placeStopMarket(position, calc.targetSL);
      logAction('placed', {
        symbol, side, entry: entryPrice, sl: calc.targetSL,
        method: calc.method, atrPct: (atr / entryPrice * 100).toFixed(2),
      });

      const riskPct = (calc.stopDist / entryPrice * 100).toFixed(2);
      const emoji = side === 'LONG' ? '🟢' : '🔴';
      await sendTelegram(
        `🛡 <b>SL установлен</b> ${emoji}\n\n` +
        `<b>${symbol}</b> ${side}\n` +
        `Entry: <code>${fmtPrice(entryPrice)}</code>\n` +
        `SL: <code>${fmtPrice(calc.targetSL)}</code>\n` +
        `Метод: ${calc.method === 'atr' ? '2×ATR' : '1% fixed'}\n` +
        `Риск: ${riskPct}% от цены`
      );
    } catch (e) {
      logAction('error', { symbol, msg: `place SL failed: ${e.message}` });
      await sendTelegram(`❌ SL Guardian: не смог поставить SL на ${symbol}\n${e.message}`);
    }
    return;
  }

  // СЬТЬЕСТВУЕТ стоп
  const currentSL = parseFloat(existingStop.stopPrice);
  const currentSLDist = side === 'LONG' ? entryPrice - currentSL : currentSL - entryPrice;
  const currentSLPct = currentSLDist / entryPrice * 100;
  const targetSLPct = calc.stopDist / entryPrice * 100;

  // Дальше или ближе?
  // LONG: currentSL ниже entry. Если currentSL < targetSL → stop БЛИЖЕ к entry? Нет:
  //   если stopDist меньше → стоп ближе (жёсткий, меньше риск)
  //   если stopDist больше → стоп дальше (слабый, больше риск)
  const diffPct = targetSLPct - currentSLPct;

  if (diffPct < -CONFIG.SL_ADJUST_THRESHOLD) {
    // текущий SL ДАЛЬШЕ правильного (риск больше чем надо) → зажимаем
    try {
      await cancelOrder(symbol, existingStop.orderId);
      await placeStopMarket(position, calc.targetSL);
      logAction('tightened', {
        symbol, side,
        oldSL: currentSL, newSL: calc.targetSL,
        oldRiskPct: currentSLPct.toFixed(2), newRiskPct: targetSLPct.toFixed(2),
      });

      const emoji = side === 'LONG' ? '🟢' : '🔴';
      await sendTelegram(
        `🔒 <b>SL зажат</b> ${emoji}\n\n` +
        `<b>${symbol}</b> ${side}\n` +
        `Был: <code>${fmtPrice(currentSL)}</code> (риск ${currentSLPct.toFixed(2)}%)\n` +
        `Стал: <code>${fmtPrice(calc.targetSL)}</code> (риск ${targetSLPct.toFixed(2)}%)\n` +
        `Метод: ${calc.method === 'atr' ? '2×ATR' : '1% fixed'}`
      );
    } catch (e) {
      logAction('error', { symbol, msg: `tighten SL failed: ${e.message}` });
      await sendTelegram(`❌ SL Guardian: не смог зажать SL на ${symbol}\n${e.message}`);
    }
  } else if (diffPct > CONFIG.SL_ADJUST_THRESHOLD) {
    // текущий SL БЛИЖЕ правильного (юзер сам зажал) → НЕ трогаем
    // просто логируем
    logAction('user_stop_kept', {
      symbol, side, currentSL, currentRiskPct: currentSLPct.toFixed(2),
    });
  }
  // иначе — SL почти правильный, ничего не делаем
}

async function runCheck() {
  state.lastCheckAt = new Date().toISOString();
  try {
    const positions = await getPositions();
    if (positions.length === 0) {
      // нет позиций — ничего не делаем
      return;
    }
    console.log(`[sl] checking ${positions.length} open positions`);
    for (const pos of positions) {
      await processPosition(pos);
    }
    state.lastError = null;
    await saveState();
  } catch (e) {
    state.lastError = e.message;
    console.error('[sl] runCheck error:', e.message);
    logAction('check_error', { msg: e.message });
    await saveState();
  }
}

// ============================================================
// HTTP DASHBOARD
// ============================================================
function renderHTML() {
  const actionsReversed = [...state.actions].reverse().slice(0, 50);
  const rows = actionsReversed.map(a => {
    const when = new Date(a.time).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
    let color = '#9ca3af';
    let label = a.type;
    if (a.type === 'placed') { color = '#10b981'; label = '🛡 Placed'; }
    else if (a.type === 'tightened') { color = '#fbbf24'; label = '🔒 Tightened'; }
    else if (a.type === 'user_stop_kept') { color = '#3b82f6'; label = '✋ User SL kept'; }
    else if (a.type === 'error' || a.type === 'check_error') { color = '#ef4444'; label = '❌ Error'; }

    const details = Object.entries(a)
      .filter(([k]) => !['time', 'type'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(6) : v}`).join(' · ');

    return `<tr>
      <td class="time">${when}</td>
      <td><span class="bdg" style="background:${color}">${label}</span></td>
      <td class="det">${details}</td>
    </tr>`;
  }).join('');

  const status = state.lastError ? '❌ ERROR: ' + state.lastError : state.lastCheckAt ? '✅ OK' : '⏳ Starting';
  const lastCheck = state.lastCheckAt ? new Date(state.lastCheckAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : '-';

  const countByType = {};
  for (const a of state.actions) countByType[a.type] = (countByType[a.type] || 0) + 1;

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SL Guardian</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0a0e1a;color:#e5e7eb;margin:0;padding:20px}
  h1{margin:0 0 10px 0;font-size:22px;color:#fff}h1 span{color:#6b7280;font-weight:400;font-size:14px}
  h2{color:#e5e7eb;font-size:16px;margin:25px 0 10px 0}
  .hdr{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:15px}
  .status{background:#1f2937;padding:12px 15px;border-radius:6px;border:1px solid #374151;margin-bottom:20px}
  .status b{display:block;color:#fff;font-size:14px;margin-bottom:5px}
  .status span{color:#9ca3af;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
  .sb{background:#1f2937;padding:10px 12px;border-radius:6px;border:1px solid #374151}
  .sb b{color:#fff;font-size:18px;display:block}.sb span{color:#9ca3af;font-size:11px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;font-size:13px}
  th{background:#1f2937;color:#9ca3af;padding:10px 8px;text-align:left;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:2px solid #374151}
  td{padding:8px;border-bottom:1px solid #1f2937}
  tr:hover{background:#1a2332}
  .time{color:#6b7280;font-size:11px;white-space:nowrap}
  .det{color:#d1d5db;font-family:monospace;font-size:11px}
  .bdg{color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;white-space:nowrap}
  .rfr{background:#2563eb;color:#fff;padding:8px 18px;border:none;border-radius:6px;font-size:13px;text-decoration:none}
  .warn{background:#422006;padding:10px 15px;border-radius:6px;margin-bottom:15px;font-size:12px;color:#fbbf24;border-left:3px solid #fbbf24}
  .ok{background:#042f2e;padding:10px 15px;border-radius:6px;margin-bottom:15px;font-size:12px;color:#34d399;border-left:3px solid #10b981}
</style></head><body>
<div class="hdr">
  <div><h1>🛡 SL Guardian <span>· Binance USDT-M · max(1%, 2×ATR)</span></h1></div>
  <a href="/" class="rfr">↻ Обновить</a>
</div>

<div class="${state.lastError ? 'warn' : 'ok'}">
  Статус: <b>${status}</b><br>
  Последняя проверка: ${lastCheck} · Проверки каждые ${CONFIG.CHECK_INTERVAL_MS / 1000} сек
</div>

<div class="grid">
  <div class="sb"><b style="color:#10b981">${countByType.placed || 0}</b><span>SL поставлено</span></div>
  <div class="sb"><b style="color:#fbbf24">${countByType.tightened || 0}</b><span>SL зажато</span></div>
  <div class="sb"><b style="color:#3b82f6">${countByType.user_stop_kept || 0}</b><span>Юзерский SL</span></div>
  <div class="sb"><b style="color:#ef4444">${(countByType.error || 0) + (countByType.check_error || 0)}</b><span>Ошибок</span></div>
  <div class="sb"><b>${state.actions.length}</b><span>Всего действий</span></div>
</div>

<h2>Последние 50 действий</h2>
<table><thead><tr><th>Время</th><th>Тип</th><th>Детали</th></tr></thead><tbody>${rows || '<tr><td colspan="3" style="text-align:center;color:#6b7280;padding:20px">Пока нет действий</td></tr>'}</tbody></table>

<div style="margin-top:30px;color:#6b7280;font-size:11px;text-align:center">
  SL Guardian следит за риском. Не открывает и не закрывает позиции.<br>
  Start: ${new Date(state.startedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}
</div>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: state.lastError ? 'error' : 'ok', lastCheck: state.lastCheckAt, lastError: state.lastError }));
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state));
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
  if (!CONFIG.API_KEY || !CONFIG.API_SECRET) {
    console.error('[sl] ERROR: BINANCE_API_KEY or BINANCE_API_SECRET not set in environment');
    console.error('[sl] Set them via: PORT=8088 BINANCE_API_KEY=xxx BINANCE_API_SECRET=yyy pm2 start ...');
    process.exit(1);
  }

  await loadState();
  server.listen(CONFIG.PORT, () => {
    console.log(`[sl] SL Guardian listening on ${CONFIG.PORT}`);
  });

  // Startup check — проверка API
  try {
    const positions = await getPositions();
    console.log(`[sl] API OK, found ${positions.length} open positions`);
    await sendTelegram(
      `🛡 <b>SL Guardian запущен</b>\n\n` +
      `Binance USDT-M Futures\n` +
      `Правило: <code>max(1%, 2×ATR(14, 4H))</code>\n` +
      `Политика: не трогает жёсткий SL юзера\n\n` +
      `Открытых позиций: ${positions.length}\n` +
      `Проверки каждые ${CONFIG.CHECK_INTERVAL_MS / 1000} сек`
    );
  } catch (e) {
    console.error('[sl] startup API test failed:', e.message);
    await sendTelegram(`❌ SL Guardian: startup API failure\n${e.message}`);
    process.exit(1);
  }

  // первая проверка через 5 сек
  setTimeout(runCheck, 5000);
  setInterval(runCheck, CONFIG.CHECK_INTERVAL_MS);
}

main().catch(e => {
  console.error('[sl] fatal:', e);
  process.exit(1);
});
