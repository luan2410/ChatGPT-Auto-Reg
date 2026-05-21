const express = require('express');
const path = require('path');
const net = require('net');
const Database = require('better-sqlite3');
const { execFile } = require('child_process');
const { chromium } = require('playwright');

const app = express();
const preferredPort = Number(process.env.PORT || 3000);
const apiUrl = 'https://tools.dongvanfb.net/api/graph_messages';
const db = new Database(path.join(__dirname, 'data.db'));
const STEP_TIMEOUT = 30000;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const CODE_WAIT_TIMEOUT = 120000;
const CODE_POLL_INTERVAL = 5000;
const runStatusStore = new Map();

const CHATGPT_SUBJECT_KEYWORDS = [
  'your temporary chatgpt login code',
  'your temporary chatgpt verification code',
  'your temporary chatgpt code'
];

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

initDb();

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      password TEXT DEFAULT '',
      refresh_token TEXT NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_code TEXT DEFAULT '',
      last_message TEXT DEFAULT '',
      last_subject TEXT DEFAULT '',
      last_date TEXT DEFAULT '',
      last_fetched_at TEXT DEFAULT '',
      session_raw TEXT DEFAULT '',
      session_fetched_at TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(list_id, email),
      FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
    );
  `);

  try { db.exec("ALTER TABLE accounts ADD COLUMN session_raw TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN session_fetched_at TEXT DEFAULT ''"); } catch {}
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCode(message) {
  if (message && message.code && String(message.code).trim()) {
    return String(message.code).trim();
  }
  const text = [message?.subject || '', htmlToText(message?.message || '')].join(' ');
  const match = text.match(/\b\d{4,8}\b/);
  return match ? match[0] : '';
}

function extractMessage(message) {
  const text = htmlToText(message?.message || '');
  if (!text) return message?.subject || '';
  return text.replace(/\b\d{4,8}\b/g, '').replace(/\s+/g, ' ').trim();
}

function isTargetSubject(subject) {
  const normalized = String(subject || '').trim().toLowerCase();
  return CHATGPT_SUBJECT_KEYWORDS.some(keyword => normalized.includes(keyword));
}

function parseDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const directTime = new Date(raw).getTime();
  if (Number.isFinite(directTime) && directTime > 0) {
    return directTime;
  }

  const compactPattern = new RegExp('^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*-\\s*(\\d{1,2})/(\\d{1,2})/(\\d{4})$');
  const compactMatch = raw.match(compactPattern);
  if (compactMatch) {
    const [, hour, minute, second = '0', day, month, year] = compactMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      0
    ).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const slashDatePattern = new RegExp('^(\\d{1,2})/(\\d{1,2})/(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$');
  const slashDateMatch = raw.match(slashDatePattern);
  if (slashDateMatch) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = slashDateMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      0
    ).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
function isRecentEnough(value, minTime) {
  if (!minTime) return true;
  return parseDateValue(value) >= minTime;
}

function floorToMinute(value) {
  const time = Number(value || 0);
  if (!time) return 0;
  return Math.floor(time / 60000) * 60000;
}

function isFreshOtpCandidate(message, options = {}) {
  if (options.acceptAnyTarget) return true;

  const messageTime = parseDateValue(message?.date);
  const messageMinute = floorToMinute(messageTime);
  const baselineTime = Number(options.lastKnownDateMs || 0);
  const baselineMinute = floorToMinute(baselineTime);
  const baselineCode = String(options.lastKnownCode || '').trim();
  const messageCode = extractCode(message);
  const hasBaseline = Boolean(baselineTime || baselineCode);
  const requiredMinute = floorToMinute(options.requireAfterMs || 0);
  const minMinute = floorToMinute(options.minDateMs || 0);

  if (requiredMinute && messageMinute && messageMinute < requiredMinute) {
    return false;
  }

  if (hasBaseline) {
    const isNewerThanBaseline = baselineMinute ? messageMinute >= baselineMinute : true;
    const isDifferentCode = baselineCode ? Boolean(messageCode && messageCode !== baselineCode) : Boolean(messageCode);
    return Boolean(isNewerThanBaseline && isDifferentCode);
  }

  if (minMinute && messageMinute) {
    return messageMinute >= minMinute;
  }

  return true;
}

function updateRunStatus(accountId, patch) {
  const current = runStatusStore.get(accountId) || { steps: [], running: false };
  const next = { ...current, ...patch };
  if (!Array.isArray(next.steps)) next.steps = current.steps || [];
  runStatusStore.set(accountId, next);
  return next;
}

function clearRunStatusLater(accountId, delayMs = 300000) {
  setTimeout(() => {
    const current = runStatusStore.get(accountId);
    if (current && !current.running) runStatusStore.delete(accountId);
  }, delayMs).unref?.();
}

function createStepLogger(accountId) {
  const steps = [];
  updateRunStatus(accountId, { running: true, steps, updatedAt: new Date().toISOString(), error: '', message: '' });
  return {
    steps,
    push(message) {
      const item = { at: new Date().toISOString(), message };
      steps.push(item);
      updateRunStatus(accountId, { running: true, steps, updatedAt: item.at });
    }
  };
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function jitterPoint(box, ratioX = 0.5, ratioY = 0.5, spread = 0.18) {
  const centerX = box.x + box.width * ratioX;
  const centerY = box.y + box.height * ratioY;
  const offsetX = (Math.random() - 0.5) * box.width * spread;
  const offsetY = (Math.random() - 0.5) * box.height * spread;

  return {
    x: clamp(centerX + offsetX, box.x + 3, box.x + box.width - 3),
    y: clamp(centerY + offsetY, box.y + 3, box.y + box.height - 3)
  };
}

async function humanPause(base = 10000, jitter = 1200) {
  const ms = Math.max(500, base + randomBetween(-jitter, jitter));
  await sleep(ms);
}

async function prepareVisibleLocator(locator, timeout = STEP_TIMEOUT) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(500, 150);
}

async function stableClick(locator, timeout = STEP_TIMEOUT) {
  await prepareVisibleLocator(locator, timeout);
  const page = locator.page();
  const box = await locator.boundingBox();

  if (box) {
    const approachPoint = jitterPoint(box, randomFloat(0.3, 0.45), randomFloat(0.2, 0.4), 0.28);
    const targetPoint = jitterPoint(box, randomFloat(0.45, 0.65), randomFloat(0.45, 0.62), 0.16);

    await page.mouse.move(
      approachPoint.x + randomBetween(-40, 40),
      approachPoint.y + randomBetween(-25, 25),
      { steps: randomBetween(8, 15) }
    ).catch(() => {});
    await sleep(randomBetween(90, 180));
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: randomBetween(10, 22) }).catch(() => {});
    await sleep(randomBetween(120, 260));
    await page.mouse.down({ button: 'left' });
    await sleep(randomBetween(45, 110));
    await page.mouse.up({ button: 'left' });
    await locator.waitFor({ state: 'attached', timeout }).catch(() => {});
    return;
  }

  await locator.hover().catch(() => {});
  await humanPause(700, 200);
  await locator.click({ timeout, delay: randomBetween(50, 120) });
}

async function humanType(locator, text) {
  await prepareVisibleLocator(locator);
  await stableClick(locator);
  await humanPause(900, 300);

  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const isSeparator = /[@._-]/.test(char);
    const isLast = index === value.length - 1;
    const keyDelay = isSeparator ? randomBetween(140, 260) : randomBetween(70, 170);
    await locator.pressSequentially(char, { delay: keyDelay });

    const thinkingPause = isSeparator ? randomBetween(120, 240) : randomBetween(35, 120);
    await sleep(thinkingPause);

    if (!isLast && Math.random() < 0.08) {
      await sleep(randomBetween(180, 320));
    }
  }

  await sleep(randomBetween(120, 260));
}

async function waitForPotentialPopup(context, timeout = STEP_TIMEOUT) {
  try {
    return await context.waitForEvent('page', { timeout });
  } catch {
    return null;
  }
}

async function createHumanizedContext(browser) {
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    screen: DEFAULT_VIEWPORT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: DESKTOP_CHROME_UA,
    colorScheme: 'light',
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    window.chrome = window.chrome || { runtime: {} };

    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  });

  return context;
}

async function resolveEmailInput(page) {
  const candidates = [
    page.getByRole('textbox', { name: /email/i }).first(),
    page.locator('input[type="email"]').first(),
    page.locator('input[name="email"]').first(),
    page.locator('input[autocomplete="email"]').first(),
    page.locator('input[placeholder*="email" i]').first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay o nhap email sau khi bam Sign up for free.');
}

async function resolveContinueButton(page) {
  const candidates = [
    page.getByRole('button', { name: /^continue$/i }).first(),
    page.getByText(/^Continue$/).locator('..').first(),
    page.locator('button:has-text("Continue")').first(),
    page.locator('[role="button"]:has-text("Continue")').first(),
    page.locator('div.flex.items-center.justify-center').filter({ hasText: /^Continue$/ }).first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay nut Continue sau khi nhap email.');
}

function deriveFullNameFromEmail(email) {
  const localPart = String(email || '').split('@')[0] || 'OpenAI User';
  const cleaned = localPart.replace(/[._-]+/g, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = (cleaned || 'OpenAI User').split(' ').filter(Boolean).slice(0, 3);
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

function randomAge() {
  return String(randomBetween(20, 35));
}

async function resolveFullNameInput(page) {
  const candidates = [
    page.getByRole('textbox', { name: /full name/i }).first(),
    page.locator('input[name*="name" i]').first(),
    page.locator('input[autocomplete="name"]').first(),
    page.locator('div._typeableLabelTextPositioner_1i5mj_88').filter({ hasText: /^Full name$/i }).locator('xpath=ancestor::*[1]/following::input[1]').first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay o nhap Full name.');
}

async function resolveAgeInput(page) {
  const candidates = [
    page.getByRole('textbox', { name: /^age$/i }).first(),
    page.locator('input[name*="age" i]').first(),
    page.locator('input[inputmode="numeric"]').nth(1),
    page.locator('div._typeableLabelTextPositioner_1i5mj_88').filter({ hasText: /^Age$/i }).locator('xpath=ancestor::*[1]/following::input[1]').first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay o nhap Age.');
}

async function resolveFinishCreateAccountButton(page) {
  const candidates = [
    page.getByRole('button', { name: /finish creating account/i }).first(),
    page.locator('button:has-text("Finish creating account")').first(),
    page.locator('button[data-dd-action-name="Continue"]').filter({ hasText: /finish creating account/i }).first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay nut Finish creating account.');
}
async function resolveCodeInput(page) {
  const candidates = [
    page.getByRole('textbox', { name: /^code$/i }).first(),
    page.locator('input[autocomplete="one-time-code"]').first(),
    page.locator('input[inputmode="numeric"]').first(),
    page.locator('input[name*="code" i]').first(),
    page.locator('div._typeableLabelTextPositioner_1i5mj_88').filter({ hasText: /^Code$/ }).locator('xpath=ancestor::*[1]/following::input[1]').first(),
    page.locator('input[type="text"]').first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return locator;
    } catch {}
  }

  throw new Error('Khong tim thay o nhap Code sau khi bam Continue.');
}

async function fetchCodeFromMail(account, options = {}) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: account.email,
      refresh_token: account.refresh_token,
      client_id: account.client_id,
      list_mail: 'all'
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error('API khong tra ve JSON hop le.');
  }

  if (!response.ok || data.status === false) {
    throw new Error(data.content || 'Request that bai.');
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const targetMessages = messages
    .filter(item => isTargetSubject(item.subject))
    .sort((a, b) => parseDateValue(b.date) - parseDateValue(a.date));

  const filtered = targetMessages.filter(item => isFreshOtpCandidate(item, options));

  if (filtered.length === 0) {
    return {
      data,
      latest: null,
      code: '',
      message: '',
      debug: { totalMessages: messages.length, targetMessages: targetMessages.length, freshMatches: 0, latestTargetDate: targetMessages[0]?.date || '', latestTargetCode: targetMessages[0] ? extractCode(targetMessages[0]) : '' }
    };
  }

  const latest = filtered[0];
  return {
    data,
    latest,
    code: extractCode(latest),
    message: extractMessage(latest),
    debug: { totalMessages: messages.length, targetMessages: targetMessages.length, freshMatches: filtered.length, latestTargetDate: targetMessages[0]?.date || '', latestTargetCode: targetMessages[0] ? extractCode(targetMessages[0]) : '' }
  };
}

async function pollLatestCode(account, timeout = CODE_WAIT_TIMEOUT, interval = CODE_POLL_INTERVAL, options = {}) {
  const startedAt = Date.now();
  let lastData = null;
  let attempt = 0;

  while (Date.now() - startedAt < timeout) {
    attempt += 1;
    const result = await fetchCodeFromMail(account, options);
    lastData = result.data;

    if (typeof options.onAttempt === 'function') {
      options.onAttempt({
        attempt,
        hasCode: Boolean(result.code),
        hasMatchedMail: Boolean(result.latest),
        debug: result.debug || null
      });
    }

    if (result.latest && result.code) {
      return result;
    }

    await sleep(interval);
  }

  return { data: lastData, latest: null, code: '', message: '' };
}

function saveCodeFetchResult(accountId, result) {
  const fetchedAt = new Date().toISOString();

  if (!result.latest || !result.code) {
    db.prepare(
      "UPDATE accounts SET status = 'pending', last_code = '', last_message = '', last_subject = '', last_date = '', last_fetched_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(fetchedAt, accountId);
    return null;
  }

  db.prepare(
    "UPDATE accounts SET status = 'success', last_code = ?, last_message = ?, last_subject = ?, last_date = ?, last_fetched_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(result.code, result.message, result.latest.subject || '', result.latest.date || '', fetchedAt, accountId);

  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}

function normalizeSessionPayload(sessionRaw) {
  const now = new Date();
  const createdAt = now.toISOString();
  let parsed;

  try {
    parsed = JSON.parse(String(sessionRaw || '{}'));
  } catch {
    throw new Error('Session payload khong phai JSON hop le.');
  }

  const expiresAt = parsed.expires || parsed.expiresAt || '';
  const expiresTime = expiresAt ? new Date(expiresAt).getTime() : 0;
  const expiresIn = expiresTime ? Math.max(0, Math.floor((expiresTime - now.getTime()) / 1000)) : 0;
  const email = parsed?.user?.email || parsed?.email || '';
  const accountId = parsed?.account?.id || parsed?.user?.id || '';
  const planType = parsed?.account?.planType || '';

  return {
    accessToken: parsed.accessToken || '',
    refreshToken: parsed.refreshToken || '',
    expiresAt,
    testStatus: 'active',
    expiresIn,
    providerSpecificData: {
      chatgptAccountId: accountId,
      chatgptPlanType: planType
    },
    id: accountId,
    provider: 'codex',
    authType: 'oauth',
    name: email || parsed?.user?.name || '',
    email,
    priority: 1,
    isActive: true,
    createdAt,
    updatedAt: createdAt
  };
}

function listConvertedSessions(list) {
  return (list?.accounts || [])
    .map(account => {
      try {
        return account.session_raw ? JSON.parse(account.session_raw) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function captureSessionPayload(page) {
  const sessionUrl = 'https://chatgpt.com/api/auth/session';
  const response = await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  const payloadText = await page.locator('body').innerText().catch(async () => {
    return response ? await response.text().catch(() => '') : '';
  });
  return { sessionUrl, payloadText: String(payloadText || '').trim() };
}

function saveSessionSnapshot(accountId, sessionRaw) {
  const fetchedAt = new Date().toISOString();
  const normalized = normalizeSessionPayload(sessionRaw);
  db.prepare("UPDATE accounts SET session_raw = ?, session_fetched_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(normalized, null, 2), fetchedAt, accountId);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}
async function performGetCodeAction(accountId, options = {}) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    throw new Error('Khong tim thay tai khoan.');
  }

  db.prepare("UPDATE accounts SET status = 'inprocess', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(accountId);

  const mode = options.waitForNewCode ? 'wait-new-code' : 'latest-code';
  if (typeof options.onLog === 'function') {
    options.onLog(`Get code action mode: ${mode}.`);
  }

  const result = options.waitForNewCode
    ? await pollLatestCode(account, options.timeout || CODE_WAIT_TIMEOUT, options.interval || CODE_POLL_INTERVAL, {
        requireAfterMs: options.requireAfterMs,
        minDateMs: options.minDateMs,
        lastKnownDateMs: options.lastKnownDateMs,
        lastKnownCode: options.lastKnownCode,
        onAttempt: options.onAttempt
      })
    : await fetchCodeFromMail(account, {
        acceptAnyTarget: options.acceptAnyTarget,
        requireAfterMs: options.requireAfterMs,
        minDateMs: options.minDateMs,
        lastKnownDateMs: options.lastKnownDateMs,
        lastKnownCode: options.lastKnownCode
      });

  const updatedAccount = saveCodeFetchResult(accountId, result);
  return {
    account: updatedAccount,
    result,
    lists: getListsWithAccounts()
  };
}

function getListsWithAccounts() {
  const lists = db.prepare('SELECT id, name, created_at FROM lists ORDER BY id DESC').all();
  const accounts = db.prepare(`
    SELECT id, list_id, email, password, refresh_token, client_id, status,
           last_code, last_message, last_subject, last_date, last_fetched_at,
           session_raw, session_fetched_at,
           created_at, updated_at
    FROM accounts
    ORDER BY email COLLATE NOCASE ASC
  `).all();

  return lists.map(list => ({
    ...list,
    accounts: accounts.filter(account => account.list_id === list.id)
  }));
}

app.get('/api/lists', (req, res) => {
  res.json({ lists: getListsWithAccounts() });
});

app.post('/api/lists', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Tên danh sách là bắt buộc.' });
  }

  const result = db.prepare('INSERT INTO lists (name) VALUES (?)').run(name);
  res.json({ id: result.lastInsertRowid, lists: getListsWithAccounts() });
});

app.delete('/api/lists/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM accounts WHERE list_id = ?').run(id);
  db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  res.json({ lists: getListsWithAccounts() });
});

app.delete('/api/data', (req, res) => {
  db.prepare('DELETE FROM accounts').run();
  db.prepare('DELETE FROM lists').run();
  res.json({ lists: [] });
});

app.post('/api/lists/:id/import', (req, res) => {
  const listId = Number(req.params.id);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  const insertStmt = db.prepare(`
    INSERT INTO accounts (list_id, email, password, refresh_token, client_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    ON CONFLICT(list_id, email) DO UPDATE SET
      password = excluded.password,
      refresh_token = excluded.refresh_token,
      client_id = excluded.client_id,
      status = 'pending',
      updated_at = CURRENT_TIMESTAMP
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      insertStmt.run(listId, item.email, item.password || '', item.refresh_token, item.client_id);
    }
  });

  tx(rows);
  res.json({ lists: getListsWithAccounts() });
});

