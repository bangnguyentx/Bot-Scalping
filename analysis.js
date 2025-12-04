const axios = require('axios');

/**
 * analysis.js
 * - TF chính: M5 (entry trigger) + M15 (main analysis) + H1 (filter)
 * - Heuristic scoring -> estimate p_win per TP candidate
 * - EV selection -> choose TP multiplier with max EV
 */

// ----------------- Config -----------------
const DATA_SOURCE = {
    // primary: Binance futures public klines
    klines: (symbol, interval, limit = 500) =>
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
};

const TIMEFRAMES = [
    { label: 'H1', interval: '1h', weight: 1.3 },
    { label: '15M', interval: '15m', weight: 1.1 },
    { label: '5M', interval: '5m', weight: 0.8 }
];

const TP_CANDIDATES = [1.0, 1.5, 2.0, 3.0]; // multiples of ATR
const SL_MULTIPLIER = 1.0; // SL = 1 * ATR (default, can be adjusted by structure)
const MIN_CONFIDENCE = 60; // percent threshold (index.js uses this)

// ----------------- Utilities -----------------
async function loadCandles(symbol, interval, limit = 500) {
    // try Binance futures
    const url = DATA_SOURCE.klines(symbol, interval, limit);
    const resp = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalperBot/1.0)' }
    });
    if (!resp.data || !Array.isArray(resp.data)) throw new Error(`Invalid candle response for ${symbol} ${interval}`);
    // Binance returns [ openTime, open, high, low, close, vol, ... ]
    const mapped = resp.data.map(c => ({
        t: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        vol: parseFloat(c[5])
    }));
    return mapped;
}

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const cur = candles[i];
        const val = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prev.close),
            Math.abs(cur.low - prev.close)
        );
        tr.push(val);
    }
    // Wilder's smoothing
    let atr = tr.slice(0, period).reduce((a,b) => a+b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = ( (atr * (period - 1)) + tr[i] ) / period;
    }
    return atr;
}

function EMA(values, period) {
    if (!values || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function RSI(values, period = 14) {
    if (!values || values.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i-1];
        if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i-1];
        const g = diff > 0 ? diff : 0;
        const l = diff < 0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a,b)=>a+b,0)/arr.length;
}

// ----------------- Structure detectors (simple, heuristic) -----------------
function isBullishStructure(candles) {
    // compare short EMA slope vs long EMA
    const closes = candles.map(c=>c.close);
    const e1 = EMA(closes, 8);
    const e2 = EMA(closes, 34);
    if (e1 === null || e2 === null) return false;
    return e1 > e2;
}
function isBearishStructure(candles) {
    const closes = candles.map(c=>c.close);
    const e1 = EMA(closes, 8);
    const e2 = EMA(closes, 34);
    if (e1 === null || e2 === null) return false;
    return e1 < e2;
}

function detectVolumeSpike(candles) {
    if (!candles || candles.length < 10) return false;
    const vols = candles.slice(-10).map(c=>c.vol);
    const avg = mean(vols.slice(0,9));
    const last = vols[9];
    return (last > avg * 1.8);
}

// find a simple order-block like candle (large body)
function findRecentOrderBlock(candles) {
    if (!candles || candles.length < 6) return null;
    for (let i = candles.length - 6; i < candles.length - 1; i++) {
        const c = candles[i];
        const body = Math.abs(c.close - c.open);
        const range = c.high - c.low;
        if (body > range * 0.6 && c.vol > mean(candles.slice(i-6<0?0:i-6, i).map(x=>x.vol))) {
            return { index: i, high: c.high, low: c.low, bullish: c.close > c.open };
        }
    }
    return null;
}

// fair value gap detection (small)
function findFVGs(candles) {
    const gaps = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i-1], curr = candles[i], next = candles[i+1];
        // bullish FVG
        if (curr.low > prev.high) gaps.push({ type: 'bullish', low: prev.high, high: curr.low, idx: i });
        if (curr.high < prev.low) gaps.push({ type: 'bearish', low: curr.high, high: prev.low, idx: i });
    }
    return gaps;
}

// ----------------- Heuristic probability model (no ML) -----------------
function scoreToProbability(score) {
    // score roughly in [-5, +5] -> map to 0..1 via logistic
    const s = Math.max(-10, Math.min(10, score));
    return 1 / (1 + Math.exp(-s));
}

