// WhatsApp (Kapso) → Claude Code bridge: a personal assistant that works inside your notes vault.
// Kapso webhook → verify → `claude -p --resume` inside the vault → reply via Kapso.
// No dependencies. Config comes from ~/.config/kapso/kapso.env (see README.md and .env.example).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ---------- config ----------
const ENV_FILE = path.join(os.homedir(), '.config/kapso/kapso.env');
for (const line of fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const cfg = {
  apiKey: process.env.KAPSO_API_KEY,
  webhookSecret: process.env.KAPSO_WEBHOOK_SECRET,
  phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, // the bot's number id in Kapso
  owner: (process.env.OWNER_PHONE || '').replace(/\D/g, ''), // your personal number, digits only
  vault: process.env.VAULT_PATH,
  port: Number(process.env.PORT || 8787),
  dryRun: process.env.DRY_RUN === '1', // print replies instead of sending
  ownerName: process.env.OWNER_NAME || '',
  model: process.env.CLAUDE_MODEL || 'opus[1m]', // pinned so a change in ~/.claude/settings.json doesn't downgrade it
  claudeBin: process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude'),
  timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 30 * 60_000), // podcasts take a while to transcribe
  // full: everything except FORBIDDEN_TOOLS (dedicated server). allowlist: only ALLOWED_TOOLS (laptop).
  permissions: process.env.PERMISSIONS || 'allowlist',
  gitSync: process.env.GIT_SYNC === '1', // pull before each run, push after
  // Extra repos Claude works in (e.g. a company knowledge repo). Reset to origin/main before every message:
  // Claude changes them on a branch + PR within the same run, so nothing local is meant to survive.
  mirrors: (process.env.MIRROR_REPOS || '').split(',').map((x) => x.trim()).filter(Boolean),
};
for (const k of ['apiKey', 'webhookSecret', 'owner', 'vault']) {
  if (!cfg[k]) { console.error(`missing config: ${k}`); process.exit(1); }
}
if (!cfg.dryRun && !cfg.phoneNumberId) { console.error('missing config: phoneNumberId'); process.exit(1); }

const DIR = path.dirname(new URL(import.meta.url).pathname);
const STATE_FILE = path.join(DIR, 'state.json');
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// What Claude may do without anyone approving. Everything else is denied in -p mode.
const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write',
  'WebSearch', 'WebFetch',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(git add:*)', 'Bash(git commit:*)',
  'mcp__claude_ai_Google_Calendar',
];
// Outward-facing or destructive tools that stay off even in full mode.
const FORBIDDEN_TOOLS = [
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread',
  'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_schedule_message',
  'mcp__claude_ai_Slack__slack_create_conversation',
  'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Google_Drive__trash_file',
  'mcp__claude_ai_Supabase__execute_sql',
  'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git reset --hard:*)',
];
const SYSTEM_PROMPT = fs.readFileSync(process.env.SYSTEM_PROMPT_FILE || path.join(DIR, 'system-prompt.md'), 'utf8');

// ---------- kapso ----------
async function sendText(to, body) {
  if (cfg.dryRun) { log('DRY_RUN reply →', to, '\n' + body); return; }
  // WhatsApp caps text at 4096 chars
  for (let i = 0; i < body.length; i += 4000) {
    const res = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(i, i + 4000) } }),
    });
    if (!res.ok) log('send failed', res.status, await res.text());
  }
}

// Outside the 24h customer-service window WhatsApp only allows approved templates.
async function sendTemplate(to, name, params) {
  if (cfg.dryRun) { log('DRY_RUN template →', to, name, params); return; }
  const res = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: TEMPLATE_LANG }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
    }),
  });
  if (!res.ok) log('template send failed', res.status, await res.text());
}

// ---------- claude ----------
// oneShot: a background job (agenda fetch) — no conversation, only the given tools, runs outside the vault.
function runClaude(prompt, oneShot = null, sessionKey = 'sessionId', extraSystem = '', model = cfg.model) {
  return new Promise((resolve) => {
    const args = oneShot
      ? ['-p', prompt, '--output-format', 'json', '--model', oneShot.model,
        // bare: no tools and no MCP servers, which saves the seconds it takes to connect them
        ...(oneShot.bare ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''] : ['--allowedTools', ...oneShot.tools])]
      : ['-p', prompt, '--output-format', 'json', '--model', model,
        '--append-system-prompt', SYSTEM_PROMPT + extraSystem,
        ...(cfg.permissions === 'full'
          ? ['--permission-mode', 'bypassPermissions', '--disallowedTools', ...FORBIDDEN_TOOLS]
          : ['--allowedTools', ...ALLOWED_TOOLS])];
    if (!oneShot) for (const repo of cfg.mirrors) args.push('--add-dir', repo);
    if (!oneShot && state[sessionKey]) args.push('--resume', state[sessionKey]);
    const child = spawn(cfg.claudeBin, args, { cwd: oneShot ? (oneShot.cwd || DIR) : cfg.vault, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), cfg.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        if (!oneShot && r.session_id) { state[sessionKey] = r.session_id; saveState(); }
        resolve(r.is_error ? `⚠️ ${r.result || 'error de Claude'}` : (r.result || '(sin respuesta)'));
      } catch {
        log('claude failed', code, err.slice(0, 2000));
        resolve(code === null ? '⚠️ Me demoré demasiado y corté. Intenta de nuevo o divídelo.' : '⚠️ Falló la ejecución de Claude. Revisa los logs.');
      }
    });
  });
}

