require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { analyzeSymbol } = require('./analysis');

// ---------- CẤU HÌNH ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');
const LAST_SIGNALS_FILE = process.env.LAST_SIGNALS_FILE || path.join(__dirname, 'last_signals.json');
const SIGNAL_HISTORY_FILE = process.env.SIGNAL_HISTORY_FILE || path.join(__dirname, 'signals_history.json');

// --- BOT POLLING (SAFE) ---
const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});
bot.on("polling_error", (err) => {
    console.error(`[Polling Error] ${err.code || ''}: ${err.message}`);
});

// ---------- SERVER EXPRESS (KEEP-ALIVE) ----------
const app = express();
app.use(express.json());
app.get('/', async (req, res) => {
    const users = await loadUsers();
    const lastSignals = await loadLastSignals();
    const history = await loadSignalHistory();
    res.json({
        status: 'AI Scalping Signal Bot is Running...',
        subscribers: Object.keys(users).length,
        lastSignalsSaved: Object.keys(lastSignals).length,
        historyCount: history.length
    });
});
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));

// ---------- TARGET COINS (50 coins) ----------
const TARGET_COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT',
  'LTCUSDT','BCHUSDT','ATOMUSDT','ETCUSDT','XLMUSDT','FILUSDT','ALGOUSDT','NEARUSDT','UNIUSDT','DOGEUSDT',
  'ZECUSDT','PEPEUSDT','ZENUSDT','HYPEUSDT','WIFUSDT','MEMEUSDT','BOMEUSDT','POPCATUSDT','MYROUSDT','HYPERUSDT',
  'TOSHIUSDT','MOGUSDT','TURBOUSDT','PEOPLEUSDT','ARCUSDT','DASHUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT',
  'SEIUSDT','TIAUSDT','INJUSDT','RNDRUSDT','FETUSDT','AGIXUSDT','OCEANUSDT','JASMYUSDT','GALAUSDT','SANDUSDT'
];

// ---------- STATE & SETTINGS ----------
let signalCountToday = 0;
let isAutoAnalysisRunning = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// interval: 7.5 minutes (8 scans per hour)
const ANALYSIS_INTERVAL = 7.5 * 60 * 1000; // ms
const START_DELAY_MS = 8 * 1000; // run after 8s

// duplicate suppression: do not resend same symbol within 1 hour
const DUPLICATE_WINDOW_SECONDS = 60 * 60; // 3600s = 1 hour

// cleanup: after N cycles (8 cycles = ~1 hour) remove old history > 1 hour
let cycleCounter = 0;
const CYCLES_BEFORE_CLEANUP = 8;
const HISTORY_TTL_SECONDS = 60 * 60; // 1 hour

// ---------- Utilities: persistent storage ----------
async function ensureFile(filePath, defaultData) {
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
    }
}

