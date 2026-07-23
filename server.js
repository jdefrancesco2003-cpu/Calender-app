const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes, randomInt } = require('crypto');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const chrono = require('chrono-node');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('trust proxy', 1); // Railway / reverse proxy: use X-Forwarded-For for real client IP
app.use(express.json());
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

const EST_TIMEZONE = 'America/New_York';

function getESTDateString() {
  const now = new Date();
  const estFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: EST_TIMEZONE
  });
  const parts = estFormatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function getESTTimeString() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: EST_TIMEZONE
  }).format(now);
}

function getCurrentESTInfo() {
  return { date: getESTDateString(), time: getESTTimeString(), timezone: EST_TIMEZONE };
}

// ── Auth config ──
const JWT_SECRET = process.env.JWT_SECRET || null; // null = dev mode (no auth required)
const BCRYPT_ROUNDS = 12;

// ── Web Push (VAPID) ──
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.ADMIN_EMAIL || 'jdefrancesco2003@gmail.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  const keys = webpush.generateVAPIDKeys();
  console.log('⚠ VAPID keys missing — add to Railway env vars:');
  console.log('  VAPID_PUBLIC_KEY=' + keys.publicKey);
  console.log('  VAPID_PRIVATE_KEY=' + keys.privateKey);
}
function generateSalt() { return randomBytes(16).toString('hex'); }
function generateOTP() { return String(randomInt(100000, 1000000)); }

