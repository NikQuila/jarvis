#!/usr/bin/env node
// WHOOP CLI for the assistant. Tokens come from the OAuth flow in server.mjs (/whoop/login).
// Usage: node whoop.mjs brief | woke | recovery [n] | sleep [n] | workouts [n] | cycles [n] | profile | export
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_FILE = path.join(os.homedir(), '.config/kapso/kapso.env');
for (const line of fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const TOKENS = path.join(os.homedir(), '.config/whoop/tokens.json');
const API = 'https://api.prod.whoop.com/developer';

// WHOOP rotates the refresh token on every use, so two processes refreshing at once would burn it.
// A mkdir lock serializes refreshes; the token file is written atomically.
const LOCK = TOKENS + '.lock';
async function withLock(fn) {
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(LOCK); break; } catch {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > 60_000) fs.rmSync(LOCK, { recursive: true, force: true }); // stale
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  try { return await fn(); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

async function token() {
  if (!fs.existsSync(TOKENS)) { console.error('WHOOP_AUTH: not connected'); process.exit(3); }
  let t = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));
  if (Date.now() > t.obtained_at + (t.expires_in - 120) * 1000) return withLock(async () => {
    t = JSON.parse(fs.readFileSync(TOKENS, 'utf8')); // another process may have refreshed while we waited
    if (Date.now() <= t.obtained_at + (t.expires_in - 120) * 1000) return t.access_token;
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: 'offline',
        client_id: process.env.WHOOP_CLIENT_ID, client_secret: process.env.WHOOP_CLIENT_SECRET,
      }),
    });
    const n = await r.json();
    if (!n.access_token) { console.error('WHOOP_AUTH: refresh failed ' + JSON.stringify(n).slice(0, 200)); process.exit(3); }
    t = { ...t, ...n, obtained_at: Date.now() };
    fs.writeFileSync(TOKENS + '.tmp', JSON.stringify(t, null, 2), { mode: 0o600 });
    fs.renameSync(TOKENS + '.tmp', TOKENS);
    return t.access_token;
  });
  return t.access_token;
}

async function get(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + (await token()) } });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const hrs = (ms) => Math.round((ms / 3600000) * 10) / 10;
const sleepHours = (s) => {
  const st = s.score?.stage_summary; if (!st) return null;
  return hrs(st.total_light_sleep_time_milli + st.total_slow_wave_sleep_time_milli + st.total_rem_sleep_time_milli);
};

const [cmd = 'brief', nArg] = process.argv.slice(2);
const n = Math.min(Number(nArg) || 7, 25);

if (cmd === 'brief') {
  // One line for the morning digest.
  const [rec, slp] = await Promise.all([get('/v2/recovery?limit=1'), get('/v2/activity/sleep?limit=3')]);
  const r = rec.records?.[0]?.score;
  const s = slp.records?.find((x) => !x.nap);
  const pct = r?.recovery_score;
  const dot = pct == null ? '' : pct >= 67 ? '🟢' : pct >= 34 ? '🟡' : '🔴';
  const parts = [];
  if (pct != null) parts.push(`Recovery ${Math.round(pct)}% ${dot}`);
  if (r?.hrv_rmssd_milli) parts.push(`HRV ${Math.round(r.hrv_rmssd_milli)} ms`);
  if (r?.resting_heart_rate) parts.push(`FC reposo ${r.resting_heart_rate}`);
  if (s) parts.push(`Sueño ${sleepHours(s)} h (${Math.round(s.score?.sleep_performance_percentage ?? 0)}%)`);
  console.log(parts.join(' · ') || 'Sin datos de WHOOP para hoy');
} else if (cmd === 'export') {
  // Full history (paginated) → ~/whoop-data/<type>.jsonl, for long-term analysis. Private: stays on this server.
  const dir = path.join(os.homedir(), 'whoop-data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const types = { recovery: '/v2/recovery', sleep: '/v2/activity/sleep', workout: '/v2/activity/workout', cycle: '/v2/cycle' };
  for (const [name, ep] of Object.entries(types)) {
    let next = null, count = 0, oldest = null;
    const out = fs.createWriteStream(path.join(dir, `${name}.jsonl`), { mode: 0o600 });
    do {
      const d = await get(`${ep}?limit=25${next ? `&nextToken=${encodeURIComponent(next)}` : ''}`);
      for (const r of d.records) { out.write(JSON.stringify(r) + '\n'); count++; oldest = r.start || r.created_at || oldest; }
      next = d.next_token;
    } while (next);
    out.end();
    console.log(JSON.stringify({ type: name, records: count, oldest }));
  }
} else if (cmd === 'woke') {
  // End of the last main (non-nap) sleep, so the server can send the digest when he actually wakes up.
  const d = await get('/v2/activity/sleep?limit=3');
  const s = d.records?.find((x) => !x.nap);
  console.log(JSON.stringify({ end: s?.end ?? null }));
} else if (cmd === 'recovery') {
  const d = await get(`/v2/recovery?limit=${n}`);
  for (const x of d.records) console.log(JSON.stringify({ date: x.created_at?.slice(0, 10), recovery: x.score?.recovery_score, hrv_ms: x.score?.hrv_rmssd_milli && Math.round(x.score.hrv_rmssd_milli), rhr: x.score?.resting_heart_rate, spo2: x.score?.spo2_percentage, skin_temp_c: x.score?.skin_temp_celsius }));
} else if (cmd === 'sleep') {
  const d = await get(`/v2/activity/sleep?limit=${n}`);
  for (const x of d.records) console.log(JSON.stringify({ start: x.start, end: x.end, nap: x.nap, hours_asleep: sleepHours(x), performance: x.score?.sleep_performance_percentage, efficiency: x.score?.sleep_efficiency_percentage, consistency: x.score?.sleep_consistency_percentage, respiratory_rate: x.score?.respiratory_rate }));
} else if (cmd === 'workouts') {
  const d = await get(`/v2/activity/workout?limit=${n}`);
  for (const x of d.records) console.log(JSON.stringify({ sport: x.sport_name, start: x.start, end: x.end, strain: x.score?.strain, avg_hr: x.score?.average_heart_rate, max_hr: x.score?.max_heart_rate, kcal: x.score?.kilojoule && Math.round(x.score.kilojoule / 4.184) }));
} else if (cmd === 'cycles') {
  const d = await get(`/v2/cycle?limit=${n}`);
  for (const x of d.records) console.log(JSON.stringify({ start: x.start, end: x.end, strain: x.score?.strain, avg_hr: x.score?.average_heart_rate, kcal: x.score?.kilojoule && Math.round(x.score.kilojoule / 4.184) }));
} else if (cmd === 'profile') {
  console.log(JSON.stringify({ ...(await get('/v2/user/profile/basic')), body: await get('/v2/user/measurement/body') }));
} else {
  console.error('usage: node whoop.mjs brief | recovery [n] | sleep [n] | workouts [n] | cycles [n] | profile');
  process.exit(1);
}
