// ============================================================
//  Minecraft AFK Hosting Bot — Single File Version
//  Telegram se control karo apna Minecraft AFK bot
//
//  Setup:
//  1. npm install mineflayer telegraf express dotenv
//  2. BOT_TOKEN=your_token node bot.js
// ============================================================

require('dotenv').config();

const mineflayer = require('mineflayer');
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT      = process.env.PORT || 3000;
const DB_FILE   = path.join(__dirname, 'data.json');
const MAX_CMDS_PER_MIN = 10;

if (!BOT_TOKEN) {
  console.log('❌ BOT_TOKEN not set! Add it to .env file or environment.');
  process.exit(1);
}

// ── Colors for logs ───────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const log = {
  info:    (m) => console.log(`${C.cyan}[INFO]${C.reset} ${m}`),
  ok:      (m) => console.log(`${C.green}[OK]${C.reset}   ${m}`),
  warn:    (m) => console.log(`${C.yellow}[WARN]${C.reset} ${m}`),
  err:     (m) => console.log(`${C.red}[ERR]${C.reset}  ${m}`),
  bot:     (m) => console.log(`${C.magenta}[BOT]${C.reset}  ${m}`),
};

// ── Database (JSON file) ──────────────────────────────────────
function dbLoad() {
  try {
    if (!fs.existsSync(DB_FILE)) return { users: {}, configs: {} };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return { users: {}, configs: {} }; }
}
function dbSave(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function getUser(uid)       { return dbLoad().users[uid] || {}; }
function setUser(uid, data) { const d = dbLoad(); d.users[uid] = { ...d.users[uid], ...data }; dbSave(d); }
function getConfig(uid)     { return dbLoad().configs[uid] || null; }
function setConfig(uid, c)  { const d = dbLoad(); d.configs[uid] = c; dbSave(d); }
function delConfig(uid)     { const d = dbLoad(); delete d.configs[uid]; dbSave(d); }
function clearState(uid)    { setUser(uid, { state: null, pending: {} }); }

// ── Rate limiter ──────────────────────────────────────────────
const rateMap = new Map();
function rateOk(uid) {
  const now = Date.now();
  const r = rateMap.get(uid);
  if (!r || now > r.resetAt) { rateMap.set(uid, { count: 1, resetAt: now + 60000 }); return true; }
  if (r.count >= MAX_CMDS_PER_MIN) return false;
  r.count++; return true;
}
function rateCooldown(uid) {
  const r = rateMap.get(uid);
  return r ? Math.max(0, Math.ceil((r.resetAt - Date.now()) / 1000)) : 0;
}

// ── Validators ────────────────────────────────────────────────
function validIP(ip) {
  if (!ip || ip.length > 253) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip))
    return ip.split('.').every(p => +p <= 255);
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(ip);
}
function validPort(p) { const n = parseInt(p); return !isNaN(n) && n >= 1 && n <= 65535; }
function validUser(u) { return /^[a-zA-Z0-9_]{3,16}$/.test(u?.trim() || ''); }

// ── Active bots store ─────────────────────────────────────────
// uid -> { bot, config, online, startTime, afkTimer, reconnectTimer, destroyed }
const activeBots = new Map();

function rInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function rFlt(a, b) { return Math.random() * (b - a) + a; }

function uptimeStr(start) {
  const s = Math.floor((Date.now() - start) / 1000);
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
}