// ── Email — Resend (preferred, HTTPS) or nodemailer SMTP fallback ──
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const smtpTransport = (process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;
const EMAIL_FROM = process.env.EMAIL_FROM || (process.env.SMTP_USER ? `Marked <${process.env.SMTP_USER}>` : 'Marked <onboarding@resend.dev>');

async function sendEmail(to, subject, html) {
  if (resendClient) {
    const { data, error } = await resendClient.emails.send({ from: EMAIL_FROM, to, subject, html });
    if (error) {
      console.error('[Resend] Send failed — from:', EMAIL_FROM, '| to:', to, '| error:', JSON.stringify(error));
      throw new Error(error.message || JSON.stringify(error));
    }
    console.log('[Resend] Sent OK — id:', data?.id, '| to:', to);
    return;
  }
  if (smtpTransport) {
    await smtpTransport.sendMail({ from: EMAIL_FROM, to, subject, html });
    return;
  }
  console.log(`[DEV EMAIL] To:${to} | ${subject}`);
}

function emailBase(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f0f5;padding:40px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
  <tr><td style="background:#1a1a2e;border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
    <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;">Mark<span style="color:#4a9d6f;">ed</span></span>
  </td></tr>
  <tr><td style="background:#fff;padding:32px 32px 24px;">${content}</td></tr>
  <tr><td style="background:#f8f8fa;border-radius:0 0 16px 16px;padding:18px 32px;text-align:center;border-top:1px solid #e8e8ed;">
    <p style="margin:0;font-size:12px;color:#9e9ea7;line-height:1.5;">You're receiving this because of activity on your Marked account.<br>If this wasn't you, you can safely ignore this email.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function emailOTPBlock(code) {
  return `<div style="background:#f5f5f7;border-radius:12px;padding:28px 16px;text-align:center;margin:20px 0;">
    <span style="font-size:44px;font-weight:700;letter-spacing:14px;color:#1a1a2e;font-family:'Courier New',monospace;">${code}</span>
  </div>`;
}

function resetPasswordEmailHtml(code) {
  return emailBase(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a2e;">Reset your password</h2>
    <p style="margin:0;font-size:15px;color:#6e6e73;line-height:1.6;">Enter this code in the app to reset your Marked password. It expires in <strong style="color:#1a1a2e;">15 minutes</strong>.</p>
    ${emailOTPBlock(code)}
    <p style="margin:0;font-size:13px;color:#9e9ea7;text-align:center;">Didn't request this? Your account is safe — no action needed.</p>`);
}

function verifyEmailHtml(code) {
  return emailBase(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a2e;">Verify your email</h2>
    <p style="margin:0;font-size:15px;color:#6e6e73;line-height:1.6;">Welcome to Marked! Enter this code in the app to verify your email address.</p>
    ${emailOTPBlock(code)}
    <p style="margin:0;font-size:13px;color:#9e9ea7;text-align:center;">This code expires in 1 hour.</p>`);
}

const client = new Anthropic();
const mongoUri = process.env.MONGODB_URI;
let eventsCollection;
let usersCollection;
let pushSubsCollection;
let calTokensCollection;
let mongoClient;

// ── Rate limiters ──
function makeRateLimiter(max, windowMs) {
  const store = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
  }, 300000);
  return function check(key) {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || now > entry.expiresAt) { store.set(key, { count: 1, expiresAt: now + windowMs }); return true; }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}
const checkParseRateLimit = makeRateLimiter(20, 60000);   // 20/min burst per IP
const checkAuthRateLimit  = makeRateLimiter(5,  900000);  // 5 attempts/15 min for auth
const checkShareRateLimit = makeRateLimiter(120, 60000);  // 120/min for public share endpoints

// ── Per-user daily AI parse quota ──
// Local parses are free/unlimited. AI fallback: 30/day signed-in, 5/day guest.
const parseQuotas = new Map();
setInterval(() => {
  const today = getESTDateString();
  for (const [k, v] of parseQuotas) if (v.date !== today) parseQuotas.delete(k);
}, 3600000);
function checkParseQuota(key, isGuest) {
  const limit = isGuest ? 5 : 30;
  const today = getESTDateString();
  const entry = parseQuotas.get(key);
  if (!entry || entry.date !== today) { parseQuotas.set(key, { count: 1, date: today }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}
// Give back a consumed AI credit when the call itself failed (outage, bad JSON)
// so a user isn't charged for nothing.
function refundParseQuota(key) {
  const entry = parseQuotas.get(key);
  if (entry && entry.count > 0) entry.count--;
}

// ── Parse result cache (6-hour TTL, max 500 entries) ──
const parseCache = new Map();
function cacheKey(text, today, defaultDate) {
  return `${text.toLowerCase().trim()}|${today}|${defaultDate || today}`;
}
function getCachedParse(text, today, defaultDate) {
  const key = cacheKey(text, today, defaultDate);
  const hit = parseCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.result;
  parseCache.delete(key);
  return null;
}
function setCachedParse(text, today, defaultDate, result) {
  if (parseCache.size >= 500) parseCache.delete(parseCache.keys().next().value);
  parseCache.set(cacheKey(text, today, defaultDate), { result, expiresAt: Date.now() + 6 * 3600000 });
}

// ── Local natural-language parser (no API cost) ──
const CAT_KEYWORDS = {
  health: /\b(doctor|dr\.?|dentist|dental|medical|appointment|appt|therapy|therapist|physio|gym|workout|exercise|pharmacy|hospital|clinic|checkup|check.?up|surgery|physical|prescription|optometrist|eye exam|blood)\b/i,
  work:   /\b(meeting|call|conference|standup|stand.?up|sprint|presentation|interview|review|deadline|client|office|team|zoom|teams|slack|1:?1|one.?on.?one|sync|demo|training|webinar|all.?hands|project)\b/i,
  social: /\b(lunch|dinner|breakfast|brunch|party|birthday|wedding|hangout|date|concert|show|game|trip|travel|vacation|flight|hotel|coffee|drinks|bar|restaurant|movie|movies|festival|family|friends?)\b/i,
};
function detectCategory(text) {
  if (CAT_KEYWORDS.health.test(text)) return 'health';
  if (CAT_KEYWORDS.work.test(text))   return 'work';
  if (CAT_KEYWORDS.social.test(text)) return 'social';
  return 'work';
}
function detectRecurrence(text) {
  const t = text.toLowerCase();
  if (/every\s+day|daily/.test(t))                                                        return 'daily';
  if (/every\s+week|weekly|every\s+(mon|tue|wed|thu|fri|sat|sun)/.test(t))               return 'weekly';
  if (/every\s+month|monthly/.test(t))                                                    return 'monthly';
  if (/every\s+year|yearly|annually/.test(t))                                             return 'yearly';
  return 'none';
}
function pad2(n) { return String(n).padStart(2, '0'); }
const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
// Disambiguate time ranges so chrono doesn't read the start as pm and wrap the
// end past midnight. Handles "9-5pm" → "9am-5pm" and bare "9-5:30" → "9am-5:30pm".
const MONTH_BEFORE_RE = new RegExp('(?:' + MONTH_NAMES + ')\\s*$', 'i');
function normalizeBareRange(text) {
  // Ranges that already carry a meridiem: fix the first half if it's missing one.
  text = text.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    (m, h1, m1, h2, m2, mer, offset, full) => {
      if (MONTH_BEFORE_RE.test(full.slice(0, offset))) return m; // "June 5-7pm" → leave the dates
      const H1 = parseInt(h1, 10), H2 = parseInt(h2, 10);
      const lower = mer.toLowerCase();
      // 9-5pm → 9am-5pm; 11-12pm → 11am-12pm (noon), not 11pm.
      let firstMer = lower;
      if (lower === 'pm' && H1 !== 12) {
        if (H1 > H2) firstMer = 'am';
        else if (H2 === 12 && H1 >= 7 && H1 <= 11) firstMer = 'am';
      }
      return h1 + (m1 ? ':' + m1 : '') + firstMer + '-' + h2 + (m2 ? ':' + m2 : '') + lower;
    }
  );
  // Bare ranges with no meridiem at all: "9-5:30", "10-2", "1-3". Only when both
  // sides are plausible 1–12 hours (so we don't touch dates like "7-14").
  text = text.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:am|pm))/i,
    (m, h1, m1, h2, m2, offset, full) => {
      if (MONTH_BEFORE_RE.test(full.slice(0, offset))) return m; // "trip June 5-7" is a date range
      const H1 = parseInt(h1, 10), H2 = parseInt(h2, 10);
      if (H1 < 1 || H1 > 12 || H2 < 1 || H2 > 12) return m; // likely a date, leave it
      let mer1, mer2;
      if (H1 === 12 || H2 === 12) {           // noon-anchored: 12-1, 10-12
        mer1 = (H1 === 12) ? 'pm' : ((H1 >= 8 && H1 <= 11) ? 'am' : 'pm');
        mer2 = 'pm';
      } else if (H1 > H2) { mer1 = 'am'; mer2 = 'pm'; }              // 9-5 → 9am-5pm
      else { const mer = (H1 >= 8 && H1 <= 11) ? 'am' : 'pm'; mer1 = mer2 = mer; } // 8-11→am, 1-3→pm
      return h1 + (m1 ? ':' + m1 : '') + mer1 + '-' + h2 + (m2 ? ':' + m2 : '') + mer2;
    }
  );
  return text;
}
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
// chrono misses a bare day-of-month like "the 14th" / "on the 14th" (no month).
// Resolve it ourselves relative to the base day, rolling to next month if past.
function resolveOrdinalDate(text, baseStr) {
  const re = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i;
  const m = text.match(re);
  if (!m) return null;
  // If a month name sits right before the number, chrono handles it — skip.
  const before = text.slice(0, m.index).trimEnd().toLowerCase();
  if (new RegExp('(?:' + MONTH_NAMES + ')$').test(before)) return null;
  const day = parseInt(m[1], 10);
  if (day < 1 || day > 31) return null;
  const base = new Date(`${baseStr}T12:00:00`);
  let y = base.getFullYear(), mo = base.getMonth();
  if (day < base.getDate()) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
  if (day > new Date(y, mo + 1, 0).getDate()) return null; // e.g. "the 31st" of a 30-day month
  return { dateStr: ymd(new Date(y, mo, day)), span: [m.index, m.index + m[0].length] };
}
function hhmm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function hasDayComponent(comp) {
  return comp.isCertain('day') || comp.isCertain('weekday') || comp.isCertain('month');
}
function parseEventLocal(text, todayStr, defaultDateStr) {
  // Anchor to the day the user is looking at, so a bare time ("2pm") lands
  // on the selected day rather than today.
  const baseStr = defaultDateStr || todayStr;
  const refDate = new Date(`${baseStr}T12:00:00`);
  const ntext = normalizeBareRange(text);
  const results = chrono.parse(ntext, refDate, { forwardDate: true });

  // Bare day-of-month ("the 14th") that chrono can't parse on its own.
  const ordinal = resolveOrdinalDate(ntext, baseStr);

  if ((!results || results.length === 0) && !ordinal) return { confident: false };

  let dateStr = null, endDateStr = null, timeStr = null, endTimeStr = null;
  const spans = [];

  for (const r of results || []) {
    spans.push([r.index, r.index + r.text.length]);
    const s = r.start, sd = s.date();

    // First result carrying an explicit day/weekday/month sets the date.
    if (!dateStr && hasDayComponent(s)) {
      dateStr = ymd(sd);
      if (r.end && r.end.isCertain('day')) {
        const eds = ymd(r.end.date());
        if (eds !== dateStr) endDateStr = eds;
      }
    }
    // First result carrying an explicit hour sets the time
    if (!timeStr && s.isCertain('hour')) {
      timeStr = hhmm(sd);
      if (r.end && r.end.isCertain('hour')) endTimeStr = hhmm(r.end.date());
    }
  }

  // A bare ordinal ("the 14th") is only a *fallback* — it fills in the date when
  // chrono found none, but never overrides an explicit weekday/date the user gave
  // (e.g. "21st birthday party friday" must land on Friday, not the 21st).
  if (ordinal && !dateStr) { dateStr = ordinal.dateStr; spans.push(ordinal.span); }

  // Nothing concrete (no day and no time) → let the AI handle vague input
  if (!dateStr && !timeStr) return { confident: false };

  // Bare time with no explicit day → anchor to the selected/default day
  if (!dateStr) dateStr = baseStr;

  // Default a 1-hour duration when only a start time was given
  if (timeStr && !endTimeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const eh = h + 1;
    endTimeStr = eh >= 24 ? '23:59' : `${pad2(eh)}:${pad2(m)}`;
  }
  // End time earlier than start on a single day means the event crosses midnight
  // (e.g. "10pm-2am") — roll the end onto the next day instead of leaving a
  // negative-duration event.
  if (timeStr && endTimeStr && endTimeStr < timeStr && !endDateStr) {
    const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + 1);
    endDateStr = ymd(d);
  }

  // Title = input minus every matched date/time span, with dangling
  // connector words trimmed off the ends.
  let title = ntext;
  spans.sort((a, b) => b[0] - a[0]).forEach(([a, b]) => {
    title = title.slice(0, a) + ' ' + title.slice(b);
  });
  title = title.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:on|at|from|the|this|next|by|@|for)\s+/i, '')
    .replace(/\s+(?:on|at|from|by|@|for)$/i, '')
    .trim();
  title = toTitleCase(title || text.trim());

  const hasTime = !!timeStr;
  const recurrence = detectRecurrence(text);
  return {
    confident: true,
    result: { title, date: dateStr, endDate: endDateStr, time: timeStr, endTime: endTimeStr, isAllDay: !hasTime, category: detectCategory(text), recurrence, recurrenceEnd: null, isRecurring: recurrence !== 'none' }
  };
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!JWT_SECRET) {
    // Dev mode: bypass auth, single shared user
    req.user = { userId: 'dev-user', email: 'dev@local' };
    return next();
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = { userId: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Validation ──
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEventFields({ date, endDate, time, endTime }) {
  if (!date || !DATE_RE.test(date)) return 'Invalid date format (expected YYYY-MM-DD)';
  if (endDate && !DATE_RE.test(endDate)) return 'Invalid end date format';
  if (endDate && endDate < date) return 'End date must be on or after start date';
  if (time && !TIME_RE.test(time)) return 'Invalid time format (expected HH:mm)';
  if (endTime && !TIME_RE.test(endTime)) return 'Invalid end time format';
  return null;
}

// ── MongoDB ──
async function connectMongoDB() {
  if (!mongoUri) {
    console.log('⚠ No MONGODB_URI set — running without persistence');
    return;
  }
  try {
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const db = mongoClient.db('calendar');
    eventsCollection = db.collection('events');
    usersCollection = db.collection('users');
    pushSubsCollection = db.collection('push_subscriptions');
    calTokensCollection = db.collection('calendar_tokens');
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await eventsCollection.createIndex({ userId: 1 });
    await pushSubsCollection.createIndex({ userId: 1 });
    await pushSubsCollection.createIndex({ 'subscription.endpoint': 1 }, { unique: true });
    await calTokensCollection.createIndex({ token: 1 }, { unique: true });
    await calTokensCollection.createIndex({ userId: 1 }, { unique: true });
    console.log('✓ Connected to MongoDB');
  } catch (err) {
    console.error('✗ MongoDB connection failed:', err.message);
    console.log('⚠ Continuing without MongoDB persistence');
    eventsCollection = null;
    usersCollection = null;
  }
}

async function loadEvents(userId) {
  if (!eventsCollection) return [];
  try {
    const query = userId ? { userId } : {};
    return await eventsCollection.find(query).toArray();
  } catch (err) {
    console.error('Error loading events:', err.message);
    return [];
  }
}

async function saveEvent(event) {
  if (!eventsCollection) return event;
  try {
    const result = await eventsCollection.insertOne(event);
    return { ...event, _id: result.insertedId };
  } catch (err) {
    console.error('Error saving event:', err.message);
    return null;
  }
}

async function updateEvent(id, userId, updates) {
  if (!eventsCollection) return updates;
  try {
    const query = userId ? { id, userId } : { id };
    const r = await eventsCollection.updateOne(query, { $set: updates });
    // Don't report success when nothing matched (wrong id / not the owner).
    return r.matchedCount > 0 ? updates : null;
  } catch (err) {
    console.error('Error updating event:', err.message);
    return null;
  }
}

async function deleteEvent(id, userId) {
  if (!eventsCollection) return true;
  try {
    const query = userId ? { id, userId } : { id };
    const result = await eventsCollection.deleteOne(query);
    return result.deletedCount > 0;
  } catch (err) {
    console.error('Error deleting event:', err.message);
    return false;
  }
}

// ── Natural-language parser (parse only — does NOT save) ──
async function parseEvent(text, currentESTDate, currentESTTime, contextDate) {
  if (!text || text.trim().length === 0) throw new Error('Event text cannot be empty');

  const today = currentESTDate || getESTDateString();
  const defaultDate = contextDate || today;
  const modelName = 'claude-haiku-4-5-20251001';

  console.log(`📝 Parsing: "${text}" (EST: ${today} ${currentESTTime || ''}${contextDate ? `, context: ${contextDate}` : ''})`);

  const response = await client.messages.create({
    model: modelName,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a calendar event parser. The user is in EST (Eastern Standard Time).

Current EST date: ${today}
Current EST time: ${currentESTTime || 'unknown'}
${contextDate ? `Selected calendar date: ${contextDate} (use this as the date if no date is mentioned in the event text)` : ''}

Parse this event: "${text}"

Return ONLY valid JSON. No markdown, no extra text.

Extract:
1. title: Event name
2. date: Start date in YYYY-MM-DD format
3. endDate: End date in YYYY-MM-DD format for multi-day events (or null)
4. time: Start time in HH:mm 24-hour format, or null
5. endTime: End time in HH:mm format, or null
6. isAllDay: true if no specific times mentioned, false otherwise
7. category: one of "work", "health", "social", "personal", or "other"
   - "work": meetings, calls, deadlines, tasks, office, business, job, interview, conference
   - "health": doctor, dentist, medical, appointment, therapy, gym, workout, pharmacy, hospital, checkup
   - "social": dinner, lunch, breakfast, hangout, party, travel, vacation, friend, family, date, concert
   - "personal": personal errands, bills, home tasks, hobbies, self-care
   - "other": anything that doesn't fit the above

Date rules (TODAY = ${today}, DEFAULT DATE = ${defaultDate}):
- If no date is mentioned → use ${defaultDate}
- "today" → ${today}
- "tomorrow" → next day from ${today}
- "next week" → 7 days from ${today}
- Specific dates like "June 5" → 2026-06-05
- Ranges like "June 5-7" → date = 2026-06-05, endDate = 2026-06-07
- Day names → next occurring day from ${today}

Time rules:
- "noon" or "12pm" → 12:00
- "morning" → 09:00
- "afternoon" → 14:00
- "evening" → 18:00
- "6pm to 10pm" → time = 18:00, endTime = 22:00
- No time = null (all-day event)

Return ONLY this JSON:
{
  "title": "event name",
  "date": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD" or null,
  "time": "HH:mm" or null,
  "endTime": "HH:mm" or null,
  "isAllDay": true/false,
  "category": "work" | "health" | "social" | "personal" | "other"
}`
    }]
  });

  const content = response.content[0].text.trim();
  console.log('✓ Claude response:', content);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    else throw new Error('Could not extract JSON from response');
  }

  if (!parsed.title || !parsed.date) throw new Error('Missing title or date');
  if (!['work','health','social','personal','other'].includes(parsed.category)) parsed.category = 'work';
  parsed.title = toTitleCase(parsed.title.trim());
  if (!DATE_RE.test(parsed.date)) throw new Error(`Invalid date format: ${parsed.date}`);
  if (parsed.endDate && !DATE_RE.test(parsed.endDate)) parsed.endDate = null;
  if (parsed.time && !TIME_RE.test(parsed.time)) parsed.time = null;
  if (parsed.endTime && !TIME_RE.test(parsed.endTime)) parsed.endTime = null;

  if (parsed.time && !parsed.endTime) {
    const [h, m] = parsed.time.split(':').map(Number);
    let endM = m + 30, endH = h;
    if (endM >= 60) { endH++; endM -= 60; }
    if (endH >= 24) { endH = 23; endM = 59; }
    parsed.endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
  }

  console.log('✓ Parsed:', parsed);
  return parsed;
}