// ---------- git ----------
function git(...args) { return gitIn(cfg.vault, ...args); }
function gitIn(cwd, ...args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

// ---------- inbound ----------
// One message at a time, so the conversation stays in order and git never races.
let queue = Promise.resolve();
let busySince = 0; // when the current Claude run started (0 = idle)
// WhatsApp sends a photo album as an "unsupported" header (error 131051) followed by the photos one by one.
// So an unsupported message only gets a reply if nothing else arrives shortly after it.
const isUnsupported = (e) => /Unsupported message/i.test(textOf(e.message || {}));
let unsupportedTimer = null;
let queuedNoticeSent = false; // one "📥 Recibido" per busy stretch, not one per photo
const seen = new Set();

const textOf = (msg) => (msg.kapso?.transcript?.text || msg.kapso?.transcript || msg.text?.body || msg.kapso?.content || '').toString().trim();

// Kapso buffers messages sent in quick succession; they arrive together and become one prompt.
async function handle(events) {
  const mine = events.filter((e) => {
    const from = (e.message?.from || e.conversation?.phone_number || '').replace(/\D/g, '');
    if (from !== cfg.owner) log('ignored message from non-owner', from);
    return from === cfg.owner;
  });
  if (!mine.length) return;
  const from = cfg.owner;

  const text = mine.map((e) => textOf(e.message || {})).filter(Boolean).join('\n');
  if (!text) { await sendText(from, 'Por ahora solo entiendo texto y audios.'); return; }
  log('in:', text.slice(0, 200));
  state.lastInboundAt = Date.now(); saveState();

  // First message of the day = he's awake: send the morning digest first.
  const today = todayStr();
  if (!DIGEST_TIME && REMINDERS_ON && tzParts().hour >= '04' && !(state.morning?.date === today && state.morning.digestSent)) {
    await sendDigest(today);
    if (GREETING_ONLY.test(text)) return; // "buenas" just meant "I'm up": the digest is the answer
  }

  if (/^\/(nuevo|new|reset)$/i.test(text)) {
    delete state.sessionId; saveState();
    await sendText(from, 'Listo, conversación nueva.');
    return;
  }
  // Long jobs (podcasts, videos, files) get a heads-up and then a ping every few minutes,
  // so silence never looks like a crash.
  busySince = Date.now();
  const ack = setTimeout(() => sendText(from, '⏳ En eso…'), 20_000);
  const progress = setInterval(() => {
    const mins = Math.round((Date.now() - busySince) / 60_000);
    sendText(from, `⏳ Sigo en eso (${mins} min)…`);
  }, 4 * 60_000);
  if (cfg.gitSync) {
    const pull = await git('pull', '--rebase', '--autostash');
    if (pull.code !== 0) log('git pull failed', pull.out);
  }
  for (const repo of cfg.mirrors) {
    for (const args of [['fetch', '-q', 'origin'], ['checkout', '-q', '-f', 'main'], ['reset', '-q', '--hard', 'origin/main'], ['submodule', 'update', '-q', '--init', '--remote', '--force']]) {
      const r = await gitIn(repo, ...args);
      if (r.code !== 0) { log('mirror sync failed', repo, args[0], r.out); break; }
    }
  }
  let reply = await runClaude(text);
  clearTimeout(ack); clearInterval(progress); busySince = 0; queuedNoticeSent = false;
  if (cfg.gitSync) {
    const push = await git('push');
    if (push.code !== 0) { log('git push failed', push.out); reply += '\n\n⚠️ No pude hacer push al vault, quedó solo en el servidor.'; }
  }
  log('out:', reply.slice(0, 200));
  await sendText(from, reply);
  if (CALENDAR_HINT.test(text + reply)) refreshAgenda();
}

// ---------- agenda reminders ----------
// Morning digest + a heads-up before each block. Events come from Google Calendar via Claude
// (the claude.ai connector), refreshed hourly and after any message that smells like a calendar change.
const TZ = process.env.TZ_NAME || 'America/Santiago';
const TEMPLATE = process.env.REMINDER_TEMPLATE || 'agenda_aviso'; // approved Meta template, one body param
const TEMPLATE_LANG = process.env.REMINDER_TEMPLATE_LANG || 'es';
const DIGEST_TIME = process.env.DIGEST_TIME || '';  // legacy: fixed-time digest; empty = morning flow below
// Morning flow: a short greeting at GREETING_TIME on GREETING_DAYS (ISO weekdays, 1 = Monday). The digest
// (sleep + agenda) goes out with his first message of the day: if he's writing, he's awake.
// Before then only the day's first block is reminded (it carries the greeting, so no separate one is sent);
// the rest stay quiet. DIGEST_LATEST is the fallback if he never writes.
const GREETING_TIME = process.env.GREETING_TIME || '06:00';
const GREETING_DAYS = (process.env.GREETING_DAYS || '1,2,3,4,5').split(',').map(Number);
const DIGEST_LATEST = process.env.DIGEST_LATEST || '10:00';
const GREETING_ONLY = /^(hola|holi|buenas|buen d[ií]a|buenos d[ií]as|b[uo]+ngiorno+|wena|wenas|arriba|despierto|ya|s[ií]|ok|vamos|vamo arriba)[\s!.👋☀️💪]*$/i;
const REMIND_MIN = Number(process.env.REMIND_MINUTES || 5);
const CALENDAR_HINT = /calend|bloque|evento|agenda|reuni|mueve|movido|cancel|\b\d{1,2}:\d{2}\b/i;
const WINDOW_MS = 23.5 * 3600_000;
// Calendars to read, e.g. personal + work accounts shared into the personal one. Empty = "all my calendars".
const AGENDA_CALENDARS = (process.env.AGENDA_CALENDARS || '').split(',').map((x) => x.trim()).filter(Boolean);

const tzParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((p) => [p.type, p.value]));
const todayStr = () => { const p = tzParts(); return `${p.year}-${p.month}-${p.day}`; };
const hhmm = (iso) => { const p = tzParts(new Date(iso)); return `${p.hour}:${p.minute}`; };
const oneLine = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 900); // template params can't hold newlines