// ── Create Mineflayer bot ─────────────────────────────────────
function createBot(uid, config, onEvent) {
  if (activeBots.has(uid)) destroyBot(uid);

  log.bot(`Creating bot: ${config.username}@${config.host}:${config.port}`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host:     config.host,
      port:     parseInt(config.port),
      username: config.username,
      version:  false,   // auto-detect server version
      auth:     'offline',
      hideErrors: false,
    });
  } catch (e) {
    log.err(`Bot create failed: ${e.message}`);
    onEvent('error', { message: e.message });
    return;
  }

  const state = {
    bot, config, online: false,
    startTime: Date.now(),
    afkTimer: null, reconnectTimer: null, destroyed: false,
  };
  activeBots.set(uid, state);

  // ── Events ──────────────────────────────────────────────────
  bot.on('spawn', () => {
    state.online = true;
    state.startTime = Date.now();
    log.ok(`Bot spawned: ${config.username}`);
    onEvent('spawn', {});

    // Optional login command
    if (config.loginCmd?.trim()) {
      setTimeout(() => { try { bot.chat(config.loginCmd.trim()); } catch {} }, rInt(1000, 2000));
    }

    startAfk(uid);

    // 6-hour scheduled reconnect (keeps session fresh)
    setTimeout(() => {
      if (!state.destroyed) bot.end('6h restart');
    }, 6 * 60 * 60 * 1000);
  });

  bot.on('death', () => {
    log.warn(`Bot died — respawning`);
    setTimeout(() => { try { bot.respawn(); } catch {} }, 1000);
  });

  bot.on('kicked', (reason) => {
    state.online = false;
    let r = reason;
    try { r = JSON.parse(reason)?.text || reason; } catch {}
    log.warn(`Kicked: ${r}`);
    onEvent('kicked', { reason: r });
  });

  bot.on('error', (e) => log.err(`Bot error: ${e.message}`));

  bot.on('end', () => {
    state.online = false;
    stopAfk(uid);
    if (!state.destroyed) {
      const delay = rInt(15000, 25000);
      log.warn(`Disconnected — reconnecting in ${delay/1000}s`);
      onEvent('reconnecting', { delay: Math.round(delay / 1000) });
      state.reconnectTimer = setTimeout(() => {
        if (!state.destroyed) { activeBots.delete(uid); createBot(uid, config, onEvent); }
      }, delay);
    }
  });
}

function startAfk(uid) {
  stopAfk(uid);
  const state = activeBots.get(uid);
  if (!state) return;

  function loop() {
    if (state.destroyed || !state.online) return;
    const bot = state.bot;
    const actions = ['forward','back','left','right','jump','sneak','look'];
    const action  = actions[rInt(0, actions.length - 1)];
    const dur     = rInt(300, 1200);

    try {
      if (['forward','back','left','right'].includes(action)) {
        bot.setControlState(action, true);
        setTimeout(() => { try { bot.setControlState(action, false); } catch {} }, dur);
      } else if (action === 'jump') {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, dur);
      } else if (action === 'sneak') {
        bot.setControlState('sneak', true);
        setTimeout(() => { try { bot.setControlState('sneak', false); } catch {} }, dur);
      } else if (action === 'look') {
        bot.look(bot.entity.yaw + rFlt(-0.8, 0.8), bot.entity.pitch + rFlt(-0.4, 0.4), false);
      }
    } catch {}

    state.afkTimer = setTimeout(loop, rInt(3000, 8000));
  }

  state.afkTimer = setTimeout(loop, rInt(5000, 10000));
}

function stopAfk(uid) {
  const state = activeBots.get(uid);
  if (state?.afkTimer) { clearTimeout(state.afkTimer); state.afkTimer = null; }
}

function destroyBot(uid) {
  const state = activeBots.get(uid);
  if (!state) return;
  state.destroyed = true;
  stopAfk(uid);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  try { state.bot.end('User stopped'); } catch {}
  activeBots.delete(uid);
  log.bot(`Bot destroyed for user ${uid}`);
}

function restartBot(uid, onEvent) {
  const state = activeBots.get(uid);
  if (!state) return false;
  const config = state.config;
  destroyBot(uid);
  setTimeout(() => createBot(uid, config, onEvent), 2000);
  return true;
}

function botStatus(uid) {
  const s = activeBots.get(uid);
  if (!s) return null;
  let players = 0, ping = null;
  try { players = Object.keys(s.bot.players || {}).length; } catch {}
  try { ping = s.bot.player?.ping ?? null; } catch {}
  return { online: s.online, host: s.config.host, port: s.config.port, username: s.config.username, uptime: uptimeStr(s.startTime), players, ping };
}

// ── Telegraf Bot ──────────────────────────────────────────────
const tg = new Telegraf(BOT_TOKEN);