app.delete('/api/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  res.json({ lists: getListsWithAccounts() });
});

app.get('/api/accounts/:id/run-status', (req, res) => {
  const id = Number(req.params.id);
  const status = runStatusStore.get(id) || { running: false, steps: [], updatedAt: '', error: '', message: '' };
  res.json(status);
});
app.post('/api/accounts/:id/run', async (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  if (!account) {
    return res.status(404).json({ error: 'Khong tim thay tai khoan.' });
  }

  const url = 'https://openai.com/';
  let browser;
  const stepLog = createStepLogger(id);

  try {
    const flowStartedAt = Date.now();
    stepLog.push('Khoi tao browser va context gia lap desktop.');

    browser = await chromium.launch({
      headless: false,
      slowMo: randomBetween(45, 90),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-default-browser-check',
        '--start-maximized'
      ]
    });
    const context = await createHumanizedContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT);
    await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
    stepLog.push('Da mo openai.com.');
    await humanPause(10000, 1500);

    const tryChatGpt = page.getByRole('link', { name: /try chatgpt/i }).first();
    await prepareVisibleLocator(tryChatGpt);
    await humanPause(1800, 500);

    stepLog.push('Dang click Try ChatGPT va cho tab dich.');
    const [targetPageCandidate] = await Promise.all([
      waitForPotentialPopup(context, STEP_TIMEOUT),
      stableClick(tryChatGpt)
    ]);

    let targetPage = targetPageCandidate;
    if (targetPage) {
      await targetPage.waitForLoadState('domcontentloaded', { timeout: STEP_TIMEOUT }).catch(() => {});
      await targetPage.bringToFront().catch(() => {});
      stepLog.push('Da nhan dien popup/tab moi cua ChatGPT.');
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout: STEP_TIMEOUT }).catch(() => {});
      targetPage = page;
      stepLog.push('Khong co popup moi, tiep tuc tren tab hien tai.');
    }

    await humanPause(10000, 1500);

    const signUpButton = targetPage.getByText(/^Sign up for free$/i).first();
    await prepareVisibleLocator(signUpButton);
    await humanPause(1600, 400);
    await stableClick(signUpButton);
    stepLog.push('Da bam Sign up for free.');

    await humanPause(2500, 800);

    const emailInput = await resolveEmailInput(targetPage);
    await prepareVisibleLocator(emailInput);
    await emailInput.fill('');
    await humanPause(900, 300);
    await humanType(emailInput, account.email);
    stepLog.push(`Da nhap email ${account.email}.`);

    await humanPause(1200, 400);

    const baselineCodeState = await fetchCodeFromMail(account, { acceptAnyTarget: true }).catch(() => ({ latest: null, code: '', debug: null }));
    const baselineDateMs = parseDateValue(baselineCodeState.latest?.date || account.last_date);
    const baselineCode = baselineCodeState.code || account.last_code || '';
    stepLog.push(`Da chup moc OTP truoc khi gui ma. baseline code: ${baselineCode || '-'}, baseline date: ${baselineCodeState.latest?.date || account.last_date || '-'}.`);

    const continueButton = await resolveContinueButton(targetPage);
    await prepareVisibleLocator(continueButton);
    await humanPause(900, 300);
    await stableClick(continueButton);
    const otpRequestedAt = Date.now();
    stepLog.push('Da bam Continue sau khi nhap email, dang cho o Code.');

    const codeInput = await resolveCodeInput(targetPage);
    await prepareVisibleLocator(codeInput, CODE_WAIT_TIMEOUT);
    stepLog.push('Da thay o nhap Code.');
    await humanPause(1200, 300);

    stepLog.push('Da goi chuc nang Get code ngay sau khi bam Continue.');
    const getCodeAction = await performGetCodeAction(id, {
      waitForNewCode: true,
      timeout: CODE_WAIT_TIMEOUT,
      interval: CODE_POLL_INTERVAL,
      requireAfterMs: baselineDateMs || otpRequestedAt - 1000,
      minDateMs: otpRequestedAt - 15000,
      lastKnownDateMs: baselineDateMs,
      lastKnownCode: baselineCode,
      onLog: (message) => stepLog.push(message),
      onAttempt: ({ attempt, hasCode, hasMatchedMail, debug }) => {
        if (attempt === 1) {
          stepLog.push(`Bat dau request lay code lan 1. Target mails: ${debug?.targetMessages ?? 0}, fresh matches: ${debug?.freshMatches ?? 0}.`);
          return;
        }

        if (!hasMatchedMail) {
          stepLog.push(`Lan ${attempt}: chua co OTP moi hon baseline. Target mails: ${debug?.targetMessages ?? 0}, fresh matches: ${debug?.freshMatches ?? 0}, latest target date: ${debug?.latestTargetDate || '-'}, latest target code: ${debug?.latestTargetCode || '-'}.`);
          return;
        }

        if (!hasCode) {
          stepLog.push(`Lan ${attempt}: da co mail moi hon baseline nhung chua tach duoc code.`);
          return;
        }

        stepLog.push(`Lan ${attempt}: da lay duoc OTP hop le.`);
      }
    });
    const codeResult = getCodeAction.result;
    const updatedAccount = getCodeAction.account;
    if (codeResult.code) stepLog.push(`Da lay duoc code moi ${codeResult.code}.`);

    if (!codeResult.code) {
      throw new Error('Da goi chuc nang lay code sau khi bam Continue nhung chua nhan duoc OTP hop le trong thoi gian cho.');
    }

    await codeInput.fill('');
    await humanPause(1000, 250);
    await humanType(codeInput, codeResult.code);
    stepLog.push('Da nhap code vao form.');
    await humanPause(1300, 350);

    const confirmContinueButton = await resolveContinueButton(targetPage);
    await prepareVisibleLocator(confirmContinueButton);
    await humanPause(900, 300);
    await stableClick(confirmContinueButton);
    stepLog.push('Da bam Continue sau khi nhap code.');
    await humanPause(2500, 700);

    const fullName = deriveFullNameFromEmail(account.email);
    const age = randomAge();

    const fullNameInput = await resolveFullNameInput(targetPage);
    await prepareVisibleLocator(fullNameInput);
    await fullNameInput.fill('');
    await humanPause(800, 200);
    await humanType(fullNameInput, fullName);
    stepLog.push(`Da nhap Full name: ${fullName}.`);

    await humanPause(900, 250);

    const ageInput = await resolveAgeInput(targetPage);
    await prepareVisibleLocator(ageInput);
    await ageInput.fill('');
    await humanPause(700, 180);
    await humanType(ageInput, age);
    stepLog.push(`Da nhap Age: ${age}.`);

    await humanPause(1200, 300);

    const finishCreateAccountButton = await resolveFinishCreateAccountButton(targetPage);
    await prepareVisibleLocator(finishCreateAccountButton);
    await humanPause(900, 250);
    await stableClick(finishCreateAccountButton);
    stepLog.push('Da bam Finish creating account.');
    stepLog.push('Dang cho 10 giay de account hoan tat dang ky truoc khi lay session.');
    await humanPause(10000, 500);

    const sessionCapture = await captureSessionPayload(targetPage);
    const accountWithSession = saveSessionSnapshot(id, sessionCapture.payloadText);
    stepLog.push(`Da lay va luu session tu ${sessionCapture.sessionUrl}.`);

    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }

    updateRunStatus(id, { running: false, updatedAt: new Date().toISOString(), message: `Da mo OpenAI, nhap email ${account.email}, lay code ${codeResult.code}, dien Full name ${fullName}, Age ${age}, bam Finish creating account va luu session`, steps: stepLog.steps });
    clearRunStatusLater(id);

    res.json({
      ok: true,
      message: `Da mo OpenAI, nhap email ${account.email}, lay code ${codeResult.code}, dien Full name ${fullName}, Age ${age}, bam Finish creating account va luu session`,
      account: accountWithSession || updatedAccount || account,
      url,
      sessionUrl: sessionCapture.sessionUrl,
      steps: stepLog.steps
    });
  } catch (error) {
    stepLog.push(`Flow loi: ${error.message || 'Khong chay duoc flow OpenAI.'}`);

    if (browser) {
      try { await browser.close(); } catch {}
    }

    updateRunStatus(id, { running: false, updatedAt: new Date().toISOString(), error: error.message || 'Khong chay duoc flow OpenAI.', steps: stepLog.steps });
    clearRunStatusLater(id);
    return res.status(500).json({ error: error.message || 'Khong chay duoc flow OpenAI.', steps: stepLog.steps });
  }
});