// build features and compute a score for win-probability for given TF analyses
function estimatePWin({h1, m15, m5}, direction, atr) {
    // accumulate signals
    let score = 0;

    // base bias from H1 (strong filter)
    if (h1) {
        if (direction === 'LONG' && h1.trend === 'bullish') score += 1.2;
        if (direction === 'SHORT' && h1.trend === 'bearish') score += 1.2;
    }

    // M15 quality
    if (m15) {
        if (m15.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 0.9;
        score += (m15.confidence || 50) / 100 - 0.5; // convert to -0.5..+0.5
        if (m15.volumeSpike) score += 0.6;
    }

    // M5 immediate momentum/volume
    if (m5) {
        if (m5.momentumStrong) score += 0.8;
        if (m5.volumeSpike) score += 0.6;
        // candle body size relative to ATR
        const body = Math.abs(m5.last.close - m5.last.open);
        if (body > atr * 0.5) score += 0.5;
    }

    // Penalize if ATR (volatility) is too low or too high (scalping sweetspot)
    if (atr <= 0) return 0.01;
    const atrPct = atr / (m15.price || 1);
    if (atrPct < 0.0002) score -= 0.5; // too quiet
    if (atrPct > 0.02) score -= 0.6; // too noisy

    // final probability
    const p = scoreToProbability(score);
    return p;
}

// ----------------- Level calculators -----------------
function calculateEntryAndStops(direction, currentPrice, m5Analysis, m15Analysis, h1Analysis, atr) {
    // Entry: use small offset near current price or just currentPrice
    let entry = currentPrice;
    // If order-block nearby, move entry slightly into block
    const ob = m15Analysis && m15Analysis.orderBlock;
    if (ob) {
        if (direction === 'LONG') {
            // entry slightly above ob.low
            entry = Math.min(currentPrice, ob.low * 1.001);
        } else {
            entry = Math.max(currentPrice, ob.high * 0.999);
        }
    }

    // Stop Loss: use structure-aware SL if possible
    let sl;
    if (direction === 'LONG') {
        // nearest support from m15 liquidity or ob.low
        const supports = (m15Analysis && m15Analysis.liquidityLevels || []).filter(l=>l.type==='support').map(l=>l.price);
        if (supports.length) sl = Math.max(Math.min(...supports), entry - atr * 1.0);
        else sl = entry - atr * SL_MULTIPLIER;
    } else {
        const res = (m15Analysis && m15Analysis.liquidityLevels || []).filter(l=>l.type==='resistance').map(l=>l.price);
        if (res.length) sl = Math.min(Math.max(...res), entry + atr * 1.0);
        else sl = entry + atr * SL_MULTIPLIER;
    }

    // Ensure SL is not on wrong side of entry
    if (direction === 'LONG' && sl >= entry) sl = entry - atr * SL_MULTIPLIER;
    if (direction === 'SHORT' && sl <= entry) sl = entry + atr * SL_MULTIPLIER;

    // Candidate TPs will be computed externally as multiples of ATR
    return { entry, sl };
}

// ----------------- Main analysis -----------------
async function analyzeSymbol(symbol) {
    try {
        // 1) load candles for H1, M15, M5
        const loaded = {};
        for (const tf of TIMEFRAMES) {
            try {
                const candles = await loadCandles(symbol, tf.interval, 300);
                loaded[tf.label] = candles;
            } catch (e) {
                // if fail for a tf, continue — we need at least M15 and M5
                // console.warn(`Load failed ${symbol} ${tf.label}: ${e.message}`);
            }
        }
        if (!loaded['15M'] || !loaded['5M']) {
            return { symbol, direction: 'NO_TRADE', confidence: 0, reason: 'Insufficient data (need 15m & 5m)' };
        }

        // 2) compute main metrics
        const m5 = loaded['5M'];
        const m15 = loaded['15M'];
        const h1 = loaded['H1'] || null;

        const price = m5[m5.length-1].close;
        const atr_m15 = calculateATR(m15, 14) || calculateATR(m5, 14) || (price * 0.002);
        const atr = atr_m15;

        // M5 analysis
        const m5_closes = m5.map(c=>c.close);
        const m5_rsi = RSI(m5_closes, 14);
        const m5_last = m5[m5.length-1];
        const m5_prev = m5[m5.length-2];
        const m5_momentum = (m5_last.close - m5_prev.close);
        const m5_momentum_pct = Math.abs(m5_momentum) / (price || 1);
        const m5_volumeSpike = detectVolumeSpike(m5);
        const m5_momentumStrong = m5_momentum_pct > 0.0006 || Math.abs(m5_momentum) > atr * 0.15;

        // M15 analysis
        const m15_closes = m15.map(c=>c.close);
        const m15_rsi = RSI(m15_closes, 14);
        const m15_trend = isBullishStructure(m15) ? 'bullish' : isBearishStructure(m15) ? 'bearish' : 'neutral';
        const m15_volumeSpike = detectVolumeSpike(m15);
        const m15_orderBlock = findRecentOrderBlock(m15);
        const m15_fvgs = findFVGs(m15);
        const m15_liquidity = []; // simple placeholder
        // build analysis objects
        const m5Analysis = { price: price, last: m5_last, rsi: m5_rsi, momentum: m5_momentum, momentumStrong: m5_momentumStrong, volumeSpike: m5_volumeSpike };
        const m15Analysis = { price: m15[m15.length-1].close, rsi: m15_rsi, trend: m15_trend, volumeSpike: m15_volumeSpike, orderBlock: m15_orderBlock, fvg: m15_fvgs, liquidityLevels: m15_liquidity, confidence: 60 + (m15_volumeSpike?10:0) + (m15_trend==='bullish'||m15_trend==='bearish'?10:0) };
        const h1Analysis = h1 ? { price: h1[h1.length-1].close, trend: isBullishStructure(h1)?'bullish':isBearishStructure(h1)?'bearish':'neutral' } : null;

        // 3) Determine bias: use H1 + M15
        let biasScore = 0;
        if (h1Analysis) biasScore += (h1Analysis.trend === 'bullish') ? 1.0 : (h1Analysis.trend === 'bearish' ? -1.0 : 0);
        biasScore += (m15Analysis.trend === 'bullish') ? 0.8 : (m15Analysis.trend === 'bearish' ? -0.8 : 0);
        const bias = biasScore > 0.6 ? 'LONG' : biasScore < -0.6 ? 'SHORT' : 'NEUTRAL';
        if (bias === 'NEUTRAL') {
            return { symbol, direction: 'NEUTRAL', confidence: Math.round((Math.abs(biasScore)/1.8)*100), reason: 'No clear multi-TF bias' };
        }

        // 4) For scalping: require M5 momentum in direction
        const m5_dir = m5_last.close > m5_prev.close ? 'LONG' : (m5_last.close < m5_prev.close ? 'SHORT' : 'NEUTRAL');
        if (m5_dir !== bias && !(m5_momentumStrong && m5_volumeSpike)) {
            // sometimes allow momentum strong overrides
            return { symbol, direction: 'NO_TRADE', confidence: Math.round((Math.abs(biasScore)/1.8)*100), reason: 'M5 not confirming bias' };
        }

        // 5) Estimate p_win for each TP candidate using heuristic
        const context = { h1: h1Analysis, m15: m15Analysis, m5: m5Analysis };
        const pCandidates = TP_CANDIDATES.map(_ => estimatePWin(context, bias, atr));
        // If all p are very low, skip
        const maxP = Math.max(...pCandidates);
        if (maxP < 0.52) {
            return { symbol, direction: 'NO_TRADE', confidence: Math.round(maxP*100), reason: 'Low model probability (<52%)' };
        }

        // 6) compute EV for each candidate and pick best
        let best = null;
        for (let i = 0; i < TP_CANDIDATES.length; i++) {
            const m = TP_CANDIDATES[i];
            const SL = SL_MULTIPLIER * atr;
            const TP = m * atr;
            const p = pCandidates[i];
            const EV = p * TP - (1 - p) * SL; // in price units (rough)
            const R = TP / SL;
            if (!best || EV > best.EV) {
                best = { m, SL, TP, p, EV, R };
            }
        }

        if (!best) return { symbol, direction: 'NO_TRADE', confidence: 0, reason: 'No candidate' };

        // 7) Levels (entry/sl/tp) using structure-aware SL
        const { entry, sl } = calculateEntryAndStops(bias, price, m5Analysis, m15Analysis, h1Analysis, atr);
        // recompute TP based on chosen m
        const tp = (bias === 'LONG') ? entry + best.TP : entry - best.TP;
        // ensure proper ordering
        if (bias === 'LONG' && tp <= entry) return { symbol, direction: 'NO_TRADE', confidence: Math.round(best.p*100), reason: 'TP invalid' };
        if (bias === 'SHORT' && tp >= entry) return { symbol, direction: 'NO_TRADE', confidence: Math.round(best.p*100), reason: 'TP invalid' };

        // 8) calculate RR
        const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
        // calculate final confidence: blend best.p and m15 confidence & m5 momentum
        let confidence = Math.round((best.p * 0.7 + (m15Analysis.confidence/100) * 0.2 + (m5_momentumStrong?0.08:0)) * 100);
        confidence = Math.max(20, Math.min(98, confidence));

        // 9) position suggestion (risk % assumed 0.5% default)
        const DEFAULT_ACCOUNT = 1000; // for sizing demonstration only
        const riskPercent = 0.5;
        const riskAmount = DEFAULT_ACCOUNT * (riskPercent/100);
        const riskPerUnit = Math.abs(entry - sl);
        const suggestedSize = riskPerUnit > 0 ? +(riskAmount / riskPerUnit).toFixed(4) : 0;

        // 10) prepare result
        return {
            symbol,
            direction: bias,
            confidence,
            entry: +entry,
            sl: +sl,
            tp: +tp,
            rr: rr.toFixed(2),
            positionSize: suggestedSize,
            meta: {
                atr: +atr,
                pCandidates: pCandidates.map(p=>+p.toFixed(4)),
                chosenTPMultiplier: best.m,
                chosenP: +best.p.toFixed(4),
                EV: +best.EV.toFixed(4),
                m15Trend: m15Analysis.trend,
                m5MomentumStrong: m5_momentumStrong,
                m15VolumeSpike: m15_volumeSpike
            }
        };

    } catch (e) {
        console.error(`Analysis error for ${symbol}:`, e.message);
        return { symbol, direction: 'NO_TRADE', confidence: 0, reason: `Analysis error: ${e.message}` };
    }
}

module.exports = { analyzeSymbol };
