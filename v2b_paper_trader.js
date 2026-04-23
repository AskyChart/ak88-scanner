// ============================================================
// AK88 V2b Paper Trader
// Breakout/TSL стратегия (Chandelier) — крипта 1H, MTF 4H
// Виртуальные сделки, Telegram уведомления
// Параллельно с AZLS paper trader (разная стратегия, отдельный P&L)
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
  // Watchlist
  TOP_SYMBOLS: 50,               // топ-50 самых ликвидных монет
  CONCURRENCY: 10,
  KLINES_1H_LIMIT: 500,          // 500 часовых баров ≈ 20 дней
  KLINES_4H_LIMIT: 300,          // для 4H state

  // Strategy params (из твоего Pine кода)
  SWING_LEN: 3,                  // TSL swing length
  ATR_LEN: 14,
  SL_ATR_MULT: 1.5,              // стоп
  TP_HALF_ATR_MULT: 1.0,         // TP0.5 — частичный выход с переносом в BE
  TP1_ATR_MULT: 2.0,             // TP1 — основной выход
  CHAND_ATR_MULT: 3.0,           // Chandelier после TP1
  TP_HALF_FRACTION: 0.25,        // закрыть 25% на TP0.5
  TP1_FRACTION: 0.30,            // закрыть 30% на TP1
  // остаток 45% ведётся Chandelier

  // Quality filters
  ADX_LEN: 14,
  MIN_ADX: 20,                   // только трендовый рынок
  MIN_BODY_PCT: 0.5,             // тело свечи ≥ 0.5% от цены (импульсный вход)
  MIN_CONFIRM_BARS: 3,           // тренд подтверждён 3 закрытыми свечами

  // Risk
  START_BALANCE: 10000,
  RISK_PER_TRADE_PCT: 1.0,
  MAX_CONCURRENT_POSITIONS: 3,
  MIN_STOP_PCT: 1.0,             // минимальный стоп — 1% от цены
  MAX_NOTIONAL_MULT: 3.0,        // max notional = 3× balance

  // Intervals
  CHECK_INTERVAL_MS: 5 * 60 * 1000,    // проверка новых сигналов: 5 мин
  TICK_INTERVAL_MS: 2 * 60 * 1000,     // проверка открытых: 2 мин

  // Storage
  STATE_FILE: path.join(__dirname, 'v2b_state.json'),
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
    console.log(`[v2b] state loaded: balance=$${state.balance.toFixed(2)}, positions=${state.positions.length}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[v2b] no state file, starting fresh');
      await saveState();
    } else {
      console.error('[v2b] loadState error:', e.message);
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[v2b] saveState error:', e.message);
  }
}

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
      console.error('[v2b][tg] send failed:', r.status, errText);
    }
  } catch (e) {
    console.error('[v2b][tg] error:', e.message);
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
// MARKET DATA (Binance futures)
// ============================================================
async function getTopSymbols() {
  const r = await fetch(`${CONFIG.BINANCE}/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`ticker/24hr failed: ${r.status}`);
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
function highestRange(arr, idx, n, field = 'high') {
  if (idx - n < 0) return null;
  let maxV = -Infinity;
  for (let i = idx - n + 1; i <= idx; i++) {
    if (arr[i][field] > maxV) maxV = arr[i][field];
  }
  return maxV;
}

function lowestRange(arr, idx, n, field = 'low') {
  if (idx - n < 0) return null;
  let minV = Infinity;
  for (let i = idx - n + 1; i <= idx; i++) {
    if (arr[i][field] < minV) minV = arr[i][field];
  }
  return minV;
}