// Keyboards
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🤖 Create Bot', 'create'), Markup.button.callback('📋 My Bots', 'mybots')],
  [Markup.button.callback('⛔ Stop Bot',   'stop'),   Markup.button.callback('🔄 Restart', 'restart')],
  [Markup.button.callback('📊 Status',     'status'), Markup.button.callback('❓ Help',    'help')],
]);
const backBtn    = Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'menu')]]);
const cancelBtn  = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel')]]);
const confirmBtn = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Yes Stop', 'confirmstop'), Markup.button.callback('❌ Cancel', 'cancel')],
]);

// Helper send
async function send(ctx, text, extra = {}) {
  try { await ctx.reply(text, { parse_mode: 'Markdown', ...extra }); } catch {}
}
async function edit(ctx, text, extra = {}) {
  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { await send(ctx, text, extra); }
}

// Notification sender (for bot events → Telegram)
function mkNotify(telegram, chatId) {
  return async function(event, data) {
    const cfg = getConfig(chatId); // chatId used as uid here
    async function s(t) {
      try { await telegram.sendMessage(chatId, t, { parse_mode: 'Markdown' }); } catch {}
    }
    if (event === 'spawn')        s(`✅ *Bot is online!*\n\n🌐 \`${cfg?.host}:${cfg?.port}\`\n👤 \`${cfg?.username}\`\n\nUse /status to check.`);
    if (event === 'kicked')       s(`⚠️ *Bot was kicked*\n\nReason: \`${data.reason || 'Unknown'}\`\n\nReconnecting soon...`);
    if (event === 'reconnecting') s(`🔄 *Disconnected* — reconnecting in *${data.delay}s*...`);
    if (event === 'error')        s(`❌ *Bot Error*\n\`${data.message}\``);
  };
}

// Rate limit middleware
tg.use(async (ctx, next) => {
  const uid = ctx.from?.id?.toString();
  if (!uid) return next();
  if (!rateOk(uid)) {
    try { await ctx.reply(`⏳ Too fast! Wait *${rateCooldown(uid)}s*`, { parse_mode: 'Markdown' }); } catch {}
    return;
  }
  return next();
});

// /start
tg.start(async ctx => {
  const uid  = ctx.from.id.toString();
  const name = ctx.from.first_name || 'Player';
  clearState(uid);
  await send(ctx, `🎮 *Welcome, ${name}!*\n\nHost your Minecraft AFK bot *24/7* from Telegram.\n\n✅ Auto reconnect\n✅ Anti-AFK movement\n✅ Live status\n\nChoose an option 👇`, mainMenu);
});

// /help
tg.help(async ctx => {
  await send(ctx, `📖 *Commands*\n\n/start — Main menu\n/status — Bot status\n/stop — Stop bot\n/restart — Restart bot\n/chat <msg> — Send chat\n/players — Player list\n/server — Server info\n/bots — Your bots`, backBtn);
});

// /status
tg.command('status', async ctx => {
  const uid = ctx.from.id.toString();
  const s   = botStatus(uid);
  if (!s) { const c = getConfig(uid); return send(ctx, c ? `🔴 *Offline/Connecting*\n\n🌐 \`${c.host}:${c.port}\`\n👤 \`${c.username}\`` : '❌ No bot found. Use /start', backBtn); }
  await send(ctx, `📊 *Status*\n\n🟢 Online\n🌐 \`${s.host}:${s.port}\`\n👤 \`${s.username}\`\n📡 Ping: ${s.ping ?? 'N/A'}ms\n👥 Players: ${s.players}\n⏱ Uptime: ${s.uptime}`, backBtn);
});

// /stop
tg.command('stop', async ctx => {
  const uid = ctx.from.id.toString();
  if (!activeBots.has(uid)) return send(ctx, '❌ No active bot.', mainMenu);
  await send(ctx, '⛔ Stop your bot?', confirmBtn);
});

// /restart
tg.command('restart', async ctx => {
  const uid = ctx.from.id.toString();
  if (!activeBots.has(uid)) return send(ctx, '❌ No active bot.', mainMenu);
  const notify = mkNotify(ctx.telegram, parseInt(uid));
  restartBot(uid, notify);
  await send(ctx, '🔄 *Restarting bot...*\n\nIt will reconnect shortly.', backBtn);
});

