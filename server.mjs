
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const DATA_FILE = path.resolve(__dirname, process.env.DATA_FILE || './data/studydeck-db.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${ORIGIN}/auth/google/callback`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

async function readDB() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch {
    const db = { users: {}, oauthStates: {}, telegramLinks: {}, telegramOffset: 0 };
    await writeDB(db);
    return db;
  }
}
async function writeDB(db) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DATA_FILE);
}
let writeLock = Promise.resolve();
async function mutateDB(fn) {
  let result;
  writeLock = writeLock.then(async () => {
    const db = await readDB();
    result = await fn(db);
    await writeDB(db);
  });
  await writeLock;
  return result;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))];
  }));
}
function setSession(res, userId, csrf) {
  const token = sign({ userId, csrf, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
  res.setHeader('Set-Cookie', `sd_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}${ORIGIN.startsWith('https:') ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `sd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${ORIGIN.startsWith('https:') ? '; Secure' : ''}`);
}
async function authUser(req) {
  const session = verify(cookies(req).sd_session);
  if (!session) return null;
  const db = await readDB();
  const user = db.users[session.userId];
  return user ? { session, user } : null;
}
async function requireAuth(req, res, next) {
  const auth = await authUser(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required.' });
  req.auth = auth;
  next();
}
function requireCsrf(req, res, next) {
  const provided = req.headers['x-csrf-token'];
  if (!req.auth?.session?.csrf || provided !== req.auth.session.csrf) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}
app.use('/api', async (req, res, next) => {
  if (req.path === '/me') return next();
  if (req.path.startsWith('/telegram/update')) return next();
  return requireAuth(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  return requireCsrf(req, res, next);
});

function cleanUser(user) {
  return {
    sub: user.sub, email: user.email, name: user.name || '', picture: user.picture || '',
    googleReady: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    aiAvailable: Boolean(OPENAI_API_KEY),
    telegramReady: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_USERNAME),
    telegramLinked: Boolean(user.telegramChatId),
    botUsername: TELEGRAM_BOT_USERNAME || null
  };
}

app.get('/api/me', async (req, res) => {
  const auth = await authUser(req);
  const base = {
    authenticated: Boolean(auth),
    user: auth ? cleanUser(auth.user) : null,
    csrf: auth?.session?.csrf || '',
    aiAvailable: Boolean(OPENAI_API_KEY),
    googleReady: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    telegramReady: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_USERNAME),
    telegramLinked: Boolean(auth?.user?.telegramChatId),
    botUsername: TELEGRAM_BOT_USERNAME || null
  };
  res.json(base);
});

app.get('/auth/google/start', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(503).send('Google OAuth is not configured.');
  const state = uid();
  await mutateDB(db => { db.oauthStates[state] = { createdAt: Date.now() }; });
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing OAuth code/state.');
  const db = await readDB();
  const pending = db.oauthStates[state];
  if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) return res.status(400).send('OAuth state expired.');
  await mutateDB(d => { delete d.oauthStates[state]; });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code),
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });
  const token = await tokenResp.json();
  if (!tokenResp.ok) return res.status(400).send(`OAuth token exchange failed: ${token.error || 'unknown error'}`);

  const infoResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  const info = await infoResp.json();
  if (!infoResp.ok || !info.sub) return res.status(400).send('Could not retrieve Google user profile.');

  const csrf = uid();
  await mutateDB(d => {
    const prev = d.users[info.sub] || {};
    d.users[info.sub] = {
      ...prev,
      sub: info.sub,
      email: info.email,
      name: info.name,
      picture: info.picture,
      googleRefreshToken: token.refresh_token || prev.googleRefreshToken || null,
      googleAccessToken: token.access_token,
      googleAccessExpiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
      state: prev.state || null,
      revision: Number(prev.revision || 0),
      createdAt: prev.createdAt || nowIso(),
      updatedAt: nowIso()
    };
  });
  setSession(res, info.sub, csrf);
  res.redirect('/?signedin=1');
});

app.post('/api/logout', async (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/state', async (req, res) => {
  const { user } = req.auth;
  res.json({ revision: Number(user.revision || 0), state: user.state || null });
});

app.put('/api/state', async (req, res) => {
  const expected = Number(req.body?.revision ?? -1);
  const incoming = req.body?.state;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'State object required.' });
  const result = await mutateDB(db => {
    const u = db.users[req.auth.user.sub];
    const current = Number(u.revision || 0);
    if (current !== expected) return { conflict: true, revision: current, state: u.state || null };
    u.state = incoming;
    u.revision = current + 1;
    u.updatedAt = nowIso();
    return { conflict: false, revision: u.revision };
  });
  if (result.conflict) return res.status(409).json(result);
  res.json({ revision: result.revision });
});

async function googleAccess(user) {
  if (user.googleAccessToken && Number(user.googleAccessExpiresAt || 0) > Date.now() + 60_000) return user.googleAccessToken;
  if (!user.googleRefreshToken) throw new Error('Google refresh token missing; reconnect Google.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: user.googleRefreshToken,
      grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'Google token refresh failed.');
  await mutateDB(db => {
    const u = db.users[user.sub];
    u.googleAccessToken = j.access_token;
    u.googleAccessExpiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
  });
  return j.access_token;
}
async function driveRequest(user, url, options={}) {
  const token = await googleAccess(user);
  const r = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(body?.error?.message || body?.error || `Drive request failed (${r.status})`);
  return body;
}
async function findDriveFolder(user, name, parentId=null) {
  const qParts = [`name='${name.replaceAll("'", "\\'")}'`, `mimeType='application/vnd.google-apps.folder'`, 'trashed=false'];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(' and '))}&fields=files(id,name)`;
  const j = await driveRequest(user, url);
  return j.files?.[0]?.id || null;
}
async function ensureDriveFolder(user, name, parentId=null) {
  let id = await findDriveFolder(user, name, parentId);
  if (id) return id;
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const j = await driveRequest(user, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return j.id;
}
async function findFile(user, name, parentId) {
  const q = `name='${name.replaceAll("'", "\\'")}' and '${parentId}' in parents and trashed=false`;
  const j = await driveRequest(user, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`);
  return j.files?.[0] || null;
}
async function uploadJsonToDrive(user, folderId, name, obj) {
  const existing = await findFile(user, name, folderId);
  const metadata = existing ? {} : { name, parents: [folderId], mimeType: 'application/json' };
  const boundary = `sd-${uid()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;
  const endpoint = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
  return driveRequest(user, endpoint, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  });
}
async function downloadDriveJson(user, fileId) {
  const token = await googleAccess(user);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive download failed (${r.status})`);
  return r.json();
}
app.post('/api/drive/backup', async (req, res) => {
  try {
    const root = await ensureDriveFolder(req.auth.user, 'StudyDeck Nexus');
    const payload = { schema: 'studydeck-nexus-backup-v1', exportedAt: nowIso(), state: req.auth.user.state };
    const file = await uploadJsonToDrive(req.auth.user, root, 'studydeck-nexus-backup.json', payload);
    res.json({ ok: true, fileId: file.id, bytes: Buffer.byteLength(JSON.stringify(payload)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/drive/restore', async (req, res) => {
  try {
    const root = await findDriveFolder(req.auth.user, 'StudyDeck Nexus');
    if (!root) return res.json({ state: null });
    const file = await findFile(req.auth.user, 'studydeck-nexus-backup.json', root);
    if (!file) return res.json({ state: null });
    const payload = await downloadDriveJson(req.auth.user, file.id);
    res.json({ state: payload.state || null, exportedAt: payload.exportedAt || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function findUnit(state, unitId) {
  return state?.nodes?.find(n => n.id === unitId) || null;
}
function extractGradeContext(state, body) {
  if (body.itemId) {
    const item = state?.items?.find(x => x.id === body.itemId);
    if (!item || item.type !== 'essay') throw new Error('Essay item not found.');
    const unit = findUnit(state, item.unitId);
    return { question: item.question, rubric: item.rubric, sourceNotes: unit?.sourceNotes || '', unitName: unit?.name || 'Unit' };
  }
  if (body.paperId) {
    const paper = state?.papers?.find(p => p.id === body.paperId);
    if (!paper) throw new Error('Practice paper not found.');
    const version = paper.versions?.find(v => v.id === body.versionId);
    const q = version?.questions?.[Number(body.questionIndex)];
    if (!q) throw new Error('Practice-paper question not found.');
    const unit = findUnit(state, paper.unitId);
    return { question: q.prompt, rubric: q.rubric, sourceNotes: unit?.sourceNotes || '', unitName: unit?.name || 'Unit' };
  }
  throw new Error('No grade target supplied.');
}
function stripFences(s) {
  return String(s || '').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
}
async function openAIJson(instructions, input) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI is not configured.');
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: 'none' },
      instructions,
      input,
      max_output_tokens: 1200
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI request failed (${r.status})`);
  const text = j.output_text || (j.output || []).flatMap(x => x.content || []).map(x => x.text || x.output_text || '').join('');
  try { return JSON.parse(stripFences(text)); }
  catch { throw new Error('The grading model returned invalid JSON.'); }
}

app.post('/api/grade', async (req, res) => {
  try {
    const state = req.auth.user.state;
    if (!state) throw new Error('Cloud workspace is empty.');
    const answer = String(req.body?.answer || '').trim();
    if (answer.length < 3) return res.status(400).json({ error: 'Write an answer first.' });
    const c = extractGradeContext(state, req.body);

    const instructions = `You are a fast semantic marker for a private study app.
Judge whether the student's answer captures the essential ideas in the rubric, not whether it matches wording.
Use source notes only as supporting context; do not invent requirements absent from the rubric/source.
For philosophy, theology, or interpretive subjects, allow defensible formulations and distinctions; flag genuine omissions rather than stylistic differences.
Return JSON only with:
{"verdict":"complete"|"partial"|"incorrect","confidence":"high"|"medium"|"low","feedback":"one concise sentence","missing":["short essential idea", ...]}
"complete" means the central claim and necessary distinctions are present in spirit.
"partial" means the core direction is right but at least one important required idea is missing.
"incorrect" means the answer's central content conflicts with the rubric/source or fails to answer the question.`;

    const input = `UNIT: ${c.unitName}
QUESTION:
${c.question}

ESSENTIAL RUBRIC:
${c.rubric}

REFERENCE NOTES (may be empty):
${String(c.sourceNotes).slice(0, 14000)}

STUDENT ANSWER:
${answer.slice(0, 12000)}`;

    const result = await openAIJson(instructions, input);
    const verdict = ['complete','partial','incorrect'].includes(result.verdict) ? result.verdict : 'partial';
    res.json({
      verdict,
      confidence: ['high','medium','low'].includes(result.confidence) ? result.confidence : 'low',
      feedback: String(result.feedback || 'Review against the rubric.').slice(0, 500),
      missing: Array.isArray(result.missing) ? result.missing.map(x => String(x).slice(0,180)).slice(0,8) : []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/generate', async (req, res) => {
  try {
    const state = req.auth.user.state;
    const paper = state?.papers?.find(p => p.id === req.body?.paperId);
    if (!paper) return res.status(404).json({ error: 'Practice paper not found.' });
    const unit = findUnit(state, paper.unitId);
    const prior = (paper.versions || []).flatMap(v => v.questions || []).map(q => q.prompt).filter(Boolean);
    const approvedEssayRubrics = (state.items || [])
      .filter(i => i.unitId === paper.unitId && i.type === 'essay' && !i.archived)
      .slice(0,30).map(i => ({ question: i.question, rubric: i.rubric }));

    const instructions = `Generate a fresh closed-book practice paper for a serious learner.
Use only the supplied unit notes, topics, and approved rubrics.
Do not reuse or closely paraphrase prior prompts.
Favor reconstruction, comparison, argument analysis, application, and synthesis over trivia.
Each rubric should list only the ideas necessary for a strong answer; do not demand exact wording.
Return JSON only:
{"questions":[{"prompt":"...","rubric":"...","essentialPoints":["...", "..."]}]}
Generate exactly the requested number of questions.`;

    const input = `UNIT: ${unit?.name || 'Unit'}
PAPER TOPICS:
${paper.topics}

QUESTION COUNT: ${Math.max(1, Math.min(8, Number(paper.questionCount || 3)))}

UNIT SOURCE NOTES:
${String(unit?.sourceNotes || '').slice(0, 20000)}

APPROVED ESSAY ITEMS:
${JSON.stringify(approvedEssayRubrics).slice(0, 10000)}

PRIOR PROMPTS TO AVOID:
${JSON.stringify(prior.slice(-80)).slice(0, 12000)}`;

    const result = await openAIJson(instructions, input);
    const qs = Array.isArray(result.questions) ? result.questions : [];
    if (qs.length !== Math.max(1, Math.min(8, Number(paper.questionCount || 3)))) throw new Error('The model returned the wrong number of paper questions.');
    res.json({ questions: qs.map(q => ({
      prompt: String(q.prompt || '').trim(),
      rubric: String(q.rubric || '').trim(),
      essentialPoints: Array.isArray(q.essentialPoints) ? q.essentialPoints.map(String).slice(0,8) : []
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function tg(method, body) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot not configured.');
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram request failed.');
  return j.result;
}
app.post('/api/telegram/link', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_BOT_USERNAME) return res.status(503).json({ error: 'Telegram is not configured.' });
  const token = uid().replaceAll('-','');
  await mutateDB(db => { db.telegramLinks[token] = { userId: req.auth.user.sub, expiresAt: Date.now() + 30*60*1000 }; });
  res.json({ url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}` });
});
app.post('/api/telegram/unlink', async (req, res) => {
  await mutateDB(db => { db.users[req.auth.user.sub].telegramChatId = null; });
  res.json({ ok:true });
});
app.post('/api/telegram/test', async (req, res) => {
  const db = await readDB();
  const chatId = db.users[req.auth.user.sub]?.telegramChatId;
  if (!chatId) return res.status(400).json({ error: 'Telegram is not linked.' });
  await tg('sendMessage', { chat_id: chatId, text: 'StudyDeck Nexus test: reminders are connected.' });
  res.json({ ok:true });
});

function unitNameMap(state) {
  return new Map((state?.nodes || []).map(n => [n.id, n.name]));
}
function dueByUnit(state, now = Date.now()) {
  const groups = new Map();
  const names = unitNameMap(state);
  for (const it of state?.items || []) {
    if (it.archived) continue;
    const due = !it.srs?.dueAt || Date.parse(it.srs.dueAt) <= now;
    if (!due) continue;
    if (!groups.has(it.unitId)) groups.set(it.unitId, { name: names.get(it.unitId) || 'Unit', flash:0, mcq:0, essay:0, papers:0 });
    const g = groups.get(it.unitId);
    if (it.type === 'flash') g.flash++;
    else if (it.type === 'mcq') g.mcq++;
    else if (it.type === 'essay') g.essay++;
  }
  for (const p of state?.papers || []) {
    if (p.archived) continue;
    const due = !p.schedule?.dueAt || Date.parse(p.schedule.dueAt) <= now;
    if (!due) continue;
    if (!groups.has(p.unitId)) groups.set(p.unitId, { name: names.get(p.unitId) || 'Unit', flash:0, mcq:0, essay:0, papers:0 });
    groups.get(p.unitId).papers++;
  }
  return [...groups.values()];
}
function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' });
  const parts = Object.fromEntries(f.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
async function processTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const db = await readDB();
  try {
    const updates = await tg('getUpdates', { offset: Number(db.telegramOffset || 0), timeout: 0, allowed_updates:['message'] });
    let max = Number(db.telegramOffset || 0);
    for (const up of updates) {
      max = Math.max(max, up.update_id + 1);
      const text = up.message?.text || '';
      const chatId = up.message?.chat?.id;
      const m = text.match(/^\/start\s+([A-Za-z0-9]+)$/);
      if (!m || !chatId) continue;
      const link = db.telegramLinks[m[1]];
      if (!link || link.expiresAt < Date.now()) continue;
      const user = db.users[link.userId];
      if (!user) continue;
      user.telegramChatId = chatId;
      delete db.telegramLinks[m[1]];
      await tg('sendMessage', { chat_id: chatId, text: 'StudyDeck Nexus linked. I will send review reminders when your units are due.' });
    }
    db.telegramOffset = max;
    await writeDB(db);
  } catch (e) {
    console.error('Telegram update error:', e.message);
  }
}
async function sendDueReminders() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const db = await readDB();
  let changed = false;
  for (const user of Object.values(db.users)) {
    if (!user.telegramChatId || !user.state?.settings?.notifications) continue;
    const tz = user.state.settings.timezone || 'UTC';
    const hour = Number(user.state.settings.reminderHour ?? 19);
    const local = zonedParts(new Date(), tz);
    if (local.hour !== hour) continue;
    user.reminderLog ||= {};
    if (user.reminderLog[local.date]) continue;
    const groups = dueByUnit(user.state);
    if (!groups.length) continue;
    const lines = ['StudyDeck review due:'];
    for (const g of groups) {
      const bits = [];
      if (g.flash) bits.push(`${g.flash} flashcard${g.flash===1?'':'s'}`);
      if (g.mcq) bits.push(`${g.mcq} MCQ${g.mcq===1?'':'s'}`);
      if (g.essay) bits.push(`${g.essay} long-form`);
      if (g.papers) bits.push(`${g.papers} fresh practice paper${g.papers===1?'':'s'}`);
      lines.push(`• ${g.name}: ${bits.join(', ')}`);
    }
    lines.push('', `${ORIGIN}`);
    try {
      await tg('sendMessage', { chat_id: user.telegramChatId, text: lines.join('\n') });
      user.reminderLog[local.date] = nowIso();
      changed = true;
    } catch (e) { console.error('Reminder send error:', e.message); }
  }
  if (changed) await writeDB(db);
}
setInterval(processTelegramUpdates, 10_000).unref();
setInterval(sendDueReminders, 10 * 60_000).unref();

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`StudyDeck Nexus running at ${ORIGIN}`));