// ── Auth routes ──
app.post('/api/auth/register', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkAuthRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // Dev mode = no JWT secret. If a secret is set but the DB is down, fail
  // closed rather than minting a real token against no account.
  if (!JWT_SECRET) {
    return res.json({ token: 'dev-token', encryptionSalt: generateSalt() });
  }
  if (!usersCollection) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
  }

  try {
    const existing = await usersCollection.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = randomBytes(16).toString('hex');
    const encryptionSalt = generateSalt();
    const codes = Array.from({length:16}, () => randomBytes(4).toString('hex'));
    const hashedCodes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));
    const verifyOtp = generateOTP();
    const verifyOtpHash = await bcrypt.hash(verifyOtp, 10);

    await usersCollection.insertOne({
      userId,
      email: email.toLowerCase(),
      passwordHash,
      encryptionSalt,
      recoveryCodes: hashedCodes,
      emailVerified: false,
      verifyOtp: verifyOtpHash,
      verifyOtpExpiry: new Date(Date.now() + 60 * 60000),
      createdAt: new Date()
    });

    const token = jwt.sign({ sub: userId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✓ New user registered:', email.toLowerCase());
    // Send verification email (non-blocking)
    sendEmail(email.toLowerCase(), 'Verify your Marked email', verifyEmailHtml(verifyOtp)).catch(e => console.error('Verify email failed:', e.message));
    res.json({ token, encryptionSalt, userId, recoveryCodes: codes, emailVerified: false });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkAuthRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Dev mode = no JWT secret configured at all. If a secret IS set but the DB
  // is unreachable, do NOT mint a real token for an unverified password.
  if (!JWT_SECRET) {
    return res.json({ token: 'dev-token', encryptionSalt: 'dev-salt' });
  }
  if (!usersCollection) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
  }

  try {
    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ sub: user.userId, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✓ User logged in:', user.email);
    res.json({ token, encryptionSalt: user.encryptionSalt, userId: user.userId, emailVerified: user.emailVerified !== false });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Account management ──
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ userId: req.user.userId, email: req.user.email });
});