let refreshing = null;
function refreshAgenda() {
  if (refreshing) return refreshing;
  const date = todayStr();
  refreshing = runClaude(
    `Using the Google Calendar tools, list every timed event on ${date} (timezone ${TZ}) ` +
    (AGENDA_CALENDARS.length
      ? `from each of these calendars (query every one with its calendarId): ${AGENDA_CALENDARS.join(', ')}. If the same event appears in more than one, keep it once. `
      : `across all my calendars. `) +
    `Skip all-day events and events I declined. Reply with ONLY a JSON array, no prose, no code fence: ` +
    `[{"id":"...","title":"...","start":"ISO 8601 with offset","end":"ISO 8601 with offset","description":"plain text (strip HTML), keep line breaks, max 1500 chars, \"\" if none",` +
    `"calendar":"calendarId it came from","link":"the event's htmlLink","location":"\"\" if none","meet":"video call URL (hangoutLink or conferenceData entry point), \"\" if none",` +
    `"attendees":["display name, or email if no name; exclude me; max 12; [] if none"]}]`,
    { model: 'opus', tools: ['mcp__claude_ai_Google_Calendar'] },
  ).then((out) => {
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
    try {
      const events = JSON.parse(json).filter((e) => e.start && e.title);
      const prev = state.agenda?.date === date ? state.agenda : { notified: {} };
      state.agenda = { date, events, notified: prev.notified, digestSent: prev.digestSent, fetchedAt: Date.now() };
      briefingCache.at = 0; // the spoken briefing reads the agenda
      stateCache.at = 0;
      saveState();
      log(`agenda: ${events.length} events for ${date}`);
    } catch { log('agenda parse failed:', out.slice(0, 300)); }
  }).finally(() => { refreshing = null; });
  return refreshing;
}

// Free-form inside the 24h window (full detail); the approved template outside it (one line).
async function notify(full, short) {
  if (Date.now() - (state.lastInboundAt || 0) < WINDOW_MS) await sendText(cfg.owner, full);
  else await sendTemplate(cfg.owner, TEMPLATE, [oneLine(short)]);
}

function whoopRun(arg) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, 'whoop.mjs'), arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill(), 12_000); // WHOOP's API can stall; the HUD shows '--' instead of hanging
    child.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? out.trim() : null); });
  });
}

// '' when WHOOP isn't set up; a reconnect hint when its login expired (exit code 3).
function whoopBrief() {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHOOP_TOKENS)) return resolve('');
    const child = spawn(process.execPath, [path.join(DIR, 'whoop.mjs'), 'brief'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 3 && WHOOP_REDIRECT) return resolve(`⚠️ WHOOP se desconectó. Reconéctalo: ${new URL('/whoop/login', WHOOP_REDIRECT)}`);
      resolve(code === 0 ? out.trim() : '');
    });
  });
}

const REMINDERS_ON = process.env.REMINDERS !== '0';

// The morning greeting is written by Claude from the vault (yesterday's journal, goals, today's first block),
// so it reads like a person and not a cron job. Falls back to a fixed line if Claude fails.
// GREETING_READ: what Claude reads in the vault to write it. GREETING_STYLE: tone and language.
const GREETING_READ = process.env.GREETING_READ ||
  'el CLAUDE.md del vault (y lo que apunte), la nota de journal más reciente y la rutina, si existen';
const GREETING_STYLE = process.env.GREETING_STYLE || 'español casual, cálido y con energía';
async function morningGreeting(firstEvent) {
  const fallback = `☀️ *Buenos días${cfg.ownerName ? ` ${cfg.ownerName}` : ''}.* ¿Arriba? Respóndeme y te cuento cómo dormiste y qué tienes hoy.`;
  const weekday = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const text = await runClaude(
    `Escribe el mensaje de buenos días de WhatsApp para ${cfg.ownerName || 'el dueño de este vault'}, hoy ${weekday}. ` +
    `Lee ${GREETING_READ}. ` +
    (firstEvent ? `Su primer bloque de hoy es "${firstEvent.title}" a las ${hhmm(firstEvent.start)}: menciónalo. ` : '') +
    `2 o 3 líneas cortas, ${GREETING_STYLE}, específico: algo real de ayer o de hoy, nada genérico. ` +
    `Sin listas ni títulos; solo *negrita* de WhatsApp si hace falta. Todavía no sabe cómo durmió: no inventes datos de sueño. ` +
    `Termina con una frase corta para que responda; cuando responda, TÚ le vas a mandar cómo durmió y su día (no se lo pidas a él). Devuelve solo el texto del mensaje.`,
    { model: 'opus', tools: ['Read', 'Glob', 'Grep'], cwd: cfg.vault },
  );
  return text && !text.startsWith('⚠️') ? text.trim() : fallback;
}
const isoWeekday = () => ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date())];

let digestInFlight2 = false;
async function sendDigest(date) {
  const m = state.morning?.date === date ? state.morning : (state.morning = { date });
  if (m.digestSent || digestInFlight2) return;
  digestInFlight2 = true;
  try {
    await refreshAgenda();
    const events = (state.agenda?.events || []).filter((e) => new Date(e.start) > Date.now() - 30 * 60_000)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    const lines = events.map((e) => `${hhmm(e.start)} ${e.title}`);
    const body = await whoopBrief(); // '' if WHOOP isn't connected
    await notify(
      (body ? `💪 ${body}\n\n` : '') + (events.length ? `*Lo que viene hoy:*\n${lines.map((l) => `- ${l}`).join('\n')}` : 'Hoy no tienes nada más en el calendario.'),
      (body ? `${body} · ` : '') + (events.length ? `hoy tienes ${lines.join(' · ')}` : 'hoy no tienes nada en el calendario'),
    );
    m.digestSent = true; saveState();
    log('digest sent');
  } finally { digestInFlight2 = false; }
}

async function tick() {
  const p = tzParts();
  const now = `${p.hour}:${p.minute}`;
  const date = todayStr();

  const m = state.morning?.date === date ? state.morning : (state.morning = { date }); // per-day flags

  if (!DIGEST_TIME && !m.greeted && GREETING_DAYS.includes(isoWeekday()) && now >= GREETING_TIME && now < '12:00') {
    m.greeted = true; saveState();
    await notify(await morningGreeting(null), 'buenos días. Respóndeme y te cuento cómo dormiste y qué tienes hoy');
    log('greeting sent');
  }
  const fallback = DIGEST_TIME ? now >= DIGEST_TIME : now >= DIGEST_LATEST;
  if (!m.digestSent && fallback && now < '12:00') await sendDigest(date);
  else if (p.minute === '00' && Number(p.hour) >= 5 && Number(p.hour) <= 22) refreshAgenda();

  if (state.agenda?.date !== date) return;
  for (const e of state.agenda.events) {
    const key = `${e.id}@${e.start}`; // a moved event gets reminded again at its new time
    const mins = (new Date(e.start) - Date.now()) / 60_000;
    if (mins > 0 && mins <= REMIND_MIN && !state.agenda.notified[key]) {
      state.agenda.notified[key] = true; saveState();
      // Before he's awake, only the day's first block pings him (it doubles as the morning greeting).
      const awake = state.morning?.date === date && state.morning.digestSent;
      const first = !awake && !m.greeted && e === state.agenda.events.reduce((a, b) => (new Date(b.start) < new Date(a.start) ? b : a));
      if (!awake && !first) continue;
      if (first) { m.greeted = true; saveState(); }
      const desc = (e.description || '').trim();
      const hello = first ? `\n\n${await morningGreeting(e)}` : '';
      await notify(`⏰ *${hhmm(e.start)} ${e.title}*${desc ? `\n${desc}` : ''}${hello}`, `${hhmm(e.start)} ${e.title}`);
      log('reminder:', e.title);
    }
  }
}