// /chat
tg.command('chat', async ctx => {
  const uid = ctx.from.id.toString();
  const msg = ctx.message.text.replace(/^\/chat\s*/i, '').trim();
  if (!msg) return send(ctx, '💬 Usage: `/chat Hello!`');
  const s = activeBots.get(uid);
  if (!s || !s.online) return send(ctx, '❌ Bot is not online.');
  try { s.bot.chat(msg); await send(ctx, `✅ Sent: \`${msg}\``); } catch { await send(ctx, '❌ Failed to send.'); }
});

// /players
tg.command('players', async ctx => {
  const uid = ctx.from.id.toString();
  const s   = activeBots.get(uid);
  if (!s) return send(ctx, '❌ No active bot.', mainMenu);
  const list = Object.keys(s.bot.players || {});
  if (!list.length) return send(ctx, '👥 No players visible right now.');
  await send(ctx, `👥 *Players (${list.length})*\n\n${list.map((p,i) => `${i+1}. \`${p}\``).join('\n')}`);
});

// /server
tg.command('server', async ctx => {
  const uid = ctx.from.id.toString();
  const c   = getConfig(uid);
  if (!c) return send(ctx, '❌ No bot configured.', mainMenu);
  const s = botStatus(uid);
  await send(ctx, `🖥 *Server*\n\n🌐 \`${c.host}:${c.port}\`\n👤 \`${c.username}\`\n🟢 ${s?.online ? 'Online' : 'Offline'}`, backBtn);
});

// /bots
tg.command('bots', async ctx => {
  const uid = ctx.from.id.toString();
  const c   = getConfig(uid);
  if (!c) return send(ctx, '🤖 *Your Bots*\n\nNone yet.', mainMenu);
  const s = botStatus(uid);
  await send(ctx, `🤖 *Your Bots*\n\n1. \`${c.username}\` @ \`${c.host}:${c.port}\`\n   ${s?.online ? '🟢 Online' : '🔴 Offline'}`, backBtn);
});

// ── Button actions ────────────────────────────────────────────

tg.action('create', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  if (activeBots.has(uid)) {
    const c = getConfig(uid);
    return edit(ctx, `⚠️ *Already have a bot!*\n\n🌐 \`${c?.host}:${c?.port}\`\n👤 \`${c?.username}\`\n\nStop it first with /stop`, backBtn);
  }
  setUser(uid, { state: 'await_ip', pending: {} });
  await edit(ctx, `🌐 *Step 1/3 — Server IP*\n\nEnter your Minecraft server IP:\n\nExamples:\n• \`hypixel.net\`\n• \`play.server.com\`\n• \`192.168.1.1\``, cancelBtn);
});

tg.action('mybots', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  const c   = getConfig(uid);
  if (!c) return edit(ctx, '🤖 *Your Bots*\n\nNone yet.', mainMenu);
  const s = botStatus(uid);
  await edit(ctx, `🤖 *Your Bots*\n\n1. \`${c.username}\` @ \`${c.host}:${c.port}\`\n   ${s?.online ? '🟢 Online' : '🔴 Offline'}`, backBtn);
});

tg.action('stop', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  if (!activeBots.has(uid)) return edit(ctx, '❌ No active bot.', mainMenu);
  await edit(ctx, '⛔ Stop your bot?', confirmBtn);
});

tg.action('confirmstop', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  destroyBot(uid); delConfig(uid);
  await edit(ctx, '⛔ *Bot stopped.*\n\nUse /start to create a new one.', mainMenu);
});

tg.action('restart', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  if (!activeBots.has(uid)) return edit(ctx, '❌ No active bot.', mainMenu);
  const notify = mkNotify(ctx.telegram, ctx.chat.id);
  restartBot(uid, notify);
  await edit(ctx, '🔄 *Restarting...*\n\nBot will reconnect shortly.', backBtn);
});

