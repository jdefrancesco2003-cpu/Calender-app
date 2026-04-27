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

// Connect to MongoDB
MongoClient.connect(mongoUri, { useUnifiedTopology: true })
  .then(connection => {
    const db = connection.db('calendar');
    eventsCollection = db.collection('events');
    console.log('Connected to MongoDB');
  })
  .catch(err => console.error('MongoDB connection failed:', err));

// Load events from database
async function loadEvents() {
  if (!eventsCollection) return [];
  return await eventsCollection.find({}).toArray();
}

// Save event to database
async function saveEvent(event) {
  if (!eventsCollection) return;
  await eventsCollection.insertOne(event);
}

// Update events
async function updateEvent(id, updates) {
  if (!eventsCollection) return;
  await eventsCollection.updateOne(
    { id },
    { $set: updates }
  );
}

// Delete event
async function deleteEvent(id) {
  if (!eventsCollection) return;
  await eventsCollection.deleteOne({ id });
}

// Helper: Get today's date string
function getTodayString() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString().split('T')[0];
}

// Helper: Get tomorrow's date string
function getTomorrowString() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString().split('T')[0];
}

// Parse event with Claude
async function parseEvent(text) {
  const today = getTodayString();
  const tomorrow = getTomorrowString();

  const response = await client.messages.create({
    model: 'claude-opus-4-1-20250805',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `You are a calendar event parser. Today is April 27, 2026. Parse this event: "${text}"

Return ONLY valid JSON. No markdown, no extra text.

Extract:
1. title: Event name
2. date: Date in YYYY-MM-DD format
3. time: Time in HH:mm 24-hour, or null

Date rules (TODAY = ${today}, TOMORROW = ${tomorrow}):
- "today" → ${today}
- "tomorrow" → ${tomorrow}
- "next week" → 7 days from today
- Day names like "Friday" → next Friday
- "next Friday" → next Friday
- If no date mentioned, use TODAY (${today})

Time rules:
- "noon" or "12pm" → 12:00
- "morning" → 09:00
- "afternoon" → 14:00  
- "evening" → 18:00
- Specific times → exact (2pm = 14:00)
- No time mentioned → null

JSON format only:
{
  "title": "event name",
  "date": "YYYY-MM-DD",
  "time": "HH:mm" or null
}`
      }
    ]
  });

  const content = response.content[0].text.trim();
  console.log('Claude response:', content);

  // Try to extract JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Could not parse JSON');
    }
  }

  // Validate
  if (!parsed.title || !parsed.date) {
    throw new Error('Missing required fields');
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(parsed.date)) {
    throw new Error(`Invalid date format: ${parsed.date}`);
  }

  // Validate time format
  if (parsed.time) {
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(parsed.time)) {
      parsed.time = null;
    }
  }

  return parsed;
}

// Parse natural language event
app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;

  try {
    const parsed = await parseEvent(text);

    // Add to database
    const newEvent = {
      id: Date.now().toString(),
      title: parsed.title,
      date: parsed.date,
      time: parsed.time || null,
      endTime: null,
      description: ''
    };
    
    await saveEvent(newEvent);
    console.log('Event saved:', newEvent);

    res.json(newEvent);
  } catch (err) {
    console.error('Parse error:', err);
    res.status(400).json({ error: true });
  }
});

// Get all events
app.get('/api/events', async (req, res) => {
  const events = await loadEvents();
  res.json(events);
});

// Add event
app.post('/api/events', async (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  
  const newEvent = {
    id: Date.now().toString(),
    title,
    date,
    time: time || null,
    endTime: endTime || null,
    description: description || ''
  };
  
  await saveEvent(newEvent);
  res.json(newEvent);
});

// Update event
app.put('/api/events/:id', async (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  
  await updateEvent(req.params.id, {
    title, date, time: time || null, endTime: endTime || null, description: description || ''
  });
  
  const events = await loadEvents();
  res.json(events.find(e => e.id === req.params.id));
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
  await deleteEvent(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Calendar API running on port ${PORT}`);
});