app.patch('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Generate new encryption salt so old derived keys are invalidated
    const encryptionSalt = generateSalt();
    await usersCollection.updateOne({ userId: req.user.userId }, { $set: { passwordHash, encryptionSalt, updatedAt: new Date() } });
    const token = jwt.sign({ sub: req.user.userId, email: req.user.email }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✓ Password changed:', req.user.email);
    res.json({ token, encryptionSalt, message: 'Password updated — please re-encrypt your events with the new key' });
  } catch (err) {
    console.error('Password change error:', err.message);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to delete account' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    if (eventsCollection) await eventsCollection.deleteMany({ userId: req.user.userId });
    await usersCollection.deleteOne({ userId: req.user.userId });
    console.log('✓ Account deleted:', req.user.email);
    res.json({ success: true, message: 'Account and all events permanently deleted' });
  } catch (err) {
    console.error('Account delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// POST /api/auth/forgot-password
// Generates 16 one-time recovery codes, stores hashed, returns plaintext once
// POST /api/auth/forgot-password — sends 6-digit OTP via email
app.post('/api/auth/forgot-password', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkAuthRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    // Always respond sent:true to prevent email enumeration
    if (!user) return res.json({ sent: true });
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, 10);
    await usersCollection.updateOne({ userId: user.userId }, { $set: { resetOtp: otpHash, resetOtpExpiry: new Date(Date.now() + 15 * 60000) } });
    await sendEmail(user.email, 'Reset your Marked password', resetPasswordEmailHtml(otp));
    console.log('✓ Password reset email sent:', user.email);
    res.json({ sent: true });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// POST /api/auth/reset-password — validates OTP, resets password
app.post('/api/auth/reset-password', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkAuthRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    if (!user?.resetOtp) return res.status(400).json({ error: 'No reset pending for this email' });
    if (new Date() > user.resetOtpExpiry) return res.status(400).json({ error: 'Code expired — request a new one' });
    const valid = await bcrypt.compare(code.trim(), user.resetOtp);
    if (!valid) {
      // Invalidate the OTP after too many wrong guesses so it can't be brute-forced.
      const attempts = (user.resetOtpAttempts || 0) + 1;
      if (attempts >= 5) {
        await usersCollection.updateOne({ userId: user.userId }, { $unset: { resetOtp: '', resetOtpExpiry: '', resetOtpAttempts: '' } });
        return res.status(400).json({ error: 'Too many incorrect attempts — request a new code' });
      }
      await usersCollection.updateOne({ userId: user.userId }, { $set: { resetOtpAttempts: attempts } });
      return res.status(400).json({ error: 'Incorrect code' });
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const encryptionSalt = generateSalt();
    await usersCollection.updateOne({ userId: user.userId }, { $set: { passwordHash, encryptionSalt, updatedAt: new Date() }, $unset: { resetOtp: '', resetOtpExpiry: '', resetOtpAttempts: '' } });
    const token = jwt.sign({ sub: user.userId, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✓ Password reset:', user.email);
    res.json({ token, encryptionSalt, userId: user.userId, warning: 'Events encrypted with your old password are no longer accessible' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// POST /api/auth/send-verification — (re)sends email verification OTP
app.post('/api/auth/send-verification', requireAuth, async (req, res) => {
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ alreadyVerified: true });
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, 10);
    await usersCollection.updateOne({ userId: req.user.userId }, { $set: { verifyOtp: otpHash, verifyOtpExpiry: new Date(Date.now() + 60 * 60000) } });
    await sendEmail(user.email, 'Verify your Marked email', verifyEmailHtml(otp));
    res.json({ sent: true });
  } catch (err) {
    console.error('Send verification error:', err.message);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// POST /api/auth/verify-email — validates verification OTP
app.post('/api/auth/verify-email', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ userId: req.user.userId });
    if (!user?.verifyOtp) return res.status(400).json({ error: 'No verification pending' });
    if (new Date() > user.verifyOtpExpiry) return res.status(400).json({ error: 'Code expired — resend it' });
    const valid = await bcrypt.compare(code.trim(), user.verifyOtp);
    if (!valid) return res.status(400).json({ error: 'Incorrect code' });
    await usersCollection.updateOne({ userId: req.user.userId }, { $set: { emailVerified: true }, $unset: { verifyOtp: '', verifyOtpExpiry: '' } });
    console.log('✓ Email verified:', req.user.email);
    res.json({ success: true });
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Legacy migration: claim events with no userId ──
app.post('/api/migrate/claim-legacy-events', requireAuth, async (req, res) => {
  if (!eventsCollection) return res.json({ claimed: 0 });
  try {
    const result = await eventsCollection.updateMany(
      { userId: { $exists: false } },
      { $set: { userId: req.user.userId } }
    );
    console.log(`✓ Claimed ${result.modifiedCount} legacy events for ${req.user.email}`);
    res.json({ claimed: result.modifiedCount });
  } catch (err) {
    console.error('Migration error:', err.message);
    res.status(500).json({ error: 'Migration failed' });
  }
});

// ── Parse endpoint (local-first → cache → AI fallback) ──
// Live preview — local parser only. Free, instant, never touches the AI or the
// daily quota, so it's safe to call on every keystroke (debounced client-side).
app.post('/api/events/parse-preview', requireAuth, (req, res) => {
  const { text, currentESTDate, contextDate } = req.body || {};
  if (!text || !text.trim()) return res.json({ confident: false });
  try {
    const today = currentESTDate || getESTDateString();
    const local = parseEventLocal(text, today, contextDate || today);
    return res.json(local.confident ? { confident: true, result: local.result } : { confident: false });
  } catch (e) {
    return res.json({ confident: false });
  }
});

app.post('/api/events/parse', requireAuth, async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkParseRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { text, currentESTDate, currentESTTime, contextDate } = req.body;
  if (!text) return res.status(400).json({ error: 'Event text is required' });

  const today = currentESTDate || getESTDateString();
  const defaultDate = contextDate || today;

  // 1. Local parser — free, instant, no API cost
  try {
    const local = parseEventLocal(text, today, defaultDate);
    if (local.confident) {
      console.log(`📅 Local: "${text}" → ${local.result.title} on ${local.result.date}`);
      return res.json(local.result);
    }
  } catch (e) { /* fall through to AI */ }

  // 2. Cache check
  const cached = getCachedParse(text, today, defaultDate);
  if (cached) {
    console.log(`💾 Cache: "${text}"`);
    return res.json(cached);
  }

  // 3. Per-user AI quota
  const userId = req.user?.userId;
  const isGuest = !userId || userId === 'dev-user';
  const quotaKey = isGuest ? `ip:${ip}` : `user:${userId}`;
  if (!checkParseQuota(quotaKey, isGuest)) {
    return res.status(429).json({
      error: isGuest
        ? 'Daily AI limit reached (5/day for guests). Sign in for 30/day.'
        : 'Daily AI limit reached (30/day). Resets at midnight.'
    });
  }

  // 4. AI fallback
  try {
    const parsed = await parseEvent(text, today, currentESTTime, contextDate);
    setCachedParse(text, today, defaultDate, parsed);
    res.json(parsed);
  } catch (err) {
    refundParseQuota(quotaKey); // the call failed — don't charge the credit
    console.error('✗ Parse error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to parse event' });
  }
});

// ── Event CRUD (all require auth, scoped by userId) ──
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const events = await loadEvents(req.user.userId);
    res.json(events);
  } catch (err) {
    console.error('✗ Error loading events:', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

app.post('/api/events', requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || !body.id) return res.status(400).json({ error: 'Event id is required' });

  // Accept encrypted events { id, encryptedData, nonce } or legacy plaintext
  let newEvent;
  if (body.encryptedData) {
    if (!body.nonce) return res.status(400).json({ error: 'nonce required with encryptedData' });
    newEvent = {
      id: body.id,
      userId: req.user.userId,
      encryptedData: body.encryptedData,
      nonce: body.nonce,
      category: body.category || 'work',
      date: body.date || null,
      createdAt: new Date()
    };
  } else {
    // Legacy plaintext (dev mode / no encryption)
    const { title, date, endDate, time, endTime, description, isAllDay, recurrence, recurrenceEnd, isRecurring, recurrenceExceptions, category } = body;
    if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });
    const validationError = validateEventFields({ date, endDate, time, endTime });
    if (validationError) return res.status(400).json({ error: validationError });
    newEvent = {
      id: body.id,
      userId: req.user.userId,
      title: title.trim().slice(0, 200),
      date,
      endDate: endDate || null,
      time: time || null,
      endTime: endTime || null,
      isAllDay: isAllDay || (!time && !endTime),
      description: (description || '').slice(0, 500),
      isMultiDay: !!endDate,
      recurrence: recurrence || 'none',
      recurrenceEnd: recurrenceEnd || null,
      isRecurring: isRecurring || false,
      recurrenceExceptions: recurrenceExceptions || [],
      category: category || 'work',
      createdAt: new Date()
    };
  }

  const result = await saveEvent(newEvent);
  if (result) {
    console.log('✓ Event saved:', newEvent.id);
    res.json(result);
  } else {
    res.status(500).json({ error: 'Failed to save event' });
  }
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  const eventId = req.params.id;
  const body = req.body;

  let updates;
  if (body.encryptedData) {
    if (!body.nonce) return res.status(400).json({ error: 'nonce required with encryptedData' });
    updates = {
      encryptedData: body.encryptedData,
      nonce: body.nonce,
      category: body.category || 'work',
      date: body.date || null,
      updatedAt: new Date()
    };
  } else {
    const { title, date, endDate, time, endTime, description, isAllDay, recurrence, recurrenceEnd, isRecurring, recurrenceExceptions, category } = body;
    if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });
    const validationError = validateEventFields({ date, endDate, time, endTime });
    if (validationError) return res.status(400).json({ error: validationError });
    updates = {
      title: title.trim().slice(0, 200),
      date,
      endDate: endDate || null,
      time: time || null,
      endTime: endTime || null,
      isAllDay: isAllDay || (!time && !endTime),
      description: (description || '').slice(0, 500),
      isMultiDay: !!endDate,
      recurrence: recurrence || 'none',
      recurrenceEnd: recurrenceEnd || null,
      isRecurring: isRecurring || false,
      recurrenceExceptions: recurrenceExceptions || [],
      category: category || 'work',
      updatedAt: new Date()
    };
  }

  const result = await updateEvent(eventId, req.user.userId, updates);
  if (result) {
    const events = await loadEvents(req.user.userId);
    const updated = events.find(e => e.id === eventId) || { id: eventId, ...updates };
    console.log('✓ Event updated:', eventId);
    res.json(updated);
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const success = await deleteEvent(req.params.id, req.user.userId);
  if (success) {
    console.log('✓ Event deleted:', req.params.id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

// ── Public ICS share endpoint (no auth — event ID is a UUID) ──
function addDaysStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function buildIcsLines(ev) {
  const escIcs = str => String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const safeFold = str => str.replace(/(.{73})/g, '$1\r\n ');
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0',
    'PRODID:-//Marked//Marked Calendar//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.id}@marked.app`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${safeFold(escIcs(ev.title || 'Event'))}`,
    'STATUS:CONFIRMED',
  ];
  if (ev.isAllDay || !ev.time) {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g,'')}`);
    lines.push(`DTEND;VALUE=DATE:${addDaysStr(ev.endDate || ev.date, 1).replace(/-/g,'')}`);
  } else {
    lines.push(`DTSTART;TZID=America/New_York:${ev.date.replace(/-/g,'')}T${ev.time.replace(':','')}00`);
    const endT = ev.endTime || ev.time, endD = ev.endDate || ev.date;
    lines.push(`DTEND;TZID=America/New_York:${endD.replace(/-/g,'')}T${endT.replace(':','')}00`);
  }
  if (ev.description) lines.push(`DESCRIPTION:${safeFold(escIcs(ev.description))}`);
  lines.push('END:VEVENT','END:VCALENDAR');
  return lines;
}

function srvEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime12(t) {
  if (!t) return '';
  const [h,m] = t.split(':'); const hr = parseInt(h);
  return `${hr%12||12}:${m} ${hr>=12?'PM':'AM'}`;
}

async function getShareEvent(id, res) {
  if (!eventsCollection) { res.status(503).send('Service unavailable'); return null; }
  let ev;
  try { ev = await eventsCollection.findOne({ id }); } catch { res.status(500).send('Error'); return null; }
  if (!ev || ev.encryptedData || !ev.date) { res.status(404).send('Event not found'); return null; }
  return ev;
}

// Raw .ics download (used by "Other / download" option on the landing page)
app.get('/api/events/:id/share.ics', async (req, res) => {
  if (!checkShareRateLimit(req.ip || 'unknown')) return res.status(429).send('Too many requests');
  const ev = await getShareEvent(String(req.params.id), res);
  if (!ev) return;
  const safeTitle = (ev.title||'event').replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-')||'event';
  res.setHeader('Content-Type','text/calendar;charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${safeTitle}.ics"`);
  res.setHeader('Cache-Control','no-store');
  res.send(buildIcsLines(ev).join('\r\n')+'\r\n');
});

// Calendar picker landing page
app.get('/api/events/:id/share', async (req, res) => {
  if (!checkShareRateLimit(req.ip || 'unknown')) return res.status(429).send('Too many requests');
  const ev = await getShareEvent(String(req.params.id), res);
  if (!ev) return;

  const base = `${req.protocol}://${req.get('host')}`;
  const icsUrl = `${base}/api/events/${ev.id}/share.ics`;

  // Google Calendar URL
  let gcDates;
  if (ev.isAllDay || !ev.time) {
    const s = ev.date.replace(/-/g,'');
    gcDates = `${s}/${addDaysStr(ev.endDate||ev.date, 1).replace(/-/g,'')}`;
  } else {
    const s = `${ev.date.replace(/-/g,'')}T${ev.time.replace(':','')}00`;
    const e = `${(ev.endDate||ev.date).replace(/-/g,'')}T${(ev.endTime||ev.time).replace(':','')}00`;
    gcDates = `${s}/${e}`;
  }
  const gcUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(ev.title)}`
    + `&dates=${gcDates}&ctz=America%2FNew_York`
    + (ev.description ? `&details=${encodeURIComponent(ev.description)}` : '');

  // Outlook Web URL
  const olStart = ev.isAllDay||!ev.time ? ev.date : `${ev.date}T${ev.time}:00`;
  const olEnd   = ev.isAllDay||!ev.time ? (ev.endDate||ev.date) : `${ev.endDate||ev.date}T${ev.endTime||ev.time}:00`;
  const olUrl = 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent'
    + `&subject=${encodeURIComponent(ev.title)}`
    + `&startdt=${encodeURIComponent(olStart)}&enddt=${encodeURIComponent(olEnd)}`
    + (ev.isAllDay||!ev.time ? '&allday=true' : '')
    + (ev.description ? `&body=${encodeURIComponent(ev.description)}` : '');

  // Display helpers
  const dateObj  = new Date(ev.date+'T12:00:00');
  const dispDate = dateObj.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const dispTime = (ev.isAllDay||!ev.time) ? 'All day'
    : (ev.endTime ? `${fmtTime12(ev.time)} – ${fmtTime12(ev.endTime)}` : fmtTime12(ev.time));

  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${srvEsc(ev.title)} — Add to Calendar</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0f0f14;color:#f0f0f5;min-height:100dvh;
       display:flex;flex-direction:column;align-items:center;
       justify-content:center;padding:24px 20px;
       padding-bottom:max(24px,env(safe-area-inset-bottom));}
  .card{background:#1c1c26;border:1px solid #2a2a38;border-radius:20px;
        padding:24px 20px;width:100%;max-width:400px;box-shadow:0 8px 40px rgba(0,0,0,.5)}
  .logo{font-size:13px;font-weight:700;letter-spacing:.06em;color:#4a9d6f;
        text-transform:uppercase;margin-bottom:20px;text-align:center}
  .ev-title{font-size:22px;font-weight:700;line-height:1.2;margin-bottom:10px}
  .ev-meta{font-size:14px;color:#9898b0;line-height:1.6}
  .ev-desc{font-size:13px;color:#7878a0;margin-top:10px;line-height:1.5;
           border-top:1px solid #2a2a38;padding-top:10px}
  .divider{font-size:11px;font-weight:600;color:#5a5a78;text-transform:uppercase;
           letter-spacing:.08em;text-align:center;margin:22px 0 14px}
  .cal-btn{display:flex;align-items:center;gap:14px;width:100%;
           background:#242432;border:1px solid #2e2e42;border-radius:14px;
           padding:14px 16px;margin-bottom:10px;cursor:pointer;
           text-decoration:none;color:inherit;transition:background .15s,transform .1s}
  .cal-btn:active{background:#2e2e42;transform:scale(.98)}
  .cal-icon{width:40px;height:40px;border-radius:10px;flex-shrink:0;
            display:flex;align-items:center;justify-content:center;font-size:22px}
  .cal-icon.apple {background:linear-gradient(145deg,#1c1c1e,#2c2c2e)}
  .cal-icon.google{background:#fff}
  .cal-icon.outlook{background:#0078d4}
  .cal-label{display:flex;flex-direction:column}
  .cal-name{font-size:15px;font-weight:600}
  .cal-hint{font-size:12px;color:#7878a0;margin-top:1px}
  .other{display:block;text-align:center;font-size:13px;color:#6868a0;
         margin-top:6px;padding:10px;text-decoration:none}
  .other:hover{color:#9898c0}
  /* Google logo SVG colours */
  .g-blue{fill:#4285F4}.g-red{fill:#EA4335}.g-yellow{fill:#FBBC05}.g-green{fill:#34A853}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Marked</div>
  <div class="ev-title">${srvEsc(ev.title)}</div>
  <div class="ev-meta">
    📅 ${srvEsc(dispDate)}<br>
    🕐 ${srvEsc(dispTime)}
  </div>
  ${ev.description ? `<div class="ev-desc">${srvEsc(ev.description)}</div>` : ''}

  <div class="divider">Add to your calendar</div>

  <!-- Apple Calendar -->
  <a class="cal-btn" href="${srvEsc(icsUrl)}">
    <div class="cal-icon apple">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <rect width="26" height="26" rx="6" fill="#1c1c1e"/>
        <text x="13" y="9" text-anchor="middle" font-size="6" font-weight="700" fill="#ff453a" font-family="-apple-system,sans-serif">
          ${dateObj.toLocaleDateString('en-US',{month:'short'}).toUpperCase()}
        </text>
        <text x="13" y="21" text-anchor="middle" font-size="12" font-weight="700" fill="white" font-family="-apple-system,sans-serif">
          ${dateObj.getDate()}
        </text>
      </svg>
    </div>
    <div class="cal-label">
      <span class="cal-name">Apple Calendar</span>
      <span class="cal-hint">iPhone, iPad, Mac</span>
    </div>
  </a>

  <!-- Google Calendar -->
  <a class="cal-btn" href="${srvEsc(gcUrl)}" target="_blank" rel="noopener">
    <div class="cal-icon google">
      <svg width="22" height="22" viewBox="0 0 48 48">
        <path class="g-blue" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/>
        <path class="g-red" d="M6.3 14.7l7 5.1C15.1 16.1 19.2 13 24 13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 16.3 2 9.7 7.4 6.3 14.7z"/>
        <path class="g-yellow" d="M24 46c5.5 0 10.5-1.9 14.3-5.1l-6.6-5.6C29.7 36.8 27 37.8 24 37.8c-6 0-10.6-3.1-11.7-8.4l-7 5.4C8.7 41.7 15.8 46 24 46z"/>
        <path class="g-green" d="M44.5 20H24v8.5h11.8c-.8 2.6-2.7 4.8-5.2 6.2l6.6 5.6C41.3 37.4 44.5 31.2 44.5 24c0-1.3-.2-2.7-.5-4z"/>
      </svg>
    </div>
    <div class="cal-label">
      <span class="cal-name">Google Calendar</span>
      <span class="cal-hint">Opens in browser</span>
    </div>
  </a>

  <!-- Outlook -->
  <a class="cal-btn" href="${srvEsc(olUrl)}" target="_blank" rel="noopener">
    <div class="cal-icon outlook">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
        <path d="M14 2v8h8l-8-8zm-2 0H5a1 1 0 00-1 1v18a1 1 0 001 1h14a1 1 0 001-1v-9h-8V2zm-2 15H6v-1.5h4V17zm4 0h-2.5v-1.5H14V17zm-8-4V11.5h4V13H6zm4 0V11.5h2.5V13H10z"/>
      </svg>
    </div>
    <div class="cal-label">
      <span class="cal-name">Outlook</span>
      <span class="cal-hint">Outlook.com or Microsoft 365</span>
    </div>
  </a>

  <a class="other" href="${srvEsc(icsUrl)}" download="${srvEsc((ev.title||'event').replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-')||'event')}.ics">
    ↓ Download .ics (any other calendar)
  </a>
</div>
</body>
</html>`);
});

