const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');

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
function generateSalt() { return randomBytes(16).toString('hex'); }

const client = new Anthropic();
const mongoUri = process.env.MONGODB_URI;
let eventsCollection;
let usersCollection;
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
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await eventsCollection.createIndex({ userId: 1 });
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

    await usersCollection.insertOne({
      userId,
      email: email.toLowerCase(),
      passwordHash,
      encryptionSalt,
      createdAt: new Date()
    });

    const token = jwt.sign({ sub: userId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✓ New user registered:', email.toLowerCase());
    res.json({ token, encryptionSalt, userId });
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
    res.json({ token, encryptionSalt: user.encryptionSalt, userId: user.userId });
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

// ── Diagnostic ──
app.post('/api/test-parse', async (req, res) => {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "API works" in one word' }]
    });
    res.json({ status: 'ok', message: response.content[0].text, apiKeyExists: !!process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    res.status(400).json({ status: 'error', error: err.message, apiKeyExists: !!process.env.ANTHROPIC_API_KEY });
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
    const { title, date, endDate, time, endTime, description, isAllDay } = body;
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
    const { title, date, endDate, time, endTime, description, isAllDay } = body;
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

// ── Sync endpoints ──
app.get('/api/sync/download', requireAuth, async (req, res) => {
  try {
    const events = await loadEvents(req.user.userId);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Sync download failed' });
  }
});

app.post('/api/sync/upload', requireAuth, async (req, res) => {
  const { id, encryptedData, nonce } = req.body;
  if (!encryptedData || !nonce) return res.status(400).json({ error: 'encryptedData and nonce required' });

  const event = {
    id: id || randomBytes(8).toString('hex'),
    userId: req.user.userId,
    encryptedData,
    nonce,
    updatedAt: new Date()
  };

  if (eventsCollection) {
    await eventsCollection.updateOne(
      { id: event.id, userId: req.user.userId },
      { $set: event, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }

  res.json(event);
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

async function startServer() {
  await connectMongoDB();
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
