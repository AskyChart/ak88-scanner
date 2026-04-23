// ============================================================
// AK88 AZLS Backtest — исторический симулятор стратегии
// 2 года 4H истории, top-30 монет, анализ по Score-диапазонам
// Запуск: node backtest_azls.js
// Результат: HTML отчёт в backtest_report.html
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // Data range
  YEARS_BACK: 2,
  TOP_SYMBOLS: 30,

  // Strategy params (как в paper trader)
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

  // Risk
  START_BALANCE: 10000,
  RISK_PCT: 1.0,
  MAX_CONCURRENT: 5,
  MIN_SCORE: 60,
  TP1_FRACTION: 0.333,
  TP2_FRACTION: 0.333,
  TP3_FRACTION: 0.334,
  MOVE_TO_BE_AFTER_TP1: true,

  // Costs
  COMMISSION_PCT: 0.04,       // 0.04% taker fee Binance futures
  SLIPPAGE_PCT: 0.05,         // 0.05% slippage

  // API
  BINANCE: 'https://fapi.binance.com',
  KLINES_LIMIT: 1000,         // max per request
  CONCURRENCY: 5,

  // Output
  REPORT_FILE: path.join(__dirname, 'backtest_report.html'),
  CACHE_DIR: path.join(__dirname, 'backtest_cache'),
};

// ============================================================
// DATA FETCHING
// ============================================================
async function getTopSymbols() {
  console.log('[bt] fetching top symbols...');
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
  // Пагинация: запрашиваем пачками по 1000 баров назад во времени
  const now = Date.now();
  const startTarget = now - years * 365 * 24 * 60 * 60 * 1000;

  const all = [];
  let endTime = now;
  let iter = 0;
  const maxIter = 20;

  while (iter < maxIter) {
    iter++;
    const page = await fetchKlinesPage(symbol, interval, endTime, CONFIG.KLINES_LIMIT);
    if (!page || page.length === 0) break;

    all.push(...page);

    const oldest = page[0].time;
    if (oldest <= startTarget) break;

    endTime = oldest - 1;
    await new Promise(r => setTimeout(r, 100));  // лёгкая пауза
  }

  // Дедупликация и сортировка
  const seen = new Set();
  const unique = all.filter(k => {
    if (seen.has(k.time)) return false;
    seen.add(k.time);
    return true;
  });
  unique.sort((a, b) => a.time - b.time);

  // Отфильтровать по startTarget
  return unique.filter(k => k.time >= startTarget);
}

async function loadOrFetch(symbol, interval, years, cacheDir) {
  const cacheFile = path.join(cacheDir, `${symbol}_${interval}_${years}y.json`);
  try {
    const raw = await fs.readFile(cacheFile, 'utf-8');
    const cached = JSON.parse(raw);
    // Инвалидация кэша: если последний бар старше 1 дня
    const ageMs = Date.now() - cached[cached.length - 1].time;
    if (ageMs < 24 * 60 * 60 * 1000) {
      return cached;
    }
  } catch (e) {
    // нет кэша
  }

  const data = await fetchAllKlines(symbol, interval, years);
  if (data && data.length > 0) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(data), 'utf-8');
  }
  return data;
}

// ============================================================
// INDICATORS (идентичны сканеру)
// ============================================================
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

function computeRSISeries(closes, length) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / length;
  let avgLoss = losses / length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (length - 1) + g) / length;
    avgLoss = (avgLoss * (length - 1) + l) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
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

function computeADXSeries(klines, length) {
  const out = new Array(klines.length).fill(null);
  const diPOut = new Array(klines.length).fill(null);
  const diMOut = new Array(klines.length).fill(null);
  if (klines.length < length * 2 + 1) return { adx: out, diPlus: diPOut, diMinus: diMOut };

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
    diPOut[i + 1] = diP;
    diMOut[i + 1] = diM;
  }

  if (dxArr.length >= length) {
    let adx = dxArr.slice(0, length).reduce((a, b) => a + b, 0) / length;
    out[length * 2] = adx;
    for (let i = length; i < dxArr.length; i++) {
      adx = (adx * (length - 1) + dxArr[i]) / length;
      out[i + length + 1] = adx;
    }
  }

  return { adx: out, diPlus: diPOut, diMinus: diMOut };
}