app.post('/api/accounts/:id/get-code', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const payload = await performGetCodeAction(id);

    if (!payload.result.code) {
      return res.status(404).json({ error: 'Khong tim thay mail ChatGPT phu hop.', raw: payload.result.data, lists: payload.lists });
    }

    res.json({
      account: payload.account,
      raw: payload.result.data,
      lists: payload.lists
    });
  } catch (error) {
    if (String(error.message || '').includes('Khong tim thay tai khoan')) {
      return res.status(404).json({ error: 'Khong tim thay tai khoan.' });
    }

    db.prepare("UPDATE accounts SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    res.status(500).json({ error: error.message || 'Lay code that bai.', lists: getListsWithAccounts() });
  }
});

function checkPortAvailable(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

async function listenOnAvailablePort(startPort, maxAttempts = 10) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    const available = await checkPortAvailable(port);
    if (!available) continue;

    app.listen(port, () => {
      const suffix = port === startPort ? '' : ` (port ${startPort} ban, tu chuyen sang ${port})`;
      console.log(`Server running at http://localhost:${port}${suffix}`);
    });
    return;
  }

  throw new Error(`Khong tim duoc port trong dai ${startPort}-${startPort + maxAttempts - 1}.`);
}

listenOnAvailablePort(preferredPort).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});