function verify(raw, sig) {
  if (typeof sig !== 'string') return false;
  const a = Buffer.from(crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex'));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- WHOOP (optional) ----------
// OAuth: GET /whoop/login → WHOOP consent → GET /whoop/callback stores tokens for whoop.mjs.
const WHOOP_TOKENS = path.join(os.homedir(), '.config/whoop/tokens.json');
const WHOOP_REDIRECT = process.env.WHOOP_REDIRECT_URI || '';
const WHOOP_SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement';
let whoopState = null;

async function whoopCallback(url, res) {
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== whoopState) { res.writeHead(400).end('Bad state or missing code'); return; }
  whoopState = null;
  const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: WHOOP_REDIRECT,
      client_id: process.env.WHOOP_CLIENT_ID, client_secret: process.env.WHOOP_CLIENT_SECRET,
    }),
  });
  const t = await r.json();
  if (!t.access_token) { log('whoop token exchange failed', JSON.stringify(t).slice(0, 300)); res.writeHead(500).end('WHOOP no entregó token. Revisa los logs.'); return; }
  fs.mkdirSync(path.dirname(WHOOP_TOKENS), { recursive: true });
  fs.writeFileSync(WHOOP_TOKENS, JSON.stringify({ ...t, obtained_at: Date.now() }, null, 2), { mode: 0o600 });
  log('whoop connected');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>WHOOP conectado ✅</h2><p>Ya puedes cerrar esta pestaña.</p>');
}

// ---------- Jarvis (web HUD) ----------
// Static UI in ./jarvis, API under /jarvis/api/*, protected by JARVIS_TOKEN (sent as ?k= once, then a header).
const JARVIS_DIR = path.join(DIR, 'jarvis');
// The HUD talks out loud: Opus is fast enough now, and the conversation starts fresh after a pause.
const JARVIS_MODEL = process.env.JARVIS_MODEL || 'opus';
const JARVIS_FRESH_AFTER_MS = 30 * 60_000;
const JARVIS_VOICE = `

You are now speaking through the J.A.R.V.I.S. web interface, out loud. Answer in 1 to 3 short spoken sentences,
no markdown, no lists, no emojis, no links unless asked. Sound like a calm, witty butler-assistant (Jarvis), in his language.
You still have every tool and can act (calendar, vault, Linear…); say briefly what you did.`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

function jarvisAuthed(req, url) {
  const k = req.headers['x-jarvis-key'] || url.searchParams.get('k');
  const a = Buffer.from(String(k || '')), b = Buffer.from(String(process.env.JARVIS_TOKEN || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? out.trim() : null); });
  });
}

// Everything the HUD shows that is specific to you comes from here, not from the UI code.
let calendarLabels = {};
try { calendarLabels = JSON.parse(process.env.JARVIS_CALENDAR_LABELS || '{}'); } catch { log('JARVIS_CALENDAR_LABELS is not valid JSON'); }
const REVENUE_TITLE = process.env.JARVIS_REVENUE_TITLE || 'REVENUE';
const jarvisUi = () => ({
  wakeLine: process.env.JARVIS_WAKE_LINE || 'Buongiorno, JARVIS. ¿Cómo se viene el día?',
  screens: (() => { try { return JSON.parse(process.env.JARVIS_SCREENS || 'null') || undefined; } catch { return undefined; } })(),
  revenueTitle: REVENUE_TITLE,
  calendarLabels,
});

// JARVIS_DEMO=1: made-up data, for screenshots and for trying the HUD before connecting anything.
function demoState() {
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const ev = (h, m, h2, m2, title, extra = {}) => ({ time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, start: at(h, m), end: at(h2, m2), title, description: '', calendar: 'demo@example.com', link: '', location: '', meet: '', attendees: [], ...extra });
  return {
    now: new Date().toISOString(), owner: cfg.ownerName || 'Tony', tz: TZ, ui: { ...jarvisUi(), revenueTitle: 'MI APP' }, demo: true,
    agenda: [
      ev(6, 30, 7, 30, '☀️ Rutina de la mañana', { description: '☐ Agua y luz\n☐ 30 min de cardio\n☐ Ducha fría' }),
      ev(9, 0, 11, 0, '💻 Deep work: producto'),
      ev(11, 30, 12, 0, '📞 Llamada con el equipo'),
      ev(13, 30, 14, 30, '🍽️ Almuerzo'),
      ev(15, 0, 17, 0, '🎬 Grabar contenido'),
      ev(19, 0, 20, 0, '🏋️ Gym'),
      ev(22, 30, 23, 0, '🌙 Cierre del día'),
    ],
    whoop: { recovery: 78, hrv: 84, rhr: 52, sleepHours: 7.4, sleepPerf: 91 },
    revenue: { revenue28d: 35302, mrr: 9850, activeSubs: 1240, trials: 96, newCustomers28d: 310 },
    companies: [],
  };
}

