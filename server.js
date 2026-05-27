const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const webpush = require('web-push');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ── Email (Nodemailer) ──
const emailTransport = (process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;
const EMAIL_FROM = process.env.EMAIL_FROM || (process.env.SMTP_USER ? `Marked <${process.env.SMTP_USER}>` : null);

async function sendEmail(to, subject, html) {
  if (!emailTransport) { console.log(`[DEV EMAIL] To:${to} | ${subject}`); return; }
  await emailTransport.sendMail({ from: EMAIL_FROM, to, subject, html });
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
const checkParseRateLimit = makeRateLimiter(20, 60000);   // 20/min for parse
const checkAuthRateLimit  = makeRateLimiter(5,  900000);  // 5 attempts/15 min for auth

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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
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
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await eventsCollection.createIndex({ userId: 1 });
    await pushSubsCollection.createIndex({ userId: 1 });
    await pushSubsCollection.createIndex({ 'subscription.endpoint': 1 }, { unique: true });
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
    await eventsCollection.updateOne(query, { $set: updates });
    return updates;
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
async function parseEvent(text, currentESTDate, currentESTTime) {
  if (!text || text.trim().length === 0) throw new Error('Event text cannot be empty');

  const today = currentESTDate || getESTDateString();
  const modelName = 'claude-haiku-4-5-20251001';

  console.log(`📝 Parsing: "${text}" (EST: ${today} ${currentESTTime || ''})`);

  const response = await client.messages.create({
    model: modelName,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a calendar event parser. The user is in EST (Eastern Standard Time).

Current EST date: ${today}
Current EST time: ${currentESTTime || 'unknown'}

Parse this event: "${text}"

Return ONLY valid JSON. No markdown, no extra text.

Extract:
1. title: Event name
2. date: Start date in YYYY-MM-DD format
3. endDate: End date in YYYY-MM-DD format for multi-day events (or null)
4. time: Start time in HH:mm 24-hour format, or null
5. endTime: End time in HH:mm format, or null
6. isAllDay: true if no specific times mentioned, false otherwise

Date rules (TODAY = ${today}):
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
  "isAllDay": true/false
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

  // Dev mode: no real DB, return token immediately
  if (!usersCollection || !JWT_SECRET) {
    const salt = generateSalt();
    const token = JWT_SECRET ? jwt.sign({ sub: 'dev-user', email }, JWT_SECRET, { expiresIn: '30d' }) : 'dev-token';
    return res.json({ token, encryptionSalt: salt });
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

  // Dev mode
  if (!usersCollection || !JWT_SECRET) {
    const token = JWT_SECRET ? jwt.sign({ sub: 'dev-user', email }, JWT_SECRET, { expiresIn: '30d' }) : 'dev-token';
    return res.json({ token, encryptionSalt: 'dev-salt' });
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
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!usersCollection || !JWT_SECRET) return res.status(400).json({ error: 'Not available in dev mode' });
  try {
    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    if (!user?.resetOtp) return res.status(400).json({ error: 'No reset pending for this email' });
    if (new Date() > user.resetOtpExpiry) return res.status(400).json({ error: 'Code expired — request a new one' });
    const valid = await bcrypt.compare(code.trim(), user.resetOtp);
    if (!valid) return res.status(400).json({ error: 'Incorrect code' });
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const encryptionSalt = generateSalt();
    await usersCollection.updateOne({ userId: user.userId }, { $set: { passwordHash, encryptionSalt, updatedAt: new Date() }, $unset: { resetOtp: '', resetOtpExpiry: '' } });
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

// ── Parse endpoint (parse only — client saves after confirmation) ──
app.post('/api/events/parse', requireAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkParseRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many parse requests. Please wait a minute.' });
  }

  const { text, currentESTDate, currentESTTime } = req.body;
  if (!text) return res.status(400).json({ error: 'Event text is required' });

  try {
    const parsed = await parseEvent(text, currentESTDate, currentESTTime);
    // Return parsed data only — client is responsible for encrypting and saving
    res.json(parsed);
  } catch (err) {
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
app.get('/api/events/:id/share.ics', async (req, res) => {
  const { id } = req.params;
  if (!eventsCollection) return res.status(503).send('Service unavailable');

  let ev;
  try {
    ev = await eventsCollection.findOne({ id });
  } catch (err) {
    return res.status(500).send('Error');
  }
  if (!ev) return res.status(404).send('Event not found');

  // Skip encrypted events — they can't be shared meaningfully
  if (ev.encryptedData) return res.status(403).send('This event is encrypted and cannot be shared');

  const safeFold = str => str.replace(/(.{73})/g, '$1\r\n ');
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marked//Marked Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.id}@marked.app`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${safeFold(ev.title || 'Event')}`,
    'STATUS:CONFIRMED',
  ];

  if (ev.isAllDay || !ev.time) {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g,'')}`);
    const d = new Date((ev.endDate || ev.date) + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    lines.push(`DTEND;VALUE=DATE:${d.toISOString().slice(0,10).replace(/-/g,'')}`);
  } else {
    lines.push(`DTSTART;TZID=America/New_York:${ev.date.replace(/-/g,'')}T${ev.time.replace(':','')}00`);
    const endT = ev.endTime || ev.time, endD = ev.endDate || ev.date;
    lines.push(`DTEND;TZID=America/New_York:${endD.replace(/-/g,'')}T${endT.replace(':','')}00`);
  }

  if (ev.description) lines.push(`DESCRIPTION:${safeFold(ev.description.replace(/\n/g,'\\n'))}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  const safeTitle = (ev.title || 'event').replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-') || 'event';
  res.setHeader('Content-Type', 'text/calendar;charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.ics"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n') + '\r\n');
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
  await pushSubsCollection.updateOne(
    { 'subscription.endpoint': subscription.endpoint },
    { $set: { userId: req.user.userId, subscription, preferences: preferences || { dayOf: true, hourBefore: false }, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});

app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
  if (!pushSubsCollection) return res.json({ ok: true });
  const { endpoint } = req.body;
  if (endpoint) await pushSubsCollection.deleteOne({ 'subscription.endpoint': endpoint });
  else await pushSubsCollection.deleteMany({ userId: req.user.userId });
  res.json({ ok: true });
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

async function startServer() {
  await connectMongoDB();

  // ── Push notification scheduler (runs every minute) ──
  setInterval(async () => {
    if (!pushSubsCollection || !eventsCollection || !process.env.VAPID_PUBLIC_KEY) return;
    const now = new Date();
    const estNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const p = Object.fromEntries(estNow.map(x => [x.type, x.value]));
    const estDateStr = `${p.year}-${p.month}-${p.day}`;
    const estHour = parseInt(p.hour, 10);
    const estMin = parseInt(p.minute, 10);
    const estMins = estHour * 60 + estMin;
    try {
      const subs = await pushSubsCollection.find({}).toArray();
      for (const sub of subs) {
        const prefs = sub.preferences || { dayOf: true, hourBefore: false };
        const events = await eventsCollection.find({ userId: sub.userId, date: estDateStr }).toArray();
        for (const event of events) {
          if (event.encryptedData) continue; // can't read encrypted titles
          let body = null;
          if (event.time) {
            const [eh, em] = event.time.split(':').map(Number);
            const evMins = eh * 60 + em;
            if (prefs.dayOf && estMins === 8 * 60) body = `${event.title} at ${fmt12(event.time)} today`;
            else if (prefs.hourBefore && Math.abs(estMins - (evMins - 60)) <= 1) body = `${event.title} in 1 hour`;
          } else if (event.isAllDay && prefs.dayOf && estMins === 8 * 60) {
            body = `All day: ${event.title}`;
          }
          if (!body) continue;
          try {
            await webpush.sendNotification(sub.subscription, JSON.stringify({ title: 'Marked', body, tag: `${event.id}-${estMins}` }));
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
