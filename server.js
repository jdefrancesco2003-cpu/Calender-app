const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient } = require('mongodb');

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

const client = new Anthropic();
const mongoUri = process.env.MONGODB_URI;
let eventsCollection;
let mongoClient;

// Simple in-process rate limiter for the parse endpoint
const parseRateLimit = new Map();
function checkParseRateLimit(ip) {
  const now = Date.now();
  const entry = parseRateLimit.get(ip);
  if (!entry || now > entry.expiresAt) {
    parseRateLimit.set(ip, { count: 1, expiresAt: now + 60000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}
// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of parseRateLimit) {
    if (now > entry.expiresAt) parseRateLimit.delete(ip);
  }
}, 300000);

// Date/time format validation
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
function validateEventFields({ date, endDate, time, endTime }) {
  if (!date || !DATE_RE.test(date)) return 'Invalid date format (expected YYYY-MM-DD)';
  if (endDate && !DATE_RE.test(endDate)) return 'Invalid end date format';
  if (time && !TIME_RE.test(time)) return 'Invalid time format (expected HH:mm)';
  if (endTime && !TIME_RE.test(endTime)) return 'Invalid end time format';
  return null;
}

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
    console.log('✓ Connected to MongoDB');
  } catch (err) {
    console.error('✗ MongoDB connection failed:', err.message);
    console.log('⚠ Continuing without MongoDB persistence');
    eventsCollection = null;
  }
}

async function loadEvents() {
  if (!eventsCollection) return [];
  try {
    return await eventsCollection.find({}).toArray();
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

async function updateEvent(id, updates) {
  if (!eventsCollection) return updates;
  try {
    await eventsCollection.updateOne({ id }, { $set: updates });
    return updates;
  } catch (err) {
    console.error('Error updating event:', err.message);
    return null;
  }
}

async function deleteEvent(id) {
  if (!eventsCollection) return true;
  try {
    const result = await eventsCollection.deleteOne({ id });
    return result.deletedCount > 0;
  } catch (err) {
    console.error('Error deleting event:', err.message);
    return false;
  }
}

function getFormattedDate() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

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

  // Add 30-minute default duration when only start time given
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

// Diagnostic endpoint
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

app.post('/api/events/parse', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkParseRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many parse requests. Please wait a minute.' });
  }

  const { text, currentESTDate, currentESTTime } = req.body;
  if (!text) return res.status(400).json({ error: 'Event text is required' });

  try {
    const parsed = await parseEvent(text, currentESTDate, currentESTTime);
    const newEvent = {
      id: Date.now().toString(),
      title: parsed.title,
      date: parsed.date,
      endDate: parsed.endDate || null,
      time: parsed.time || null,
      endTime: parsed.endTime || null,
      isAllDay: parsed.isAllDay || (parsed.time === null && parsed.endTime === null),
      description: '',
      isMultiDay: !!parsed.endDate,
      createdAt: new Date()
    };
    await saveEvent(newEvent);
    console.log('✓ Event saved:', newEvent);
    res.json(newEvent);
  } catch (err) {
    console.error('✗ Parse error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to parse event' });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (err) {
    console.error('✗ Error loading events:', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, date, endDate, time, endTime, description, isAllDay } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  const validationError = validateEventFields({ date, endDate, time, endTime });
  if (validationError) return res.status(400).json({ error: validationError });

  const newEvent = {
    id: Date.now().toString(),
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

  const result = await saveEvent(newEvent);
  if (result) {
    console.log('✓ Event created:', newEvent.title);
    res.json(result);
  } else {
    res.status(500).json({ error: 'Failed to save event' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { title, date, endDate, time, endTime, description, isAllDay } = req.body;
  const eventId = req.params.id;

  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  const validationError = validateEventFields({ date, endDate, time, endTime });
  if (validationError) return res.status(400).json({ error: validationError });

  const updates = {
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

  const result = await updateEvent(eventId, updates);
  if (result) {
    const events = await loadEvents();
    const updated = events.find(e => e.id === eventId) || { id: eventId, ...updates };
    console.log('✓ Event updated:', updated.title);
    res.json(updated);
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const success = await deleteEvent(req.params.id);
  if (success) {
    console.log('✓ Event deleted:', req.params.id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    version: '2.1.0',
    model: 'claude-haiku-4-5-20251001',
    timezone: EST_TIMEZONE,
    mongodb: !!eventsCollection
  });
});

async function startServer() {
  await connectMongoDB();
  app.listen(PORT, () => {
    console.log(`✓ Calendar API running on port ${PORT}`);
    console.log(`✓ Model: claude-haiku-4-5-20251001`);
    console.log(`✓ Timezone: EST (${EST_TIMEZONE})`);
    console.log(`✓ MongoDB: ${eventsCollection ? 'connected' : 'not connected (local storage fallback)'}`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down...');
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

startServer();
