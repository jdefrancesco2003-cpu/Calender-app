const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();
const mongoUri = process.env.MONGODB_URI;
let eventsCollection;
let mongoClient;

async function connectMongoDB() {
  try {
    mongoClient = new MongoClient(mongoUri, { useUnifiedTopology: true });
    await mongoClient.connect();
    const db = mongoClient.db('calendar');
    eventsCollection = db.collection('events');
    console.log('✓ Connected to MongoDB');
    return mongoClient;
  } catch (err) {
    console.error('✗ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

async function loadEvents() {
  if (!eventsCollection) return [];
  try {
    const events = await eventsCollection.find({}).toArray();
    return events;
  } catch (err) {
    console.error('Error loading events:', err.message);
    return [];
  }
}

async function saveEvent(event) {
  if (!eventsCollection) return null;
  try {
    const result = await eventsCollection.insertOne(event);
    return { ...event, _id: result.insertedId };
  } catch (err) {
    console.error('Error saving event:', err.message);
    return null;
  }
}

async function updateEvent(id, updates) {
  if (!eventsCollection) return null;
  try {
    await eventsCollection.updateOne({ id }, { $set: updates });
    return updates;
  } catch (err) {
    console.error('Error updating event:', err.message);
    return null;
  }
}

async function deleteEvent(id) {
  if (!eventsCollection) return false;
  try {
    const result = await eventsCollection.deleteOne({ id });
    return result.deletedCount > 0;
  } catch (err) {
    console.error('Error deleting event:', err.message);
    return false;
  }
}

function getTodayString() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString().split('T')[0];
}

function getTomorrowString() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString().split('T')[0];
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

async function parseEvent(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Event text cannot be empty');
  }

  const today = getTodayString();
  const tomorrow = getTomorrowString();
  const formattedToday = getFormattedDate();
  const modelName = 'claude-opus-4-1-20250805';

  try {
    console.log(`📝 Parsing event: "${text}"`);
    
    const response = await client.messages.create({
      model: modelName,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a calendar event parser. Today is ${formattedToday} (${today}). Parse this event: "${text}"

Return ONLY valid JSON. No markdown, no extra text.

Extract:
1. title: Event name
2. date: Start date in YYYY-MM-DD format
3. endDate: End date in YYYY-MM-DD format for multi-day events (or null)
4. time: Start time in HH:mm 24-hour format, or null
5. endTime: End time in HH:mm format, or null
6. isAllDay: true if no specific times mentioned, false otherwise

Date rules (TODAY = ${today}, TOMORROW = ${tomorrow}):
- "today" → ${today}
- "tomorrow" → ${tomorrow}
- "next week" → 7 days from today
- Specific dates like "June 5" → 2026-06-05
- Ranges like "June 5-7" → date = 2026-06-05, endDate = 2026-06-07
- Day names → next occurring day
- For ranges → date = start, endDate = end

Time rules:
- "noon" or "12pm" → 12:00
- "morning" → 09:00
- "afternoon" → 14:00
- "evening" → 18:00
- Specific times → exact (6pm = 18:00)
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
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not extract JSON');
      }
    }

    if (!parsed.title || !parsed.date) {
      throw new Error('Missing title or date');
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(parsed.date)) {
      throw new Error(`Invalid date format: ${parsed.date}`);
    }

    if (parsed.endDate && !dateRegex.test(parsed.endDate)) {
      parsed.endDate = null;
    }

    if (parsed.time) {
      const timeRegex = /^\d{2}:\d{2}$/;
      if (!timeRegex.test(parsed.time)) {
        parsed.time = null;
      }
    }

    if (parsed.endTime) {
      const timeRegex = /^\d{2}:\d{2}$/;
      if (!timeRegex.test(parsed.endTime)) {
        parsed.endTime = null;
      }
    }

    console.log('✓ Event parsed successfully:', parsed);
    return parsed;
  } catch (err) {
    console.error('✗ Parse error:', err.message);
    throw err;
  }
}

app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Event text is required' });
  }

  try {
    const parsed = await parseEvent(text);
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
    console.log('✓ Loaded', events.length, 'events');
    res.json(events);
  } catch (err) {
    console.error('✗ Error loading events:', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, date, endDate, time, endTime, description, isAllDay } = req.body;
  
  if (!title || !date) {
    return res.status(400).json({ error: 'Title and date are required' });
  }

  const newEvent = {
    id: Date.now().toString(),
    title: title.trim(),
    date,
    endDate: endDate || null,
    time: time || null,
    endTime: endTime || null,
    isAllDay: isAllDay || (time === null && endTime === null),
    description: description || '',
    isMultiDay: !!endDate,
    createdAt: new Date()
  };
  
  const result = await saveEvent(newEvent);
  if (result) {
    console.log('✓ Event created:', newEvent);
    res.json(result);
  } else {
    res.status(500).json({ error: 'Failed to save event' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { title, date, endDate, time, endTime, description, isAllDay } = req.body;
  const eventId = req.params.id;

  if (!title || !date) {
    return res.status(400).json({ error: 'Title and date are required' });
  }

  const updates = {
    title: title.trim(),
    date,
    endDate: endDate || null,
    time: time || null,
    endTime: endTime || null,
    isAllDay: isAllDay || (time === null && endTime === null),
    description: description || '',
    isMultiDay: !!endDate,
    updatedAt: new Date()
  };

  await updateEvent(eventId, updates);
  const events = await loadEvents();
  const updated = events.find(e => e.id === eventId);
  
  if (updated) {
    console.log('✓ Event updated:', updated);
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
  res.json({ status: 'ok', timestamp: new Date() });
});

async function startServer() {
  try {
    await connectMongoDB();
    app.listen(PORT, () => {
      console.log(`✓ Calendar API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('✗ Failed to start server:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

startServer();