// TSL (Trailing Stop Loss) series — точная копия Pine f_tsl/f_state
function computeTSL(klines, swingLen) {
  const len = klines.length;
  const res = new Array(len).fill(null);  // highest of `swingLen` highs
  const sup = new Array(len).fill(null);  // lowest of `swingLen` lows
  for (let i = 0; i < len; i++) {
    const h = highestRange(klines, i, swingLen, 'high');
    const l = lowestRange(klines, i, swingLen, 'low');
    res[i] = h;
    sup[i] = l;
  }

  // avd: current direction change (1 = crossed up res[-1], -1 = crossed down sup[-1])
  const avd = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    if (res[i - 1] !== null && klines[i].close > res[i - 1]) avd[i] = 1;
    else if (sup[i - 1] !== null && klines[i].close < sup[i - 1]) avd[i] = -1;
    else avd[i] = 0;
  }

  // avn: last non-zero avd (valuewhen)
  const avn = new Array(len).fill(0);
  let lastAvn = 0;
  for (let i = 0; i < len; i++) {
    if (avd[i] !== 0) lastAvn = avd[i];
    avn[i] = lastAvn;
  }

  // tsl: if avn==1 use sup (trailing stop under price), else res
  const tsl = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    tsl[i] = avn[i] === 1 ? sup[i] : res[i];
  }

  // state: 1 if close >= tsl, else -1
  const state = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    if (tsl[i] !== null) state[i] = klines[i].close >= tsl[i] ? 1 : -1;
  }

  return { tsl, avn, state };
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
  return adx;
}