tg.action('status', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  const s   = botStatus(uid);
  if (!s) { const c = getConfig(uid); return edit(ctx, c ? `🔴 *Offline*\n\n🌐 \`${c.host}:${c.port}\`\n👤 \`${c.username}\`` : '❌ No bot found.', mainMenu); }
  await edit(ctx, `📊 *Status*\n\n🟢 Online\n🌐 \`${s.host}:${s.port}\`\n👤 \`${s.username}\`\n📡 Ping: ${s.ping ?? 'N/A'}ms\n👥 Players: ${s.players}\n⏱ Uptime: ${s.uptime}`, backBtn);
});

tg.action('help', async ctx => {
  await ctx.answerCbQuery();
  await edit(ctx, `📖 *Commands*\n\n/start — Main menu\n/status — Bot status\n/stop — Stop bot\n/restart — Restart bot\n/chat <msg> — Send chat message\n/players — Player list\n/server — Server info\n/bots — Your bots`, backBtn);
});

tg.action('menu', async ctx => {
  await ctx.answerCbQuery();
  const name = ctx.from.first_name || 'Player';
  await edit(ctx, `🎮 *Welcome, ${name}!*\n\nHost your Minecraft AFK bot *24/7* from Telegram.\n\nChoose an option 👇`, mainMenu);
});

tg.action('cancel', async ctx => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id.toString());
  await edit(ctx, '❌ *Cancelled.*\n\nUse /start anytime.', mainMenu);
});

// ── Text message handler (setup flow) ─────────────────────────
tg.on('text', async ctx => {
  const uid   = ctx.from.id.toString();
  const text  = ctx.message.text.trim();
  const user  = getUser(uid);
  const state = user.state;

  if (!state) return; // not in setup

  if (state === 'await_ip') {
    if (!validIP(text)) return send(ctx, `❌ *Invalid IP.*\n\nEnter a valid server address.\n_Example:_ \`hypixel.net\``, cancelBtn);
    setUser(uid, { state: 'await_port', pending: { host: text.toLowerCase() } });
    return send(ctx, `🔌 *Step 2/3 — Port*\n\nEnter the server port.\n_Default is_ \`25565\``, cancelBtn);
  }

  if (state === 'await_port') {
    const p = text || '25565';
    if (!validPort(p)) return send(ctx, `❌ *Invalid port.*\n\nMust be 1–65535. Default: \`25565\``, cancelBtn);
    setUser(uid, { state: 'await_username', pending: { ...(user.pending || {}), port: parseInt(p) } });
    return send(ctx, `👤 *Step 3/3 — Username*\n\nEnter the bot username:\n• 3–16 characters\n• Letters, numbers, underscores\n_Example:_ \`AFK_Player\``, cancelBtn);
  }

  if (state === 'await_username') {
    if (!validUser(text)) return send(ctx, `❌ *Invalid username.*\n\n3–16 chars, letters/numbers/_ only.\n_Example:_ \`AFK_Bot\``, cancelBtn);

    const cfg = {
      host:     (user.pending?.host) || 'localhost',
      port:     (user.pending?.port) || 25565,
      username: text,
    };

    clearState(uid);
    setConfig(uid, cfg);

    await send(ctx, `⏳ *Creating bot...*\n\n🌐 \`${cfg.host}:${cfg.port}\`\n👤 \`${cfg.username}\`\n\nConnecting to server...`);

    const notify = mkNotify(ctx.telegram, ctx.chat.id);
    createBot(uid, cfg, notify);
    return;
  }
});

// ── Express keep-alive server ─────────────────────────────────
const app = express();
app.get('/',       (_, res) => res.json({ status: 'running', bots: activeBots.size, uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => log.info(`Express running on port ${PORT}`));

// ── Launch ────────────────────────────────────────────────────
log.info('========================================');
log.info('  Minecraft AFK Hosting Bot — Starting');
log.info('========================================');

tg.launch()
  .then(() => { log.ok('Telegram bot is live! Send /start to begin.'); })
  .catch(e  => { log.err(`Failed to start: ${e.message}`); process.exit(1); });

process.once('SIGINT',  () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
process.on('unhandledRejection', e => log.err(`Unhandled: ${e}`));
process.on('uncaughtException',  e => log.err(`Exception: ${e.message}`));