// The panels' data, kept warm for a minute: the HUD polls it, and spoken answers read it without waiting.
let stateCache = { at: 0, value: null, pending: null };
function jarvisState() {
  if (stateCache.pending) return stateCache.pending;
  if (Date.now() - stateCache.at < 60_000 && stateCache.value) return Promise.resolve(stateCache.value);
  stateCache.pending = jarvisStateFresh()
    .then((v) => { stateCache = { at: Date.now(), value: v, pending: null }; return v; })
    .catch((e) => { stateCache.pending = null; throw e; });
  return stateCache.pending;
}
async function jarvisStateFresh() {
  if (process.env.JARVIS_DEMO === '1') return demoState();
  revenueDays().catch(() => {}); // warm it for spoken answers (Supabase takes a few seconds)
  const date = todayStr();
  const out = { now: new Date().toISOString(), owner: cfg.ownerName, tz: TZ, ui: jarvisUi() };
  const events = (state.agenda?.date === date ? state.agenda.events : [])
    .slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  out.agenda = events.map((e) => ({
    time: hhmm(e.start), start: e.start, end: e.end, title: e.title,
    description: e.description || '', calendar: e.calendar || '', link: e.link || '', location: e.location || '',
    meet: e.meet || '', attendees: Array.isArray(e.attendees) ? e.attendees.slice(0, 12) : [],
  }));
  if (fs.existsSync(WHOOP_TOKENS)) {
    const [rec, slp] = await Promise.all([runChild([path.join(DIR, 'whoop.mjs'), 'recovery', '1']), runChild([path.join(DIR, 'whoop.mjs'), 'sleep', '3'])]);
    try {
      const r = JSON.parse(rec.split('\n')[0]);
      const s = slp.split('\n').map((l) => JSON.parse(l)).find((x) => !x.nap);
      out.whoop = { recovery: r.recovery, hrv: r.hrv_ms, rhr: r.rhr, sleepHours: s?.hours_asleep, sleepPerf: s?.performance };
    } catch { out.whoop = null; }
  }
  if (process.env.REVENUECAT_API_KEY && process.env.REVENUECAT_PROJECT_ID) {
    try {
      const r = await fetch(`https://api.revenuecat.com/v2/projects/${process.env.REVENUECAT_PROJECT_ID}/metrics/overview`, { signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${process.env.REVENUECAT_API_KEY}` } });
      const m = Object.fromEntries(((await r.json()).metrics || []).map((x) => [x.id, x.value]));
      out.revenue = { revenue28d: m.revenue, mrr: m.mrr, activeSubs: m.active_subscriptions, trials: m.active_trials, newCustomers28d: m.new_customers };
    } catch { out.revenue = null; }
  }
  // ARR per company: live from RevenueCat (MRR × 12) when configured, hand-entered otherwise:
  // JARVIS_COMPANIES='[{"name":"…","arr":350000}]'.
  const k = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n / 1000)}K`);
  let manual = [];
  try { manual = JSON.parse(process.env.JARVIS_COMPANIES || '[]'); } catch {}
  out.companies = [
    ...(out.revenue?.mrr != null ? [{ name: REVENUE_TITLE, label: 'ARR · RevenueCat', value: k(out.revenue.mrr * 12) }] : []),
    ...manual.map((c) => ({ name: c.name, label: c.label || 'ARR', value: c.value ?? k(c.arr) })),
  ];
  return out;
}

function serveJarvisStatic(url, res) {
  let rel = decodeURIComponent(url.pathname.replace(/^\/jarvis\/?/, '')) || 'index.html';
  const file = path.normalize(path.join(JARVIS_DIR, rel));
  if (!file.startsWith(JARVIS_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Optional: your app's day so far, if you store RevenueCat webhooks in a Supabase table `rc_events`
// (RC_EVENTS_SUPABASE_REF + SUPABASE_ACCESS_TOKEN; read-only SQL, aggregates only).
const daysCache = { at: 0, value: null };
async function revenueDays() {
  if (Date.now() - daysCache.at < 120_000 && daysCache.value) return daysCache.value;
  const v = await revenueDaysFresh();
  if (v) Object.assign(daysCache, { at: Date.now(), value: v });
  return v;
}
async function revenueDaysFresh() {
  if (!process.env.SUPABASE_ACCESS_TOKEN || !process.env.RC_EVENTS_SUPABASE_REF) return null;
  const sql = `with d as (select type, period_type, is_trial_conversion, price,
      (to_timestamp(event_timestamp_ms / 1000.0) at time zone '${TZ}')::date as dia
    from rc_events where environment = 'PRODUCTION' and event_timestamp_ms > extract(epoch from now() - interval '9 days') * 1000)
    select dia::text,
      count(*) filter (where (type = 'INITIAL_PURCHASE' and period_type <> 'TRIAL') or (type = 'RENEWAL' and is_trial_conversion)) as nuevos,
      count(*) filter (where type = 'INITIAL_PURCHASE' and period_type = 'TRIAL') as trials,
      round(coalesce(sum(price) filter (where type in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE')), 0)) as revenue
    from d group by 1 order by 1 desc`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.RC_EVENTS_SUPABASE_REF}/database/query/read-only`, { signal: AbortSignal.timeout(8000),
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) return null;
  const rows = (await r.json()).map((x) => ({ dia: x.dia, suscriptoresNuevos: Number(x.nuevos), trialsNuevos: Number(x.trials), revenueUsd: Number(x.revenue) }));
  const today = todayStr();
  const past = rows.filter((x) => x.dia < today).slice(0, 7);
  const avg = (k) => Math.round(past.reduce((t, x) => t + x[k], 0) / Math.max(1, past.length));
  return {
    hoyHastaAhora: rows.find((x) => x.dia === today) || { suscriptoresNuevos: 0, trialsNuevos: 0, revenueUsd: 0 },
    ayer: past[0] || null,
    promedioDiarioUltimos7: { suscriptoresNuevos: avg('suscriptoresNuevos'), revenueUsd: avg('revenueUsd') },
  };
}

// The briefing JARVIS says when you wake him ("¿cómo se viene el día?"): written by Claude from the HUD's own data,
// no tools, so it takes ~20-30 s. The HUD asks for it when the page opens, so it's ready when you say the wake line.
const CALL_ME = process.env.JARVIS_CALL_ME || cfg.ownerName || '';
const BRIEFING_STYLE = process.env.JARVIS_BRIEFING_STYLE ||
  'español con tuteo (nada de voseo), sin garabatos, con MUCHA energía: hype, rápido, como un relator que anuncia buenas noticias, ' +
  'pero con el estilo de JARVIS (lo trata de "señor", un toque de ironía). Frases cortas y con punch, exclamaciones donde corresponda';
// Only your app's numbers are said out loud by default; other companies' ARR stays private unless this is set.
const BRIEFING_COMPANY_NUMBERS = process.env.JARVIS_BRIEFING_COMPANY_NUMBERS === '1';
const briefingCache = { at: 0, text: '', pending: null, key: '' };
// "As if it were HH:MM today" (the HUD's ?hora=09:45, to record a morning at night): shifts "now".
function briefingNow(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at || '');
  if (!m) return Date.now();
  const p = tzParts();
  return Date.now() - ((Number(p.hour) * 60 + Number(p.minute)) - (Number(m[1]) * 60 + Number(m[2]))) * 60_000;
}
// The opening, in Italian with attitude, by time of day. JARVIS_GREETINGS="morning|afternoon|evening" changes it.
const GREETINGS = (process.env.JARVIS_GREETINGS || '¡Buongiorno|¡Buon pomeriggio|¡Buonasera').split('|');
function hello(now) {
  const h = Number(tzParts(new Date(now)).hour);
  return GREETINGS[h < 13 ? 0 : h < 19 ? 1 : 2] || GREETINGS[0];
}
function briefingFallback(s) {
  const parts = [`¡Buongiorno${CALL_ME ? `, ${CALL_ME}` : ''}!`];
  const w = s.whoop;
  if (w?.sleepHours != null) parts.push(`Dormiste ${String(w.sleepHours).replace('.', ',')} horas${w.recovery != null ? ` y tu recuperación está en ${Math.round(w.recovery)} por ciento` : ''}.`);
  if (s.revenue?.mrr != null) parts.push(`${s.ui?.revenueTitle || 'Tu app'} va en ${Math.round(s.revenue.mrr).toLocaleString('es-CL')} dólares de MRR.`);
  const left = s.agenda.filter((e) => new Date(e.end || e.start) > Date.now());
  if (left.length) parts.push(`Lo próximo: ${left[0].title.replace(/[^\p{L}\p{N}\s:,.()-]/gu, '').trim()}, a las ${left[0].time}.`);
  return parts.join(' ');
}
async function jarvisBriefing(at = '') {
  if (briefingCache.pending && briefingCache.key === at) return briefingCache.pending;
  if (briefingCache.key === at && Date.now() - briefingCache.at < 5 * 60_000 && briefingCache.text) return briefingCache.text;
  briefingCache.key = at;
  briefingCache.pending = (async () => {
    const s = await jarvisState();
    const now = briefingNow(at);
    const app = s.ui?.revenueTitle && s.ui.revenueTitle !== 'REVENUE' ? s.ui.revenueTitle : 'tu app';
    const data = {
      ahora: new Date(now).toLocaleString('es-CL', { timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      whoop: s.whoop,
      app: s.revenue && { nombre: app, mrrUsd: s.revenue.mrr, revenueUltimos28diasUsd: s.revenue.revenue28d, suscriptoresActivos: s.revenue.activeSubs, trialsActivos: s.revenue.trials, ...(s.demo ? {} : await revenueDays().catch(() => null)) },
      otrasEmpresas: BRIEFING_COMPANY_NUMBERS ? s.companies?.filter((c) => c.name !== REVENUE_TITLE) : undefined,
      agenda: s.agenda.map((e) => ({ hora: e.time, fin: e.end ? hhmm(e.end) : '', titulo: e.title, yaPaso: new Date(e.end || e.start) < now })),
    };
    const out = await runClaude(
      `Eres J.A.R.V.I.S., el asistente de ${CALL_ME || 'tu dueño'}. Te acaba de saludar con un "${s.ui?.wakeLine || '¿Cómo se viene el día?'}". ` +
      `Contéstale en voz alta. Estilo: ${BRIEFING_STYLE}. ` +
      `Empieza exactamente con "${hello(now)}, ${CALL_ME || 'señor'}!" y después, en este orden, saltándote lo que no venga en los datos: ` +
      `1) WHOOP, en una frase y SIEMPRE con las dos cifras: las horas que durmió y el porcentaje de recuperación ("dormiste seis horas y media y tu recuperación está en ochenta y dos por ciento"); si la recuperación es baja, igual con buena onda pero que baje la intensidad. ` +
      `1b) Justo después, si en la agenda hay un bloque de gym o entrenamiento de la mañana que ya pasó (yaPaso), felicítalo con ganas por haber entrenado tan temprano, diciendo la hora de inicio de ese bloque ("¡y ya metiste gym a las seis de la mañana! Eso es disciplina, señor"). ` +
      `2) la app (${app}), celebrándolo si va bien ("¡${app} la está rompiendo!"): los suscriptores nuevos de hoy si vienen (hoyHastaAhora; si son menos de 5, los de ayer), comparados con su promedio diario si le gana, y el total de suscriptores activos o el MRR. Cifras redondeadas como se dicen ("veintiocho suscriptores nuevos"). Si los números no son buenos, no inventes hype: dilo con calma. ` +
      `3) cómo vienen los proyectos hoy` +
      (BRIEFING_COMPANY_NUMBERS ? ' (con las cifras de otrasEmpresas)' : ' según los bloques de la agenda, sin cifras de otras empresas') +
      ` y lo que queda de la agenda (solo lo que no ha pasado; agrupa, no leas todo). 4) Cierra con una frase corta con energía. ` +
      `No nombres clientes, empresas externas ni personas (puede ir a un video): di "una reunión", no con quién. ` +
      `Máximo 6 oraciones cortas y 65 palabras en total. Solo texto para decir en voz alta: sin markdown, sin emojis, sin listas, horas como "a las cuatro". ` +
      `Datos (JSON): ${JSON.stringify(data)}`,
      { model: 'opus', tools: ['Read'], cwd: DIR },
    );
    const text = out.startsWith('⚠️') || out.length < 20 ? briefingFallback(s) : out.trim();
    Object.assign(briefingCache, { at: Date.now(), text });
    return text;
  })().finally(() => { briefingCache.pending = null; });
  return briefingCache.pending;
}

// A natural voice for the HUD (the keys never reach the browser). ElevenLabs if configured (best, paid), else
// Microsoft's neural voices through edge-tts (free), else 501 and the HUD falls back to the browser's voice.
const ELEVEN = {
  key: process.env.ELEVENLABS_API_KEY || '',
  voice: process.env.ELEVENLABS_VOICE_ID || '',
  model: process.env.ELEVENLABS_MODEL || 'eleven_v4', // the most expressive: the prepared briefing
  fastModel: process.env.ELEVENLABS_FAST_MODEL || 'eleven_v4_turbo', // live replies: same voice, much lower latency
};
const EDGE = {
  voice: process.env.EDGE_TTS_VOICE || '',
  rate: process.env.EDGE_TTS_RATE || '+10%',
  pitch: process.env.EDGE_TTS_PITCH || '+0Hz',
  bin: process.env.EDGE_TTS_BIN || path.join(os.homedir(), '.local/bin/edge-tts'),
};
const ttsReady = () => (ELEVEN.key && ELEVEN.voice) || EDGE.voice;
function edgeTts(text) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `jarvis-tts-${crypto.randomUUID()}.mp3`);
    const child = spawn(EDGE.bin, ['--voice', EDGE.voice, `--rate=${EDGE.rate}`, `--pitch=${EDGE.pitch}`, '--text', text, '--write-media', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(t);
      try { if (code !== 0) throw new Error(`edge-tts ${code} ${err.slice(0, 200)}`); resolve(fs.readFileSync(file)); }
      catch (e) { reject(e); } finally { fs.rmSync(file, { force: true }); }
    });
  });
}
async function elevenTts(text, fast = false) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN.voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: fast ? ELEVEN.fastModel : ELEVEN.model, voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.5, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status} ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
const ttsCache = new Map(); // text → mp3, last 30: retakes of the same briefing don't spend credits
async function tts(text, fast = false) {
  if (ttsCache.has(text)) return ttsCache.get(text);
  const buf = ELEVEN.key && ELEVEN.voice ? await elevenTts(text, fast) : await edgeTts(text);
  ttsCache.set(text, buf);
  if (ttsCache.size > 30) ttsCache.delete(ttsCache.keys().next().value);
  return buf;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { resolve({}); } });
  });
}

// Asking him to do something (move, create, write, search…) needs the full agent; anything else is a question.
const JARVIS_ACTION = /\b(mueve|mov[eé]|muével|cambia|crea|agend|agrega|añad|pon(e|me|lo|la)?|borra|elimina|cancela|anota|escrib|manda|env[ií]a|programa|recu[eé]rd|busca|investiga|revisa|abre|ab[ií]r|linear|notion|tareas?|pendientes?|correos?|mails?|slack|drive|planilla|sheets?|docs?|commit|guarda|actualiza|responde|contesta|estudia|resume)\b/i;
const quickHistory = []; // the last few HUD exchanges, so follow-ups make sense
function jarvisRemember(q, a) { quickHistory.push({ q, a }); while (quickHistory.length > 6) quickHistory.shift(); }
async function jarvisQuick(text, hora) {
  const s = await jarvisState();
  const now = briefingNow(hora);
  const app = s.ui?.revenueTitle && s.ui.revenueTitle !== 'REVENUE' ? s.ui.revenueTitle : 'tu app';
  const data = {
    ahora: new Date(now).toLocaleString('es-CL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }),
    whoop: s.whoop,
    app: s.revenue && { nombre: app, mrrUsd: s.revenue.mrr, revenueUltimos28diasUsd: s.revenue.revenue28d, suscriptoresActivos: s.revenue.activeSubs, trialsActivos: s.revenue.trials, ...(s.demo ? {} : await revenueDays().catch(() => null)) },
    agenda: s.agenda.map((e) => ({ hora: e.time, fin: e.end ? hhmm(e.end) : '', titulo: e.title, yaPaso: new Date(e.end || e.start) < now, detalle: (e.description || '').slice(0, 300) })),
  };
  const history = quickHistory.map((x) => `Él: ${x.q}\nTú: ${x.a}`).join('\n');
  const out = await runClaude(
    `Eres J.A.R.V.I.S., el asistente de ${CALL_ME || 'tu dueño'}, hablando en voz alta por el HUD. ` +
    `Responde en 1 a 3 frases cortas, en español con tuteo, con el estilo de JARVIS (lo tratas de "señor", calmado, preciso, con un toque de ironía). ` +
    `Sin markdown, sin emojis, sin listas: es para decirlo en voz alta. Usa solo estos datos; si la pregunta necesita algo que no está aquí, dilo en una frase y ofrece hacerlo ("¿quieres que lo revise?"). ` +
    `No nombres clientes ni personas externas (puede ir a un video): los títulos de la agenda a veces traen el cliente después de "/"; di solo "una reunión". La hora actual es la de "ahora".\n\n` +
    `Datos (JSON): ${JSON.stringify(data)}\n\n` + (history ? `Conversación reciente:\n${history}\n\n` : '') + `Él: ${text}`,
    { model: JARVIS_MODEL, bare: true, cwd: DIR },
  );
  const reply = out.startsWith('⚠️') ? 'Se me cruzaron los cables, señor. ¿Me lo repites?' : out.trim();
  jarvisRemember(text, reply);
  return reply;
}

function handleJarvis(req, res, url) {
  if (!url.pathname.startsWith('/jarvis/api/')) return serveJarvisStatic(url, res);
  if (!jarvisAuthed(req, url)) { res.writeHead(401).end('unauthorized'); return; }
  if (req.method === 'GET' && url.pathname === '/jarvis/api/state') {
    jarvisState().then((s) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(s)))
      .catch((e) => { log('jarvis state error', e); res.writeHead(500).end('{}'); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/jarvis/api/briefing') {
    jarvisBriefing(url.searchParams.get('hora') || '').then((text) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text })))
      .catch((e) => { log('jarvis briefing error', e); res.writeHead(500).end('{}'); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/jarvis/api/tts') {
    if (!ttsReady()) { res.writeHead(501).end('no tts'); return; }
    readJson(req).then(async ({ text, fast }) => {
      text = String(text || '').slice(0, 1500).trim();
      if (!text) { res.writeHead(400).end(); return; }
      const mp3 = await tts(text, !!fast);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length, 'Cache-Control': 'no-store' }).end(mp3);
    }).catch((e) => { log('tts error', e.message); res.writeHead(502).end('tts failed'); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/jarvis/api/ask') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let text = '', hora = '';
      try { const b = JSON.parse(Buffer.concat(chunks)); text = String(b.text || '').slice(0, 4000).trim(); hora = String(b.hora || ''); } catch {}
      if (!text) { res.writeHead(400).end('{}'); return; }
      log('jarvis in:', text.slice(0, 200));
      // Questions take the fast path (~5 s): Claude with the HUD's data and no tools. Requests to do something go
      // to the full agent below, which can act but takes 15-30 s.
      if (!JARVIS_ACTION.test(text)) {
        jarvisQuick(text, hora).then((reply) => {
          log('jarvis quick out:', reply.slice(0, 200));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ reply }));
        }).catch((e) => { log('jarvis quick error', e); res.writeHead(500).end('{}'); });
        return;
      }
      // The HUD's video mode (?hora=09:45): answer as if it were that time today.
      const fake = /^\d{1,2}:\d{2}$/.test(hora);
      const timeNote = fake ? `\nFor this conversation, act as if it were ${hora} today (he is recording a video). Never mention the real time.` : '';
      const prompt = fake ? `[Modo video: para esta respuesta son las ${hora} de hoy. Esa es la hora actual: no uses la hora real ni corras \`date\`; lo que está antes de las ${hora} ya pasó y lo de después viene.]\n\n${text}` : text;
      // Same queue as WhatsApp: one Claude run at a time, so git and the vault never race.
      queue = queue.then(async () => {
        if (cfg.gitSync) await git('pull', '--rebase', '--autostash');
        if (Date.now() - (state.jarvisLastAt || 0) > JARVIS_FRESH_AFTER_MS) delete state.jarvisSessionId;
        state.jarvisLastAt = Date.now();
        let reply = await runClaude(prompt, null, 'jarvisSessionId', JARVIS_VOICE + timeNote, JARVIS_MODEL);
        jarvisRemember(text, reply);
        if (cfg.gitSync) await git('push');
        log('jarvis out:', reply.slice(0, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ reply }));
        if (CALENDAR_HINT.test(text + reply)) refreshAgenda(); // the HUD polls /state for the new agenda
      }).catch((e) => { log('jarvis error', e); res.writeHead(500).end('{}'); });
    });
    return;
  }
  res.writeHead(404).end();
}