// ============================================================
// SIGNAL DETECTION
// ============================================================
function detectSignal(k1h, k4h) {
  if (!k1h || k1h.length < 50) return null;
  if (!k4h || k4h.length < 50) return null;

  const { tsl: tsl1h, avn: avn1h } = computeTSL(k1h, CONFIG.SWING_LEN);
  const { state: state4h } = computeTSL(k4h, CONFIG.SWING_LEN);

  const lastIdx = k1h.length - 1;
  const last = k1h[lastIdx];

  // 4H state
  const h4State = state4h[state4h.length - 1];

  // Фильтр 1: Тренд подтверждён минимум N закрытыми свечами в нужном направлении на 1H
  const needBars = CONFIG.MIN_CONFIRM_BARS;
  if (lastIdx < needBars) return null;

  // Ищем самый свежий cross (переход avn) за последние 20 баров
  let crossIdx = -1;
  let crossDir = 0;
  for (let i = lastIdx; i >= Math.max(0, lastIdx - 20); i--) {
    if (avn1h[i] !== 0 && avn1h[i - 1] !== 0 && avn1h[i] !== avn1h[i - 1]) {
      crossIdx = i;
      crossDir = avn1h[i];
      break;
    }
  }
  if (crossIdx < 0) return null;

  // С момента cross прошло минимум needBars закрытых свечей (не считая текущую)
  const barsSinceCross = lastIdx - crossIdx;
  if (barsSinceCross < needBars) return null;

  // Слишком старый cross — пропускаем (не входим в уже развившийся тренд)
  if (barsSinceCross > 10) return null;

  // Направление должно совпадать с 4H state
  if (crossDir === 1 && h4State !== 1) return null;
  if (crossDir === -1 && h4State !== -1) return null;

  // После cross все бары должны быть в том же направлении (без flip)
  for (let i = crossIdx; i <= lastIdx; i++) {
    if (avn1h[i] !== crossDir) return null;
  }

  // Проверяем что вход именно СЕЙЧАС — cross был ровно needBars баров назад
  // (чтобы не плодить одинаковые сигналы несколько баров подряд)
  if (barsSinceCross !== needBars) return null;

  // Фильтр 2: Импульсная свеча на последнем баре
  const bodyAbs = Math.abs(last.close - last.open);
  const bodyPct = last.close > 0 ? bodyAbs / last.close * 100 : 0;
  if (bodyPct < CONFIG.MIN_BODY_PCT) return null;

  // Фильтр 3: Направление последней свечи совпадает с сигналом
  if (crossDir === 1 && last.close <= last.open) return null;
  if (crossDir === -1 && last.close >= last.open) return null;

  // Фильтр 4: ADX > MIN_ADX
  const adx = computeADX(k1h, CONFIG.ADX_LEN);
  if (adx === null || adx < CONFIG.MIN_ADX) return null;

  // Фильтр 5: ATR доступен
  const atr = computeATR(k1h, CONFIG.ATR_LEN);
  if (atr === null) return null;

  return {
    direction: crossDir === 1 ? 'LONG' : 'SHORT',
    entry: last.close,
    atr,
    adx: Math.round(adx),
    bodyPct: bodyPct.toFixed(2),
    crossBarsAgo: barsSinceCross,
    currentTsl: tsl1h[lastIdx],
    h4State,
  };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
function hasOpenPosition(symbol) {
  return state.positions.some(p => p.symbol === symbol && p.status === 'open');
}

function countOpen() {
  return state.positions.filter(p => p.status === 'open').length;
}

function openPosition(symbol, signal) {
  if (hasOpenPosition(symbol)) return null;
  if (countOpen() >= CONFIG.MAX_CONCURRENT_POSITIONS) return null;

  const entry = signal.entry;
  const atrStop = signal.atr * CONFIG.SL_ATR_MULT;
  const minStop = entry * (CONFIG.MIN_STOP_PCT / 100);
  const stopDist = Math.max(atrStop, minStop);

  const sl = signal.direction === 'LONG' ? entry - stopDist : entry + stopDist;
  const tpHalf = signal.direction === 'LONG' ? entry + signal.atr * CONFIG.TP_HALF_ATR_MULT : entry - signal.atr * CONFIG.TP_HALF_ATR_MULT;
  const tp1 = signal.direction === 'LONG' ? entry + signal.atr * CONFIG.TP1_ATR_MULT : entry - signal.atr * CONFIG.TP1_ATR_MULT;

  const riskUsd = state.balance * (CONFIG.RISK_PER_TRADE_PCT / 100);
  let size = riskUsd / stopDist;
  // Max notional защита
  const maxNotional = state.balance * CONFIG.MAX_NOTIONAL_MULT;
  const maxSize = maxNotional / entry;
  if (size > maxSize) size = maxSize;

  const positionValue = size * entry;

  const pos = {
    id: crypto.randomUUID().slice(0, 8),
    symbol,
    direction: signal.direction,
    status: 'open',
    openedAt: new Date().toISOString(),
    entry,
    atr: signal.atr,
    originalSL: sl,
    currentSL: sl,
    tpHalf,
    tp1,
    chandStop: null,  // активен после TP1
    highestSinceTP1: null,
    lowestSinceTP1: null,
    size,
    initialSize: size,
    positionValue,
    riskUsd,
    adx: signal.adx,
    bodyPct: signal.bodyPct,
    fills: [],
    pnlRealized: 0,
    pnlR: 0,
    closedAt: null,
    closePrice: null,
    closeReason: null,
  };

  state.positions.push(pos);
  console.log(`[v2b] OPENED ${pos.direction} ${symbol} @ ${entry.toFixed(6)} | SL=${sl.toFixed(6)} | risk=$${riskUsd.toFixed(2)} | ADX=${signal.adx}`);

  const dirEmoji = pos.direction === 'LONG' ? '🟢' : '🔴';
  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P&interval=60`;
  const rr1 = Math.abs(tp1 - entry) / stopDist;
  const msg =
    `${dirEmoji} <b>V2b OPEN ${pos.direction}</b>\n\n` +
    `<b>${symbol}</b> · ADX ${signal.adx} · Body ${signal.bodyPct}%\n` +
    `<a href="${tvUrl}">📈 Открыть график 1H</a>\n\n` +
    `Entry: <code>${fmtP(entry)}</code>\n` +
    `SL: <code>${fmtP(sl)}</code>\n` +
    `TP0.5: <code>${fmtP(tpHalf)}</code> → закрой 25%, BE\n` +
    `TP1: <code>${fmtP(tp1)}</code> (R:R ${rr1.toFixed(2)}) → закрой 30%\n` +
    `Остаток 45% → Chandelier x${CONFIG.CHAND_ATR_MULT} ATR\n\n` +
    `💵 Размер: $${positionValue.toFixed(2)}\n` +
    `⚠️ Риск: $${riskUsd.toFixed(2)} (1R)\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}`;
  sendTelegram(msg);

  return pos;
}

function partialClose(pos, fraction, price, reason) {
  const closeSize = pos.initialSize * fraction;
  if (closeSize > pos.size + 0.0001) return;

  const pnlPerUnit = pos.direction === 'LONG' ? price - pos.entry : pos.entry - price;
  const pnlUsd = pnlPerUnit * closeSize;
  const pnlR = pnlUsd / pos.riskUsd;

  pos.size -= closeSize;
  pos.pnlRealized += pnlUsd;
  pos.pnlR += pnlR;
  state.balance += pnlUsd;

  pos.fills.push({
    reason, price, fraction,
    sizeClosed: closeSize, pnlUsd, pnlR,
    time: new Date().toISOString(),
  });

  console.log(`[v2b] ${reason} ${pos.symbol} @ ${price.toFixed(6)} | pnl=$${pnlUsd.toFixed(2)} (${pnlR.toFixed(2)}R)`);

  const tpEmoji = reason === 'tphalf' ? '🎯' : '💰';
  const tpName = reason === 'tphalf' ? 'TP0.5' : 'TP1';
  const beNote = reason === 'tphalf' ? '\n🛡 SL → безубыток' : '\n🎣 Chandelier активирован';

  const tgMsg =
    `${tpEmoji} <b>V2b ${tpName}: ${pos.symbol}</b>\n\n` +
    `Цена: <code>${fmtP(price)}</code>\n` +
    `Закрыто: ${Math.round(fraction * 100)}%\n` +
    `P&L: <b>${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}</b> (${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R)${beNote}\n\n` +
    `По сделке: ${pos.pnlRealized >= 0 ? '+' : ''}$${pos.pnlRealized.toFixed(2)} (${pos.pnlR >= 0 ? '+' : ''}${pos.pnlR.toFixed(2)}R)\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}`;
  sendTelegram(tgMsg);

  if (reason === 'tphalf') {
    pos.currentSL = pos.entry;  // BE
  } else if (reason === 'tp1') {
    // Активируем Chandelier
    if (pos.direction === 'LONG') {
      pos.highestSinceTP1 = price;
      pos.chandStop = price - pos.atr * CONFIG.CHAND_ATR_MULT;
    } else {
      pos.lowestSinceTP1 = price;
      pos.chandStop = price + pos.atr * CONFIG.CHAND_ATR_MULT;
    }
    pos.currentSL = pos.chandStop;
  }
}

function closePosition(pos, price, reason) {
  if (pos.size > 0.0001) {
    const pnlPerUnit = pos.direction === 'LONG' ? price - pos.entry : pos.entry - price;
    const pnlUsd = pnlPerUnit * pos.size;
    const pnlR = pnlUsd / pos.riskUsd;
    pos.pnlRealized += pnlUsd;
    pos.pnlR += pnlR;
    state.balance += pnlUsd;
    pos.fills.push({
      reason, price, fraction: pos.size / pos.initialSize,
      sizeClosed: pos.size, pnlUsd, pnlR,
      time: new Date().toISOString(),
    });
    pos.size = 0;
  }

  pos.status = 'closed';
  pos.closedAt = new Date().toISOString();
  pos.closePrice = price;
  pos.closeReason = reason;

  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const ddPct = (state.peakBalance - state.balance) / state.peakBalance * 100;
  if (ddPct > state.maxDrawdownPct) state.maxDrawdownPct = ddPct;

  console.log(`[v2b] CLOSED ${pos.symbol} reason=${reason} total_pnl=$${pos.pnlRealized.toFixed(2)}`);

  let emoji, title;
  if (reason === 'stop') { emoji = '🛑'; title = 'СТОП'; }
  else if (reason === 'be') { emoji = '🛡'; title = 'BE (безубыток)'; }
  else if (reason === 'chand') { emoji = '🎣'; title = 'Chandelier выход'; }
  else if (reason === 'tsl_flip') { emoji = '🔄'; title = 'TSL flip'; }
  else { emoji = '📉'; title = 'Closed'; }

  const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${pos.symbol}.P&interval=60`;
  const sign = pos.pnlRealized >= 0 ? '+' : '';
  const tgMsg =
    `${emoji} <b>V2b ${title}: ${pos.symbol}</b>\n\n` +
    `<a href="${tvUrl}">📈 График</a>\n\n` +
    `Close: <code>${fmtP(price)}</code>\n` +
    `Итог: <b>${sign}$${pos.pnlRealized.toFixed(2)}</b> (${sign}${pos.pnlR.toFixed(2)}R)\n\n` +
    `💰 Баланс: <b>$${state.balance.toFixed(2)}</b>\n` +
    `📊 Total: ${(state.balance - state.startBalance) >= 0 ? '+' : ''}$${(state.balance - state.startBalance).toFixed(2)}`;
  sendTelegram(tgMsg);
}