function computeSMASeries(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  let sum = values.slice(0, length).reduce((a, b) => a + b, 0);
  out[length - 1] = sum / length;
  for (let i = length; i < values.length; i++) {
    sum += values[i] - values[i - length];
    out[i] = sum / length;
  }
  return out;
}

// Pivots detected at bar index `i` confirmed by pivotLen bars after
// Returns array of pivots with confirmation time = klines[i+pivotLen].time
function findPivotsHistorical(klines, pivotLen) {
  const pivots = [];
  for (let i = pivotLen; i < klines.length - pivotLen; i++) {
    let isH = true, isL = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isH = false;
      if (klines[j].low <= klines[i].low) isL = false;
    }
    if (isH) pivots.push({ index: i, type: 'H', price: klines[i].high, confirmedAt: i + pivotLen });
    if (isL) pivots.push({ index: i, type: 'L', price: klines[i].low, confirmedAt: i + pivotLen });
  }
  return pivots;
}

// Weekly context — возвращает массив EMA50 по времени,
// для каждой 4H свечи выдаёт соответствующее weekly значение
function computeWeeklyContext(k4h, k1w) {
  const wCloses = k1w.map(k => k.close);
  const wEmaArr = computeEMASeries(wCloses, CONFIG.CTX_EMA_LEN);

  // Для каждого 4h бара находим последний завершённый weekly бар до него
  const wTimesEnd = k1w.map(k => k.time + 7 * 24 * 60 * 60 * 1000);  // конец недели
  const weeklyCloseAt = new Array(k4h.length).fill(null);
  const weeklyEmaAt = new Array(k4h.length).fill(null);

  let wIdx = 0;
  for (let i = 0; i < k4h.length; i++) {
    const t = k4h[i].time;
    // находим последний завершённый weekly
    while (wIdx + 1 < k1w.length && wTimesEnd[wIdx + 1] <= t) wIdx++;
    if (wTimesEnd[wIdx] <= t && wEmaArr[wIdx] !== null) {
      weeklyCloseAt[i] = k1w[wIdx].close;
      weeklyEmaAt[i] = wEmaArr[wIdx];
    }
  }
  return { weeklyCloseAt, weeklyEmaAt };
}