// ── Push notification routes ──
app.get('/api/push/vapid-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  if (!pushSubsCollection) return res.json({ ok: true });
  const { subscription, preferences } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    await pushSubsCollection.updateOne(
      { 'subscription.endpoint': subscription.endpoint },
      { $set: { userId: req.user.userId, subscription, preferences: preferences || { dayOf: true, hourBefore: false }, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Push subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
  if (!pushSubsCollection) return res.json({ ok: true });
  const { endpoint } = req.body;
  try {
    if (endpoint) await pushSubsCollection.deleteOne({ 'subscription.endpoint': endpoint });
    else await pushSubsCollection.deleteMany({ userId: req.user.userId });
    res.json({ ok: true });
  } catch (err) {
    console.error('Push unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// ── Static legal pages ──
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — Marked</title><style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#1a1a2e;line-height:1.7}h1{color:#4a9d6f}h2{margin-top:32px}a{color:#4a9d6f}</style></head><body>
<h1>Marked Privacy Policy</h1><p><em>Last updated: ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</em></p>
<h2>What We Collect</h2><p>Marked collects your email address and calendar event data (titles, dates, times). All event data is end-to-end encrypted before leaving your device — we cannot read your events.</p>
<h2>How We Use It</h2><p>Your email is used solely for account authentication. Your encrypted event data is stored on our servers to enable sync across devices.</p>
<h2>Data Storage</h2><p>Data is stored in MongoDB Atlas (cloud). Encryption keys are derived from your password on-device using PBKDF2 and are never transmitted to our servers.</p>
<h2>Third Parties</h2><p>We use the Anthropic Claude API to parse natural-language event descriptions. Text you type in the event input is sent to Anthropic for parsing. No personal identifying information is included.</p>
<h2>Data Deletion</h2><p>You can permanently delete your account and all associated data at any time from Settings → Delete Account.</p>
<h2>Contact</h2><p>Questions? Email us at <a href="mailto:jdefrancesco2003@gmail.com">jdefrancesco2003@gmail.com</a></p>
</body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service — Marked</title><style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#1a1a2e;line-height:1.7}h1{color:#4a9d6f}h2{margin-top:32px}a{color:#4a9d6f}</style></head><body>
<h1>Marked Terms of Service</h1><p><em>Last updated: ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</em></p>
<h2>Acceptance</h2><p>By using Marked you agree to these terms. Marked is provided as-is for personal productivity use.</p>
<h2>Account Responsibility</h2><p>You are responsible for keeping your password and recovery codes safe. We cannot recover encrypted data if you lose your password and recovery codes.</p>
<h2>Prohibited Use</h2><p>Do not use Marked to store illegal content or to abuse the AI parsing service.</p>
<h2>Service Availability</h2><p>We aim for high availability but do not guarantee 100% uptime. Always export your calendar (.ics) as a backup.</p>
<h2>Termination</h2><p>You may delete your account at any time. We may suspend accounts that violate these terms.</p>
<h2>Contact</h2><p>Questions? Email <a href="mailto:jdefrancesco2003@gmail.com">jdefrancesco2003@gmail.com</a></p>
</body></html>`);
});

// ── Health ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    version: '3.0.0',
    model: 'claude-haiku-4-5-20251001',
    timezone: EST_TIMEZONE,
    mongodb: !!eventsCollection,
    auth: !!JWT_SECRET
  });
});

function toTitleCase(str) {
  const minors = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is','with']);
  return str.replace(/\w\S*/g, (word, idx) => {
    const lower = word.toLowerCase();
    return (idx === 0 || !minors.has(lower)) ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : lower;
  });
}

function fmt12(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${suffix}`;
}

// ── Full-calendar ICS builder (for subscription feed) ──
function buildSubscriptionIcs(events) {
  const escIcs = str => String(str||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
  const safeFold = str => str.replace(/(.{73})/g,'$1\r\n ');
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0',
    'PRODID:-//Marked//Marked Calendar//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'X-WR-CALNAME:Marked','X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'BEGIN:VTIMEZONE','TZID:America/New_York',
    'BEGIN:DAYLIGHT','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','TZNAME:EDT',
    'DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT',
    'BEGIN:STANDARD','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','TZNAME:EST',
    'DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const ev of events) {
    if (!ev.date || ev.encryptedData) continue;
    lines.push('BEGIN:VEVENT',
      `UID:${ev.id}@marked.app`,`DTSTAMP:${stamp}`,
      `SUMMARY:${safeFold(escIcs(ev.title||'Event'))}`,
      'STATUS:CONFIRMED'
    );
    if (ev.isAllDay || !ev.time) {
      lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g,'')}`,
        `DTEND;VALUE=DATE:${addDaysStr(ev.endDate||ev.date,1).replace(/-/g,'')}`);
    } else {
      const endD = ev.endDate || ev.date;
      let endT = ev.endTime;
      if (!endT) {
        const [eh,em] = ev.time.split(':').map(Number), em2 = eh*60+em+30;
        endT = `${String(Math.floor(em2/60)).padStart(2,'0')}:${String(em2%60).padStart(2,'0')}`;
      }
      lines.push(
        `DTSTART;TZID=America/New_York:${ev.date.replace(/-/g,'')}T${ev.time.replace(':','')}00`,
        `DTEND;TZID=America/New_York:${endD.replace(/-/g,'')}T${endT.replace(':','')}00`
      );
    }
    if (ev.description) lines.push(`DESCRIPTION:${safeFold(escIcs(ev.description))}`);
    if (ev.recurrence && ev.recurrence !== 'none') {
      const freqMap = { daily:'DAILY', weekly:'WEEKLY', biweekly:'WEEKLY;INTERVAL=2', monthly:'MONTHLY', yearly:'YEARLY' };
      const freq = freqMap[ev.recurrence];
      if (freq) {
        const parts = freq.split(';');
        let rrule = `RRULE:FREQ=${parts[0]}`;
        if (parts[1]) rrule += `;${parts[1]}`;
        if (ev.recurrenceEnd) rrule += `;UNTIL=${ev.recurrenceEnd.replace(/-/g,'')}T235959Z`;
        lines.push(rrule);
      }
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n')+'\r\n';
}

// ── Calendar subscription token (used for CarPlay / iOS Calendar) ──
app.get('/api/cal/token', requireAuth, async (req, res) => {
  if (!calTokensCollection) return res.status(503).json({ error: 'Not available without MongoDB' });
  const userId = req.user.userId;
  try {
    let doc = await calTokensCollection.findOne({ userId });
    if (!doc) {
      const { randomBytes } = require('crypto');
      const token = randomBytes(24).toString('hex');
      // Upsert so two concurrent first-requests can't both insert on the unique
      // userId index and crash with a duplicate-key error.
      await calTokensCollection.updateOne(
        { userId },
        { $setOnInsert: { userId, token, createdAt: new Date() } },
        { upsert: true }
      );
      doc = await calTokensCollection.findOne({ userId });
    }
    res.json({ token: doc.token });
  } catch (err) {
    console.error('Cal token error:', err.message);
    res.status(500).json({ error: 'Failed to get calendar token' });
  }
});

app.get('/api/cal/:token/events.ics', async (req, res) => {
  if (!calTokensCollection || !eventsCollection) return res.status(503).send('Not available');
  try {
    const doc = await calTokensCollection.findOne({ token: String(req.params.token) });
    if (!doc) return res.status(404).send('Calendar not found');
    const events = await eventsCollection.find({ userId: doc.userId }).toArray();
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="marked.ics"');
    res.setHeader('Cache-Control', 'max-age=3600');
    res.send(buildSubscriptionIcs(events));
  } catch (err) {
    console.error('Cal feed error:', err.message);
    res.status(500).send('Failed to build calendar');
  }
});

async function startServer() {
  await connectMongoDB();

  // ── Push notification scheduler (runs every minute) ──
  // sentNotifKeys deduplicates within a day — reset whenever the EST date rolls.
  const sentNotifKeys = new Set();
  let lastNotifDate = null;

  setInterval(async () => {
    if (!pushSubsCollection || !eventsCollection || !process.env.VAPID_PUBLIC_KEY) return;
    const now = new Date();
    const estNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const p = Object.fromEntries(estNow.map(x => [x.type, x.value]));
    const estDateStr = `${p.year}-${p.month}-${p.day}`;
    const estHour = parseInt(p.hour, 10);
    const estMin = parseInt(p.minute, 10);
    const estMins = estHour * 60 + estMin;

    // Reset dedup set whenever the date changes — robust even if the exact
    // midnight tick is skipped (avoids the set growing unbounded across days).
    if (estDateStr !== lastNotifDate) { sentNotifKeys.clear(); lastNotifDate = estDateStr; }

    try {
      const subs = await pushSubsCollection.find({}).toArray();
      for (const sub of subs) {
        const prefs = sub.preferences || { dayOf: true, hourBefore: true };
        const events = await eventsCollection.find({ userId: sub.userId, date: estDateStr }).toArray();
        for (const event of events) {
          if (event.encryptedData) continue;
          let body = null, tag = null;
          if (event.time) {
            const [eh, em] = event.time.split(':').map(Number);
            const evMins = eh * 60 + em;
            if (prefs.dayOf && estMins >= 6 * 60 && estMins <= 6 * 60 + 1) {
              // Morning reminder ~6 AM (±1 min window so a skipped tick still fires)
              body = `${event.title} today at ${fmt12(event.time)}`;
              tag = `${event.id}-morning-${estDateStr}`;
            } else if (prefs.hourBefore && Math.abs(estMins - (evMins - 60)) <= 1) {
              // 1-hour-before reminder (±1 min window handles scheduler drift)
              body = `${event.title} starts in 1 hour — ${fmt12(event.time)}`;
              tag = `${event.id}-1hr-${estDateStr}`;
            }
          } else if (event.isAllDay && prefs.dayOf && estMins === 6 * 60) {
            body = `All day today: ${event.title}`;
            tag = `${event.id}-morning-${estDateStr}`;
          }
          if (!body || !tag) continue;

          // Dedup: only send each tag once per day (survives multiple scheduler ticks)
          const dedupeKey = `${sub.userId}-${tag}`;
          if (sentNotifKeys.has(dedupeKey)) continue;

          try {
            await webpush.sendNotification(sub.subscription, JSON.stringify({
              title: 'Marked', body, tag,
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
            }));
            sentNotifKeys.add(dedupeKey);
          } catch (e) {
            if (e.statusCode === 410 || e.statusCode === 404) await pushSubsCollection.deleteOne({ _id: sub._id });
          }
        }
      }
    } catch (e) { /* scheduler errors don't crash server */ }
  }, 60000);

  app.listen(PORT, () => {
    console.log(`✓ Calendar API running on port ${PORT}`);
    console.log(`✓ Model: claude-haiku-4-5-20251001`);
    console.log(`✓ Timezone: EST (${EST_TIMEZONE})`);
    console.log(`✓ Auth: ${JWT_SECRET ? 'enabled (JWT)' : 'dev mode (no auth)'}`);
    console.log(`✓ MongoDB: ${eventsCollection ? 'connected' : 'not connected (local storage fallback)'}`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down...');
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

startServer();