async function loadUsers() {
    await ensureFile(USERS_FILE, {});
    try {
        const raw = await fs.readFile(USERS_FILE, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (e) {
        console.error('Failed load users:', e.message);
        return {};
    }
}

async function saveUsers(obj) {
    try {
        await fs.writeFile(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed save users:', e.message);
    }
}

async function loadLastSignals() {
    await ensureFile(LAST_SIGNALS_FILE, {});
    try {
        const raw = await fs.readFile(LAST_SIGNALS_FILE, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (e) {
        console.error('Failed load last_signals:', e.message);
        return {};
    }
}

async function saveLastSignals(obj) {
    try {
        await fs.writeFile(LAST_SIGNALS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed save last_signals:', e.message);
    }
}

async function loadSignalHistory() {
    await ensureFile(SIGNAL_HISTORY_FILE, []);
    try {
        const raw = await fs.readFile(SIGNAL_HISTORY_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Failed load signals history:', e.message);
        return [];
    }
}

async function saveSignalHistory(arr) {
    try {
        await fs.writeFile(SIGNAL_HISTORY_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed save signals history:', e.message);
    }
}

// ---------- Helper: vietnam time ----------
function getVietnamTime() {
    return moment().tz("Asia/Ho_Chi_Minh");
}

// ---------- Message formatting ----------
function fmtNum(num) {
    if (num === undefined || num === null || isNaN(Number(num))) return 'N/A';
    const v = Number(num);
    if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return v.toFixed(8).replace(/\.?0+$/, '');
}

function formatSignalMessage(data, signalIndex) {
    const icon = data.direction === 'LONG' ? '🟢' : '🔴';
    const conf = data.confidence !== undefined ? `${data.confidence}%` : (data.meta && data.meta.confidence ? `${data.meta.confidence}%` : 'N/A');

    const msg = `🤖 Tín hiệu [${signalIndex} trong ngày]
#${data.symbol.replace('USDT','')} – [${data.direction}] 📌

${icon} Entry: ${fmtNum(data.entry)}
🆗 Take Profit: ${fmtNum(data.tp)}
🙅‍♂️ Stop-Loss: ${fmtNum(data.sl)}
🪙 Tỉ lệ RR: ${data.rr || '-'} (Conf: ${conf})

ℹ️ p_win (tp candidates): ${data.meta && data.meta.pCandidates ? data.meta.pCandidates.map(p=> (p*100).toFixed(1)+'%').join(' , ') : 'N/A'}

🧠 By AI Scalping Bot

⚠️ Chỉ tham khảo — Quản lý rủi ro: 0.25% - 1% per trade, bot không auto-trade.`;

    return msg;
}

// ---------- Broadcast with retries & prune blocked users ----------
async function broadcastToAllUsers(message) {
    const users = await loadUsers();
    let success = 0, fail = 0;
    const userIds = Object.keys(users);
    for (const id of userIds) {
        let retries = 0, sent = false;
        while (retries < 3 && !sent) {
            try {
                await bot.sendMessage(Number(id), message);
                sent = true;
                success++;
                // tiny delay between messages
                await new Promise(r => setTimeout(r, 80));
            } catch (e) {
                retries++;
                console.warn(`Failed to send to ${id} (attempt ${retries}): ${e.message}`);
                // if forbidden (bot blocked), remove user
                if (e.response && (e.response.statusCode === 403 || e.response.statusCode === 410)) {
                    delete users[id];
                    await saveUsers(users);
                    console.log(`Removed blocked user ${id}`);
                    sent = true; // stop retrying
                    fail++;
                    break;
                }
                if (retries < 3) await new Promise(r => setTimeout(r, 1000 * retries));
                else fail++;
            }
        }
    }
    return { success, fail };
}

// ---------- Duplicate suppression ----------
async function shouldSendSignal(symbol) {
    const lastSignals = await loadLastSignals();
    const key = symbol.toUpperCase();
    if (!lastSignals[key]) return true;
    const lastTs = lastSignals[key]; // epoch seconds
    const now = Math.floor(Date.now() / 1000);
    if ((now - lastTs) < DUPLICATE_WINDOW_SECONDS) return false;
    return true;
}

async function markSignalSent(symbol) {
    const lastSignals = await loadLastSignals();
    lastSignals[symbol.toUpperCase()] = Math.floor(Date.now() / 1000);
    await saveLastSignals(lastSignals);
}

// ---------- History append ----------
async function appendSignalHistory(obj) {
    const hist = await loadSignalHistory();
    hist.unshift(obj); // newest first
    await saveSignalHistory(hist.slice(0, 1000)); // cap history to last 1000
}

// ---------- Cleanup old history (every ~1 hour) ----------
async function cleanupOldHistory() {
    try {
        const hist = await loadSignalHistory();
        const cutoff = Math.floor(Date.now() / 1000) - HISTORY_TTL_SECONDS;
        const filtered = hist.filter(h => {
            const t = h.createdAtEpoch || Math.floor(new Date(h.createdAt || h.time || Date.now()).getTime()/1000);
            return t >= cutoff;
        });
        await saveSignalHistory(filtered);
        const lastSignals = await loadLastSignals();
        for (const k of Object.keys(lastSignals)) {
            if (lastSignals[k] < cutoff) delete lastSignals[k];
        }
        await saveLastSignals(lastSignals);
        console.log('🧹 Cleanup completed: trimmed history and last_signals older than 1 hour');
    } catch (e) {
        console.warn('Cleanup error:', e.message);
    }
}

// ---------- Auto analysis main loop ----------
async function runAutoAnalysis() {
    if (isAutoAnalysisRunning) {
        console.log('⏳ Auto analysis already running, skip this cycle.');
        return;
    }
    isAutoAnalysisRunning = true;

    try {
        const now = getVietnamTime();
        const hour = now.hours();
        const minute = now.minutes();

        // Operating hours: here keep 24/7 for scalping; if you want limited hours, adjust.
        // Example: skip maintenance window midnight-00:10
        // if (hour === 0 && minute < 10) { isAutoAnalysisRunning = false; return; }

        const users = await loadUsers();
        if (Object.keys(users).length === 0) {
            console.log('👥 No subscribers, skipping analysis.');
            isAutoAnalysisRunning = false;
            return;
        }

        console.log(`🔄 Starting Auto Analysis at ${now.format('HH:mm')} for ${Object.keys(users).length} users`);
        let signalsFound = 0;

        for (let i = 0; i < TARGET_COINS.length; i++) {
            const coin = TARGET_COINS[i];
            try {
                console.log(`🔍 Analyzing ${coin} (${i+1}/${TARGET_COINS.length})`);
                const result = await analyzeSymbol(coin); // returns object with direction/confidence/entry.. etc

                if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
                    // require confidence ≥ 60
                    const conf = result.confidence || (result.meta && result.meta.confidence) || 0;
                    if (conf >= 60) {
                        // duplicate suppression per symbol within 1 hour
                        const okToSend = await shouldSendSignal(result.symbol);
                        if (!okToSend) {
                            console.log(`⏭️ Skip ${result.symbol}: recently signaled within ${DUPLICATE_WINDOW_SECONDS/60} minutes`);
                        } else {
                            signalCountToday++;
                            signalsFound++;
                            const msg = formatSignalMessage(result, signalCountToday);
                            await broadcastToAllUsers(msg);
                            await markSignalSent(result.symbol);
                            await appendSignalHistory({
                                ...result,
                                createdAt: new Date().toISOString(),
                                createdAtEpoch: Math.floor(Date.now()/1000)
                            });
                            console.log(`✅ Sent signal for ${result.symbol} (${result.direction}) conf=${conf}%`);
                            // small delay after sending
                            await new Promise(r => setTimeout(r, 1200));
                        }
                    } else {
                        console.log(`⏭️ ${coin}: confidence ${conf}% < 60%`);
                    }
                } else {
                    console.log(`➖ No signal for ${coin}: ${result?.direction || 'NO_TRADE'}`);
                }
            } catch (coinErr) {
                console.error(`❌ Error analyzing ${coin}: ${coinErr.message}`);
                // handle rate-limit-like issues: bump consecutiveErrors
                if (String(coinErr.message).includes('429') || String(coinErr.message).includes('418')) {
                    consecutiveErrors++;
                    console.log(`🚨 Consecutive errors: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        console.log('🔌 Circuit breaker triggered — sleeping 10 minutes before next cycles');
                        setTimeout(() => { consecutiveErrors = 0; console.log('🔋 Circuit breaker reset'); }, 10 * 60 * 1000);
                        break;
                    }
                } else {
                    consecutiveErrors = 0;
                }
            }

            // politeness delay between coins (1s) — keep modest to avoid rate-limits
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`🎯 Auto analysis finished — signalsFound=${signalsFound}`);

        // housekeeping: cycle counter & cleanup
        cycleCounter++;
        if (cycleCounter >= CYCLES_BEFORE_CLEANUP) {
            await cleanupOldHistory();
            cycleCounter = 0;
        }

    } catch (err) {
        console.error('💥 Critical error in runAutoAnalysis:', err.message);
    } finally {
        isAutoAnalysisRunning = false;
    }
}

// ---------- Scheduling ----------
setInterval(runAutoAnalysis, ANALYSIS_INTERVAL);
setTimeout(() => { runAutoAnalysis(); }, START_DELAY_MS);

// ---------- Bot commands ----------

// /start - đăng ký nhận tin
bot.onText(/\/start/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const user = msg.from;
        const users = await loadUsers();
        users[chatId] = {
            id: user.id,
            username: user.username || null,
            first_name: user.first_name || null,
            addedAt: new Date().toISOString()
        };
        await saveUsers(users);

        const welcome = `👋 Chào ${user.first_name || 'Trader'}!\n\n` +
            `Bạn đã được đăng ký nhận tín hiệu tự động từ AI Scalping Bot.\n` +
            `Bot quét ${TARGET_COINS.length} cặp, TF chính M5/M15, RR động theo EV.\n\n` +
            `Gõ /analyzeall để chạy phân tích thủ công, /stop để hủy nhận.\n\n` +
            `⚠️ Bot chỉ gửi tín hiệu tham khảo — luôn tuân thủ quản lý rủi ro.`;

        await bot.sendMessage(chatId, welcome);
        console.log(`✅ Subscribed user ${chatId} (${user.username || user.first_name})`);
    } catch (e) {
        console.error('/start handler error:', e.message);
    }
});

// /stop - hủy đăng ký
bot.onText(/\/stop/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const users = await loadUsers();
        if (users[chatId]) {
            delete users[chatId];
            await saveUsers(users);
            await bot.sendMessage(chatId, '🗑️ Bạn đã hủy đăng ký nhận tín hiệu. Gõ /start để đăng ký lại.');
            console.log(`User unsubscribed ${chatId}`);
        } else {
            await bot.sendMessage(chatId, 'Bạn chưa đăng ký nhận tín hiệu. Gõ /start để đăng ký.');
        }
    } catch (e) {
        console.error('/stop handler error:', e.message);
    }
});

// /analyzesymbol SYMBOL - phân tích thủ công 1 coin
bot.onText(/\/analyzesymbol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbolRaw = match[1].toUpperCase().trim();
    let symbol = symbolRaw.endsWith('USDT') ? symbolRaw : `${symbolRaw}USDT`;
    try {
        const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${symbol}...`);
        const result = await analyzeSymbol(symbol);
        if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
            const content = formatSignalMessage(result, 'MANUAL');
            await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
            await bot.sendMessage(chatId, content);
        } else {
            await bot.editMessageText(`❌ Không tìm thấy tín hiệu cho ${symbol}\nReason: ${result?.reason || 'No trade'}`, { chat_id: chatId, message_id: processing.message_id });
        }
    } catch (e) {
        console.error('/analyzesymbol error:', e.message);
        try { await bot.sendMessage(chatId, `❌ Lỗi phân tích ${symbol}: ${e.message}`); } catch {}
    }
});

// /analyzeall - phân tích toàn bộ TARGET_COINS (accessible to any user)
bot.onText(/\/analyzeall/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${TARGET_COINS.length} coins... Vui lòng chờ (có thể lâu vài phút).`);
        let results = [];
        for (let i = 0; i < TARGET_COINS.length; i++) {
            const coin = TARGET_COINS[i];
            try {
                const res = await analyzeSymbol(coin);
                if (res && res.direction && res.direction !== 'NO_TRADE' && res.confidence >= 60) {
                    results.push(res);
                }
            } catch (e) {
                console.warn(`Analyze ${coin} failed: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 800));
        }
        await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
        if (results.length === 0) {
            await bot.sendMessage(chatId, '❌ Không tìm thấy tín hiệu (confidence ≥ 60%) trên toàn bộ danh sách.');
        } else {
            results = results.sort((a,b)=> (b.confidence||0)-(a.confidence||0)).slice(0, 40);
            let text = `🔍 KẾT QUẢ PHÂN TÍCH TOÀN BỘ (${results.length} tín hiệu)\n\n`;
            for (const r of results) {
                text += `#${r.symbol.replace('USDT','')} - ${r.direction} - Conf: ${r.confidence}%\nEntry: ${fmtNum(r.entry)} | SL: ${fmtNum(r.sl)} | TP: ${fmtNum(r.tp)} | RR:${r.rr}\n\n`;
            }
            // ensure message length safe
            const chunks = [];
            while (text.length > 0) {
                chunks.push(text.slice(0, 3800));
                text = text.slice(3800);
            }
            for (const c of chunks) await bot.sendMessage(chatId, c);
        }
    } catch (e) {
        console.error('/analyzeall error:', e.message);
        try { await bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`); } catch {}
    }
});

// /users - list subscribers (for owner only if you want, currently open)
bot.onText(/\/users/, async (msg) => {
    try {
        const users = await loadUsers();
        const total = Object.keys(users).length;
        let text = `📊 Subscribers: ${total}\n\n`;
        for (const id of Object.keys(users).slice(0, 100)) {
            const u = users[id];
            text += `- ${id} ${u.username ? `(@${u.username})` : ''} added: ${u.addedAt}\n`;
        }
        await bot.sendMessage(msg.chat.id, text);
    } catch (e) {
        console.error('/users error:', e.message);
    }
});

console.log('🤖 Bot running. Auto analysis every 7.5 minutes (8 cycles/hour).');