// ============================================================
// BACKTEST SIMULATION
// ============================================================
function simulateTicker(symbol, k4h, k1w) {
  if (k4h.length < 250 || k1w.length < 55) return { trades: [] };

  // Предвычислить все индикаторы один раз
  const closes = k4h.map(k => k.close);
  const emaFastArr = computeEMASeries(closes, CONFIG.EMA_FAST);
  const emaSlowArr = computeEMASeries(closes, CONFIG.EMA_SLOW);
  const emaLongArr = computeEMASeries(closes, CONFIG.EMA_LONG);
  const atrArr = computeATRSeries(k4h, CONFIG.ATR_LEN);
  const adxData = computeADXSeries(k4h, CONFIG.ADX_LEN);
  const rsiArr = computeRSISeries(closes, CONFIG.RSI_LEN);
  const volumes = k4h.map(k => k.volume);
  const volShortArr = computeSMASeries(volumes, 10);
  const volMidArr = computeSMASeries(volumes, 30);

  const { weeklyCloseAt, weeklyEmaAt } = computeWeeklyContext(k4h, k1w);

  // Все пивоты (будут добавляться в накопительный список по мере confirmation)
  const allPivots = findPivotsHistorical(k4h, CONFIG.PIVOT_LEN);

  const trades = [];
  let openPosition = null;

  const startBar = 220;  // ждём чтобы индикаторы устаканились

  for (let i = startBar; i < k4h.length; i++) {
    const bar = k4h[i];

    // 1. Проверить открытую позицию (SL/TP)
    if (openPosition) {
      updatePosition(openPosition, bar, trades);
      if (openPosition.status === 'closed') {
        openPosition = null;
      }
    }

    // 2. Если позиция уже есть — пропускаем поиск нового сетапа
    if (openPosition) continue;

    // 3. Найти сетап на этом баре (используя только данные <= i)
    const wClose = weeklyCloseAt[i];
    const wEma = weeklyEmaAt[i];
    if (wClose === null || wEma === null) continue;

    const isLong = wClose > wEma;
    const isShort = !isLong;

    // Пивоты подтверждённые к этому моменту (confirmedAt <= i)
    // Ищем свежую пару anchor→target
    let anchor = null, target = null;

    // Только пивоты подтверждённые до или на этом баре
    const validPivots = [];
    for (const p of allPivots) {
      if (p.confirmedAt > i) break;  // т.к. allPivots упорядочен по index
      validPivots.push(p);
    }
    if (validPivots.length < 2) continue;

    const anchorType = isShort ? 'H' : 'L';
    const targetType = isShort ? 'L' : 'H';

    outer: for (let pi = validPivots.length - 1; pi >= 0; pi--) {
      if (validPivots[pi].type !== anchorType) continue;
      const a = validPivots[pi];
      for (let pj = pi + 1; pj < validPivots.length; pj++) {
        if (validPivots[pj].type !== targetType) continue;
        const t = validPivots[pj];
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
    if (!anchor || !target) continue;

    // Инвалидация и возраст
    if (isShort && bar.close > anchor.price) continue;
    if (isLong && bar.close < anchor.price) continue;
    const ageBars = i - target.index;
    if (ageBars > CONFIG.MAX_AGE_BARS) continue;

    // Зоны и уровни
    const range = Math.abs(anchor.price - target.price);
    const atr = atrArr[i];
    if (atr === null) continue;

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

    // Проверка триггера
    const touchedZone = isShort ? bar.high >= zoneLow : bar.low <= zoneHigh;
    if (!touchedZone) continue;

    const bRange = bar.high - bar.low;
    const upper = bar.high - Math.max(bar.open, bar.close);
    const lower = Math.min(bar.open, bar.close) - bar.low;
    const bearRej = bRange > 0 && upper / bRange >= 0.5 && bar.close < bar.open && bar.high >= zoneLow;
    const bullRej = bRange > 0 && lower / bRange >= 0.5 && bar.close > bar.open && bar.low <= zoneHigh;
    const triggerNow = (isShort && bearRej) || (isLong && bullRej);
    if (!triggerNow) continue;

    // Score
    let htfScore = 0;
    if (isShort) {
      if (wClose < wEma) htfScore = 25;
      else if (wClose < wEma * 1.02) htfScore = 12;
    } else {
      if (wClose > wEma) htfScore = 25;
      else if (wClose > wEma * 0.98) htfScore = 12;
    }

    const emaFast = emaFastArr[i];
    const emaSlow = emaSlowArr[i];
    const emaLongV = emaLongArr[i];
    let trendScore = 0;
    if (emaFast !== null && emaSlow !== null && emaLongV !== null) {
      if (isShort) {
        if (emaFast < emaSlow && emaSlow < emaLongV && bar.close < emaFast) trendScore = 20;
        else if (emaFast < emaSlow && bar.close < emaSlow) trendScore = 12;
        else if (bar.close < emaSlow) trendScore = 6;
      } else {
        if (emaFast > emaSlow && emaSlow > emaLongV && bar.close > emaFast) trendScore = 20;
        else if (emaFast > emaSlow && bar.close > emaSlow) trendScore = 12;
        else if (bar.close > emaSlow) trendScore = 6;
      }
    }

    const adxVal = adxData.adx[i];
    const diP = adxData.diPlus[i];
    const diM = adxData.diMinus[i];
    let adxScore = 0;
    if (adxVal !== null && diP !== null && diM !== null) {
      if (isShort) {
        if (adxVal > 25 && diM > diP) adxScore = 15;
        else if (adxVal > 20 && diM > diP) adxScore = 10;
        else if (diM > diP) adxScore = 5;
      } else {
        if (adxVal > 25 && diP > diM) adxScore = 15;
        else if (adxVal > 20 && diP > diM) adxScore = 10;
        else if (diP > diM) adxScore = 5;
      }
    }

    const barsInMove = Math.max(target.index - anchor.index, 1);
    const movePctVal = range / (isShort ? anchor.price : target.price) * 100;
    const speed = movePctVal / barsInMove;
    let impulseScore = 0;
    if (speed >= 1.5) impulseScore = 15;
    else if (speed >= 0.8) impulseScore = 10;
    else if (speed >= 0.4) impulseScore = 5;

    const v10 = volShortArr[i];
    const v30 = volMidArr[i];
    let volScore = 0;
    if (v10 !== null && v30 !== null && v30 > 0) {
      const vRatio = v10 / v30;
      if (vRatio < 0.7) volScore = 15;
      else if (vRatio < 0.9) volScore = 10;
      else if (vRatio < 1.1) volScore = 5;
    }

    const rsi = rsiArr[i];
    let momScore = 0;
    if (rsi !== null) {
      if (isShort) {
        if (rsi > 60) momScore = 10;
        else if (rsi > 50) momScore = 5;
      } else {
        if (rsi < 40) momScore = 10;
        else if (rsi < 50) momScore = 5;
      }
    }

    const totalScore = Math.round(htfScore + trendScore + adxScore + impulseScore + volScore + momScore);

    // Фильтр по Score
    if (totalScore < CONFIG.MIN_SCORE) continue;

    // Открыть позицию на закрытии триггерного бара
    const entryPrice = bar.close * (isShort ? 1 - CONFIG.SLIPPAGE_PCT / 100 : 1 + CONFIG.SLIPPAGE_PCT / 100);
    const riskPerUnit = Math.abs(entryPrice - slLevel);
    if (riskPerUnit <= 0) continue;

    openPosition = {
      symbol,
      direction: isShort ? 'SELL' : 'BUY',
      openBar: i,
      openTime: bar.time,
      entry: entryPrice,
      originalSL: slLevel,
      currentSL: slLevel,
      tp1, tp2, tp3,
      riskPerUnit,
      score: totalScore,
      htfScore, trendScore, adxScore, impulseScore, volScore, momScore,
      ageBars,
      status: 'open',
      fills: [],
      tp1Hit: false,
      tp2Hit: false,
    };
  }

  // Принудительно закрыть ещё открытую позицию по последней цене
  if (openPosition && openPosition.status === 'open') {
    closeRemaining(openPosition, k4h[k4h.length - 1], 'eof');
    trades.push(openPosition);
  }

  return { trades };
}

function updatePosition(pos, bar, trades) {
  const { high, low } = bar;

  // 1. Сначала проверяем SL (консервативно — если SL и TP в одной свече, считаем что SL раньше)
  const slHit = pos.direction === 'SELL' ? high >= pos.currentSL : low <= pos.currentSL;
  if (slHit) {
    closeRemaining(pos, bar, pos.currentSL === pos.originalSL ? 'stop' : 'be', pos.currentSL);
    trades.push(pos);
    return;
  }

  // 2. TP1
  if (!pos.tp1Hit) {
    const tp1Hit = pos.direction === 'SELL' ? low <= pos.tp1 : high >= pos.tp1;
    if (tp1Hit) {
      recordFill(pos, CONFIG.TP1_FRACTION, pos.tp1, 'tp1');
      pos.tp1Hit = true;
      if (CONFIG.MOVE_TO_BE_AFTER_TP1) pos.currentSL = pos.entry;
    }
  }

  // 3. TP2
  if (!pos.tp2Hit) {
    const tp2Hit = pos.direction === 'SELL' ? low <= pos.tp2 : high >= pos.tp2;
    if (tp2Hit) {
      recordFill(pos, CONFIG.TP2_FRACTION, pos.tp2, 'tp2');
      pos.tp2Hit = true;
    }
  }

  // 4. TP3 — закрывает остаток
  const tp3Hit = pos.direction === 'SELL' ? low <= pos.tp3 : high >= pos.tp3;
  if (tp3Hit) {
    closeRemaining(pos, bar, 'tp3', pos.tp3);
    trades.push(pos);
  }
}

function recordFill(pos, fraction, price, reason) {
  const pnlPerUnit = pos.direction === 'SELL' ? (pos.entry - price) : (price - pos.entry);
  const pnlR = (pnlPerUnit / pos.riskPerUnit) * fraction;
  // Комиссия обоих направлений
  const comm = 2 * CONFIG.COMMISSION_PCT / 100 * fraction;
  pos.fills.push({ reason, price, fraction, pnlR: pnlR - comm });
}

function closeRemaining(pos, bar, reason, price) {
  // Сколько осталось незакрытой позиции
  const alreadyClosed = pos.fills.reduce((s, f) => s + f.fraction, 0);
  const remaining = 1 - alreadyClosed;
  if (remaining > 0.0001) {
    const closePrice = price !== undefined ? price : bar.close;
    const pnlPerUnit = pos.direction === 'SELL' ? (pos.entry - closePrice) : (closePrice - pos.entry);
    const pnlR = (pnlPerUnit / pos.riskPerUnit) * remaining;
    const comm = 2 * CONFIG.COMMISSION_PCT / 100 * remaining;
    pos.fills.push({ reason, price: closePrice, fraction: remaining, pnlR: pnlR - comm });
  }
  pos.status = 'closed';
  pos.closeBar = bar.time ? null : null;
  pos.closeTime = bar.time;
  pos.closeReason = reason;
  pos.totalR = pos.fills.reduce((s, f) => s + f.pnlR, 0);
}

// ============================================================
// PORTFOLIO SIMULATION (объединяет trades всех тикеров в равновзвешенный портфель)
// ============================================================
function simulatePortfolio(allTrades) {
  // Сортируем по времени открытия
  allTrades.sort((a, b) => a.openTime - b.openTime);

  let balance = CONFIG.START_BALANCE;
  let peak = balance;
  let maxDD = 0;
  const openPositions = [];
  const equityPoints = [{ time: allTrades[0]?.openTime || Date.now(), balance }];
  const skipped = [];
  const executed = [];

  for (const t of allTrades) {
    // Закрыть позиции у которых closeTime <= t.openTime
    for (let i = openPositions.length - 1; i >= 0; i--) {
      if (openPositions[i].closeTime <= t.openTime) {
        const pos = openPositions[i];
        const pnl = pos.riskUsd * pos.totalR;
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        equityPoints.push({ time: pos.closeTime, balance });
        openPositions.splice(i, 1);
      }
    }

    // Можно ли открыть новую?
    if (openPositions.length >= CONFIG.MAX_CONCURRENT) {
      skipped.push(t);
      continue;
    }

    const riskUsd = balance * CONFIG.RISK_PCT / 100;
    t.riskUsd = riskUsd;
    openPositions.push(t);
    executed.push(t);
  }

  // Закрыть оставшиеся
  for (const pos of openPositions) {
    const pnl = pos.riskUsd * pos.totalR;
    balance += pnl;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    equityPoints.push({ time: pos.closeTime, balance });
  }

  return { balance, maxDD, equityPoints, executed, skipped };
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

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winrate,
    totalR,
    avgR,
    avgWin,
    avgLoss,
    pf,
  };
}

function statsByScoreBucket(trades) {
  const buckets = {
    '60-69': [],
    '70-79': [],
    '80-89': [],
    '90-100': [],
  };
  for (const t of trades) {
    if (t.score >= 90) buckets['90-100'].push(t);
    else if (t.score >= 80) buckets['80-89'].push(t);
    else if (t.score >= 70) buckets['70-79'].push(t);
    else buckets['60-69'].push(t);
  }
  const result = {};
  for (const [k, v] of Object.entries(buckets)) {
    result[k] = v.length > 0 ? computeStats(v) : null;
  }
  return result;
}

function statsByDirection(trades) {
  return {
    BUY: computeStats(trades.filter(t => t.direction === 'BUY')),
    SELL: computeStats(trades.filter(t => t.direction === 'SELL')),
  };
}

function statsByReason(trades) {
  const byReason = {};
  for (const t of trades) {
    const r = t.closeReason || 'unknown';
    if (!byReason[r]) byReason[r] = 0;
    byReason[r]++;
  }
  return byReason;
}

// ============================================================
// HTML REPORT
// ============================================================
function fmtR(r) {
  if (r === null || r === undefined) return '-';
  return (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
}

function fmtPct(p) {
  if (p === null || p === undefined) return '-';
  return p.toFixed(1) + '%';
}

function fmtUSD(v) {
  return '$' + v.toFixed(2);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

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

  const pointStr = points.map(p => {
    const x = (p.time - minT) / (maxT - minT) * (w - 50) + 30;
    const y = h - 30 - (p.balance - minB) / (maxB - minB) * (h - 60);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const zeroY = h - 30 - (CONFIG.START_BALANCE - minB) / (maxB - minB) * (h - 60);

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;background:#111827;border-radius:8px;margin:20px 0">
    <line x1="30" y1="${zeroY}" x2="${w - 20}" y2="${zeroY}" stroke="#6b7280" stroke-width="1" stroke-dasharray="4 4"/>
    <polyline points="${pointStr}" fill="none" stroke="#10b981" stroke-width="2"/>
    <text x="35" y="${zeroY - 5}" fill="#6b7280" font-size="11">Start $${CONFIG.START_BALANCE}</text>
    <text x="35" y="20" fill="#9ca3af" font-size="12">Max: $${maxB.toFixed(0)}</text>
    <text x="35" y="${h - 10}" fill="#9ca3af" font-size="12">Min: $${minB.toFixed(0)}</text>
    <text x="${w - 200}" y="20" fill="#9ca3af" font-size="12">Final: $${points[points.length - 1].balance.toFixed(0)}</text>
  </svg>`;
}

function renderHTML(data) {
  const { allTrades, portfolio, statsAll, statsBuckets, statsDir, reasonBreakdown, symbolsUsed, executedCount, skippedCount } = data;
  const pnlUsd = portfolio.balance - CONFIG.START_BALANCE;
  const pnlPct = pnlUsd / CONFIG.START_BALANCE * 100;
  const pnlColor = pnlUsd >= 0 ? '#10b981' : '#ef4444';

  const top10Winners = [...allTrades].sort((a, b) => b.totalR - a.totalR).slice(0, 10);
  const top10Losers = [...allTrades].sort((a, b) => a.totalR - b.totalR).slice(0, 10);

  const winnersRows = top10Winners.map(t => `<tr>
    <td>${t.symbol}</td>
    <td><span class="badge" style="background:${t.direction === 'BUY' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num">${t.score}</td>
    <td class="num pnl-win">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const losersRows = top10Losers.map(t => `<tr>
    <td>${t.symbol}</td>
    <td><span class="badge" style="background:${t.direction === 'BUY' ? '#10b981' : '#ef4444'}">${t.direction}</span></td>
    <td class="num">${t.score}</td>
    <td class="num pnl-loss">${fmtR(t.totalR)}</td>
    <td class="time">${fmtDate(t.openTime)} → ${fmtDate(t.closeTime)}</td>
    <td>${t.closeReason}</td>
  </tr>`).join('');

  const reasonRows = Object.entries(reasonBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([r, c]) => `<tr><td>${r}</td><td class="num">${c}</td><td class="num">${fmtPct(c / allTrades.length * 100)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AK88 AZLS Backtest</title>
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
<h1>AK88 AZLS Backtest <span>· ${CONFIG.YEARS_BACK} года · top-${CONFIG.TOP_SYMBOLS} · Score ≥ ${CONFIG.MIN_SCORE}</span></h1>
<div class="meta">
  Проверено ${symbolsUsed} тикеров · ${allTrades.length} сделок (${executedCount} исполнены, ${skippedCount} пропущены из-за лимита ${CONFIG.MAX_CONCURRENT})<br>
  Комиссия: ${CONFIG.COMMISSION_PCT}% × 2 · Slippage: ${CONFIG.SLIPPAGE_PCT}% · Риск: ${CONFIG.RISK_PCT}% на сделку · BE после TP1: ${CONFIG.MOVE_TO_BE_AFTER_TP1 ? 'да' : 'нет'}
</div>

<div class="warn">⚠️ Бэктест отражает только торгуемые сейчас тикеры (survivorship bias). Реальные результаты могут отличаться.</div>

<h2>📊 Итоги портфеля</h2>
<div class="summary">
  <div class="card big">
    <b style="color:${pnlColor}">${fmtUSD(portfolio.balance)}</b>
    <span>Итоговый баланс (старт ${fmtUSD(CONFIG.START_BALANCE)})</span>
  </div>
  <div class="card">
    <b style="color:${pnlColor}">${pnlUsd >= 0 ? '+' : ''}${fmtUSD(pnlUsd)}</b>
    <span>P&amp;L total</span>
  </div>
  <div class="card">
    <b style="color:${pnlColor}">${pnlPct >= 0 ? '+' : ''}${fmtPct(pnlPct)}</b>
    <span>P&amp;L %</span>
  </div>
  <div class="card">
    <b style="color:#ef4444">-${fmtPct(portfolio.maxDD)}</b>
    <span>Max Drawdown</span>
  </div>
  <div class="card">
    <b>${statsAll ? fmtPct(statsAll.winrate) : '-'}</b>
    <span>Winrate</span>
  </div>
  <div class="card">
    <b>${statsAll && statsAll.pf !== Infinity ? statsAll.pf.toFixed(2) : '∞'}</b>
    <span>Profit Factor</span>
  </div>
  <div class="card">
    <b style="color:${statsAll && statsAll.avgR >= 0 ? '#10b981' : '#ef4444'}">${statsAll ? fmtR(statsAll.avgR) : '-'}</b>
    <span>Avg per trade</span>
  </div>
</div>

<h2>📈 Equity curve</h2>
${renderEquitySVG(portfolio.equityPoints)}

<h2>🎯 Общая статистика</h2>
<table><thead><tr>
  <th>Группа</th><th>Сделок</th><th>Winrate</th><th>Total R</th><th>Avg R</th><th>Avg Win</th><th>Avg Loss</th><th>PF</th>
</tr></thead><tbody>
${renderStatsRow('Все сделки', statsAll)}
${renderStatsRow('BUY (лонги)', statsDir.BUY)}
${renderStatsRow('SELL (шорты)', statsDir.SELL)}
</tbody></table>

<h2>🔍 По диапазонам Score</h2>
<table><thead><tr>
  <th>Score</th><th>Сделок</th><th>Winrate</th><th>Total R</th><th>Avg R</th><th>Avg Win</th><th>Avg Loss</th><th>PF</th>
</tr></thead><tbody>
${Object.entries(statsBuckets).map(([k, v]) => renderStatsRow('Score ' + k, v)).join('')}
</tbody></table>

<h2>📋 Исходы сделок</h2>
<table><thead><tr><th>Исход</th><th>Кол-во</th><th>%</th></tr></thead><tbody>
${reasonRows}
</tbody></table>

<h2>🏆 Топ-10 прибыльных</h2>
<table><thead><tr>
  <th>Символ</th><th>Напр</th><th>Score</th><th>R</th><th>Период</th><th>Исход</th>
</tr></thead><tbody>${winnersRows}</tbody></table>

<h2>💀 Топ-10 убыточных</h2>
<table><thead><tr>
  <th>Символ</th><th>Напр</th><th>Score</th><th>R</th><th>Период</th><th>Исход</th>
</tr></thead><tbody>${losersRows}</tbody></table>

<div style="margin-top:40px;color:#6b7280;font-size:12px;text-align:center">
  Бэктест AZLS: ${CONFIG.YEARS_BACK} года 4H истории · top-${CONFIG.TOP_SYMBOLS} Binance USDT-M<br>
  Pivot ${CONFIG.PIVOT_LEN} · Min impulse ${CONFIG.MIN_MOVE_PCT}% · Max age ${CONFIG.MAX_AGE_BARS} баров · Weekly EMA${CONFIG.CTX_EMA_LEN} контекст<br>
  Fibs: zone ${CONFIG.FIB_ZONE_LOW}-${CONFIG.FIB_ZONE_HIGH}, eq ${CONFIG.FIB_EQ}, tp3 ${CONFIG.FIB_TP3}<br>
  Выполнено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}
</div>
</body></html>`;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('AK88 AZLS Backtest');
  console.log('='.repeat(60));
  console.log(`Years: ${CONFIG.YEARS_BACK}, Top symbols: ${CONFIG.TOP_SYMBOLS}, Min score: ${CONFIG.MIN_SCORE}`);
  console.log('');

  const symbols = await getTopSymbols();
  console.log(`[bt] symbols: ${symbols.join(', ')}`);
  console.log('');

  console.log('[bt] fetching data and simulating...');
  const allTrades = [];
  let done = 0;

  for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
    const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (sym) => {
      try {
        const [k4h, k1w] = await Promise.all([
          loadOrFetch(sym, '4h', CONFIG.YEARS_BACK, CONFIG.CACHE_DIR),
          loadOrFetch(sym, '1w', CONFIG.YEARS_BACK + 1, CONFIG.CACHE_DIR),
        ]);
        if (!k4h || !k1w) return { symbol: sym, trades: [] };
        const { trades } = simulateTicker(sym, k4h, k1w);
        return { symbol: sym, trades };
      } catch (e) {
        console.error(`[bt] ${sym} error:`, e.message);
        return { symbol: sym, trades: [] };
      }
    }));
    for (const r of batchResults) {
      done++;
      console.log(`[bt] ${done}/${symbols.length} ${r.symbol}: ${r.trades.length} trades`);
      allTrades.push(...r.trades);
    }
  }

  console.log('');
  console.log(`[bt] total trades: ${allTrades.length}`);

  if (allTrades.length === 0) {
    console.log('[bt] no trades — nothing to report');
    return;
  }

  console.log('[bt] simulating portfolio...');
  const portfolio = simulatePortfolio(allTrades);

  console.log('[bt] computing stats...');
  const statsAll = computeStats(portfolio.executed);
  const statsBuckets = statsByScoreBucket(portfolio.executed);
  const statsDir = statsByDirection(portfolio.executed);
  const reasonBreakdown = statsByReason(portfolio.executed);

  const html = renderHTML({
    allTrades: portfolio.executed,
    portfolio,
    statsAll,
    statsBuckets,
    statsDir,
    reasonBreakdown,
    symbolsUsed: symbols.length,
    executedCount: portfolio.executed.length,
    skippedCount: portfolio.skipped.length,
  });

  await fs.writeFile(CONFIG.REPORT_FILE, html, 'utf-8');
  console.log('');
  console.log(`[bt] ✅ report saved: ${CONFIG.REPORT_FILE}`);
  console.log(`[bt] winrate: ${statsAll.winrate.toFixed(1)}% | avgR: ${statsAll.avgR.toFixed(2)} | PF: ${statsAll.pf.toFixed(2)}`);
  console.log(`[bt] final balance: $${portfolio.balance.toFixed(2)} (${((portfolio.balance - CONFIG.START_BALANCE) / CONFIG.START_BALANCE * 100).toFixed(1)}%)`);
  console.log(`[bt] max DD: ${portfolio.maxDD.toFixed(2)}%`);
}

main().catch(e => {
  console.error('[bt] fatal:', e);
  process.exit(1);
});