async function updatePosition(pos) {
  const k1h = await getKlines(pos.symbol, '1h', 50);
  if (!k1h || k1h.length === 0) return;
  const last = k1h[k1h.length - 1];

  // Check SL first
  const slHit = pos.direction === 'LONG' ? last.low <= pos.currentSL : last.high >= pos.currentSL;
  if (slHit) {
    let reason;
    if (pos.currentSL === pos.entry) reason = 'be';
    else if (pos.chandStop && Math.abs(pos.currentSL - pos.chandStop) < 0.0001) reason = 'chand';
    else reason = 'stop';
    closePosition(pos, pos.currentSL, reason);
    return;
  }

  // Update Chandelier trailing if active (после TP1)
  const tp1Done = pos.fills.some(f => f.reason === 'tp1');
  if (tp1Done && pos.chandStop !== null) {
    if (pos.direction === 'LONG') {
      if (last.high > pos.highestSinceTP1) {
        pos.highestSinceTP1 = last.high;
        const newStop = pos.highestSinceTP1 - pos.atr * CONFIG.CHAND_ATR_MULT;
        if (newStop > pos.chandStop) {
          pos.chandStop = newStop;
          pos.currentSL = newStop;
        }
      }
    } else {
      if (last.low < pos.lowestSinceTP1) {
        pos.lowestSinceTP1 = last.low;
        const newStop = pos.lowestSinceTP1 + pos.atr * CONFIG.CHAND_ATR_MULT;
        if (newStop < pos.chandStop) {
          pos.chandStop = newStop;
          pos.currentSL = newStop;
        }
      }
    }
  }

  // TP0.5
  const tpHalfDone = pos.fills.some(f => f.reason === 'tphalf');
  if (!tpHalfDone) {
    const hit = pos.direction === 'LONG' ? last.high >= pos.tpHalf : last.low <= pos.tpHalf;
    if (hit) {
      partialClose(pos, CONFIG.TP_HALF_FRACTION, pos.tpHalf, 'tphalf');
    }
  }

  // TP1
  if (!tp1Done) {
    const hit = pos.direction === 'LONG' ? last.high >= pos.tp1 : last.low <= pos.tp1;
    if (hit) {
      partialClose(pos, CONFIG.TP1_FRACTION, pos.tp1, 'tp1');
    }
  }

  // TSL flip exit для всех оставшихся 45% если TSL перевернулся
  const { avn } = computeTSL(k1h, CONFIG.SWING_LEN);
  const currentAvn = avn[avn.length - 1];
  if (pos.direction === 'LONG' && currentAvn === -1) {
    closePosition(pos, last.close, 'tsl_flip');
  } else if (pos.direction === 'SHORT' && currentAvn === 1) {
    closePosition(pos, last.close, 'tsl_flip');
  }
}