const PRIVACY_HTML = `<!doctype html><meta charset="utf-8"><title>Privacy</title>
<h1>Privacy policy — personal assistant</h1>
<p>This is a private, single-user assistant. It is not offered to the public.</p>
<p>Data read from connected services (for example WHOOP recovery, sleep and workout data) is used only to answer
the owner's own questions and to build their daily summary. It is not sold, shared with third parties, or used for advertising.</p>
<p>Access tokens are stored on the owner's private server and can be revoked at any time from the provider's settings.</p>`;

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/jarvis' || req.url.startsWith('/jarvis/') || req.url.startsWith('/jarvis?')) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/jarvis') { res.writeHead(302, { Location: '/jarvis/' + url.search }).end(); return; }
    return handleJarvis(req, res, url);
  }
  if (req.method === 'GET' && req.url === '/privacy') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PRIVACY_HTML); return; }
  if (req.method === 'GET' && req.url.startsWith('/whoop/')) {
    const url = new URL(req.url, 'http://x');
    if (!process.env.WHOOP_CLIENT_ID) { res.writeHead(503).end('WHOOP not configured'); return; }
    if (url.pathname === '/whoop/login') {
      whoopState = crypto.randomBytes(12).toString('hex');
      const auth = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
      auth.search = new URLSearchParams({ response_type: 'code', client_id: process.env.WHOOP_CLIENT_ID, redirect_uri: WHOOP_REDIRECT, scope: WHOOP_SCOPES, state: whoopState });
      res.writeHead(302, { Location: auth.toString() }).end(); return;
    }
    if (url.pathname === '/whoop/callback') { whoopCallback(url, res).catch((e) => { log('whoop error', e); res.writeHead(500).end('error'); }); return; }
    res.writeHead(404).end(); return;
  }
  if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404).end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verify(raw, req.headers['x-webhook-signature'])) { res.writeHead(401).end('bad signature'); return; }
    res.writeHead(200).end('ok'); // ack fast; Kapso retries after 10s

    const key = req.headers['x-idempotency-key'];
    if (key) { if (seen.has(key)) return; seen.add(key); if (seen.size > 1000) seen.clear(); }
    if (req.headers['x-webhook-event'] !== 'whatsapp.message.received') return;

    let body;
    try { body = JSON.parse(raw); } catch { return; }
    const events = body.batch ? body.data : [body];
    const fromOwner = (e) => (e.message?.from || e.conversation?.phone_number || '').replace(/\D/g, '') === cfg.owner;
    if (events.length && events.every(isUnsupported)) {
      if (events.some(fromOwner)) {
        clearTimeout(unsupportedTimer);
        unsupportedTimer = setTimeout(() => sendText(cfg.owner, 'Me llegó un mensaje que no puedo leer (¿un "ver una vez" o un formato raro?). Mándalo de nuevo como foto, archivo o texto.'), 30_000);
      }
      log('unsupported message, waiting to see if an album follows');
      return;
    }
    clearTimeout(unsupportedTimer);
    const kept = events.filter((e) => !isUnsupported(e));
    // A message that arrives while another one is running waits in line: say so right away.
    if (busySince && !queuedNoticeSent && kept.some((e) => (e.message?.from || '').replace(/\D/g, '') === cfg.owner)) {
      queuedNoticeSent = true;
      sendText(cfg.owner, '📥 Recibido. Termino lo anterior y sigo con esto.');
    }
    queue = queue.then(() => handle(kept)).catch((e) => log('handler error', e));
  });
}).listen(cfg.port, '127.0.0.1', () => {
  if (REMINDERS_ON) { setInterval(() => tick().catch((e) => log('tick error', e)), 60_000); refreshAgenda(); }
  log(`listening on 127.0.0.1:${cfg.port}${cfg.dryRun ? ' (DRY_RUN)' : ''}, vault: ${cfg.vault}`);
});