// ============================================================
// MAIN LOOPS
// ============================================================
async function analyzeSymbol(symbol) {
  try {
    const [k1h, k4h] = await Promise.all([
      getKlines(symbol, '1h', CONFIG.KLINES_1H_LIMIT),
      getKlines(symbol, '4h', CONFIG.KLINES_4H_LIMIT),
    ]);
    const signal = detectSignal(k1h, k4h);
    return signal ? { symbol, signal } : null;
  } catch (e) {
    return null;
  }
}

async function checkNewSignals() {
  try {
    const symbols = await getTopSymbols();
    const results = [];
    for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
      const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
      const batchResults = await Promise.all(batch.map(analyzeSymbol));
      results.push(...batchResults.filter(r => r !== null));
    }
    for (const r of results) {
      const pos = openPosition(r.symbol, r.signal);
      if (pos) await saveState();
    }
  } catch (e) {
    console.error('[v2b] checkNewSignals error:', e.message);
  }
}

async function tickPositions() {
  const open = state.positions.filter(p => p.status === 'open');
  if (open.length === 0) return;
  for (const pos of open) {
    await updatePosition(pos);
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
  const grossWin = wins.reduce((s, p) => s + p.pnlRealized, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnlRealized, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgR = closed.length > 0 ? closed.reduce((s, p) => s + p.pnlR, 0) / closed.length : 0;
  const longs = closed.filter(p => p.direction === 'LONG');
  const shorts = closed.filter(p => p.direction === 'SHORT');

  return {
    balance: state.balance, startBalance: state.startBalance,
    totalPnl, totalPnlPct, maxDrawdownPct: state.maxDrawdownPct,
    openCount: open.length, closedCount: closed.length,
    winCount: wins.length, lossCount: losses.length,
    winrate, profitFactor, avgR,
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

function renderTable(positions, title, emptyMsg) {
  if (positions.length === 0) {
    return `<h2>${title}</h2><div class="empty">${emptyMsg}</div>`;
  }
  const rows = positions.map(p => {
    const pnlClass = p.pnlRealized > 0 ? 'pnl-win' : p.pnlRealized < 0 ? 'pnl-loss' : 'pnl-neutral';
    const dirColor = p.direction === 'LONG' ? '#10b981' : '#ef4444';
    const statusColor = p.status === 'open' ? '#3b82f6' :
      (p.closeReason === 'stop' ? '#ef4444' :
       p.closeReason === 'be' ? '#6b7280' :
       p.closeReason === 'chand' ? '#10b981' :
       p.closeReason === 'tsl_flip' ? '#f97316' : '#8b5cf6');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${p.symbol}.P&interval=60`;
    const tpHalfDone = p.fills.some(f => f.reason === 'tphalf') ? '✓' : '—';
    const tp1Done = p.fills.some(f => f.reason === 'tp1') ? '✓' : '—';
    const statusText = p.status === 'open' ? 'OPEN' : (p.closeReason || '').toUpperCase();
    return `
      <tr>
        <td><a href="${tvUrl}" target="_blank">${p.symbol}</a></td>
        <td><span class="badge" style="background:${dirColor}">${p.direction}</span></td>
        <td><span class="badge" style="background:${statusColor}">${statusText}</span></td>
        <td class="num">${fmtP(p.entry)}</td>
        <td class="num sl">${fmtP(p.currentSL)}</td>
        <td class="tp">${tpHalfDone} ${fmtP(p.tpHalf)}</td>
        <td class="tp">${tp1Done} ${fmtP(p.tp1)}</td>
        <td class="num">${p.adx}</td>
        <td class="num">$${p.riskUsd.toFixed(2)}</td>
        <td class="num ${pnlClass}">${p.pnlRealized >= 0 ? '+' : ''}$${p.pnlRealized.toFixed(2)}</td>
        <td class="num ${pnlClass}">${p.pnlR >= 0 ? '+' : ''}${p.pnlR.toFixed(2)}R</td>
        <td class="time">${fmtTime(p.openedAt)}</td>
        <td class="time">${fmtTime(p.closedAt)}</td>
      </tr>`;
  }).join('');
  return `<h2>${title} <span class="count">(${positions.length})</span></h2>
    <table><thead><tr>
      <th>Символ</th><th>Напр</th><th>Статус</th><th>Entry</th><th>SL</th>
      <th>TP0.5</th><th>TP1</th><th>ADX</th><th>Risk</th><th>P&L $</th><th>P&L R</th>
      <th>Open</th><th>Close</th>
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
<title>AK88 V2b Paper Trader</title>
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
  .sl{color:#f87171}.tp{color:#34d399;font-size:12px}
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
  <h1>AK88 V2b Paper Trader <span>· breakout/TSL · 1H крипта · top-${CONFIG.TOP_SYMBOLS}</span></h1>
  <a href="/" class="refresh">↻ Обновить</a>
</div>
<div class="warning">⚠️ Paper trading — виртуальные сделки. Стратегия V2b — trend-following с Chandelier trail.</div>

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
    <span>LONG wins</span>
  </div>
  <div class="stat-box">
    <b style="color:#ef4444">${s.shortWins}/${s.shortCount}</b>
    <span>SHORT wins</span>
  </div>
</div>

${renderTable(open, '🔵 Открытые', 'Нет открытых позиций')}
${renderTable(closed, '📊 Закрытые (последние 100)', 'Пока нет закрытых сделок.')}

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Стратегия V2b: TSL cross + 4H state confirm + ADX≥${CONFIG.MIN_ADX} + Body≥${CONFIG.MIN_BODY_PCT}% + ${CONFIG.MIN_CONFIRM_BARS} bars confirm<br>
  SL ATR×${CONFIG.SL_ATR_MULT} · TP0.5 ATR×${CONFIG.TP_HALF_ATR_MULT} (25%, BE) · TP1 ATR×${CONFIG.TP1_ATR_MULT} (30%) · Остаток Chandelier ATR×${CONFIG.CHAND_ATR_MULT}<br>
  Max concurrent ${CONFIG.MAX_CONCURRENT_POSITIONS} · Risk ${CONFIG.RISK_PER_TRADE_PCT}% · Проверка ${CONFIG.CHECK_INTERVAL_MS/60000} мин
</div>
</body></html>`;
}

// ============================================================
// HTTP
// ============================================================
const PORT = process.env.PORT || 8084;
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
      res.end('reset');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;padding:40px"><h2>Сбросить V2b?</h2><p>Удалит все позиции и баланс станет $' + CONFIG.START_BALANCE + '</p><a href="/reset?confirm=yes" style="background:#ef4444;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">Да</a> &nbsp; <a href="/" style="color:#60a5fa">Отмена</a></body></html>');
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
  server.listen(PORT, () => {
    console.log(`[v2b] AK88 V2b Paper Trader listening on port ${PORT}`);
  });

  const startMsg =
    `🚀 <b>V2b Paper Trader запущен</b>\n\n` +
    `Стратегия: Breakout/TSL (trend-following)\n` +
    `Рынок: Крипта 1H · Top-${CONFIG.TOP_SYMBOLS}\n\n` +
    `💰 Баланс: $${state.balance.toFixed(2)}\n` +
    `📊 Открытых: ${state.positions.filter(p => p.status === 'open').length}\n\n` +
    `⚙️ Риск: ${CONFIG.RISK_PER_TRADE_PCT}%\n` +
    `🎯 Max concurrent: ${CONFIG.MAX_CONCURRENT_POSITIONS}\n` +
    `📈 ADX ≥ ${CONFIG.MIN_ADX}\n\n` +
    `Проверка каждые ${CONFIG.CHECK_INTERVAL_MS/60000} мин`;
  sendTelegram(startMsg);

  setTimeout(async () => {
    await checkNewSignals();
    await tickPositions();
  }, 30000);

  setInterval(checkNewSignals, CONFIG.CHECK_INTERVAL_MS);
  setInterval(tickPositions, CONFIG.TICK_INTERVAL_MS);
}

main().catch(e => {
  console.error('[v2b] fatal:', e);
  process.exit(1);
});
