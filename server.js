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

// Helper: Parse date naturally
function parseDate(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const lower = dateStr.toLowerCase().trim();

  if (lower === 'today') return today.toISOString().split('T')[0];
  if (lower === 'tomorrow') return tomorrow.toISOString().split('T')[0];

  // Try to parse as date
  const parsed = new Date(dateStr);
  if (!isNaN(parsed)) {
    parsed.setHours(0, 0, 0, 0);
    return parsed.toISOString().split('T')[0];
  }

  return today.toISOString().split('T')[0];
}

// Parse event with a specific model
async function parseEventWithModel(text, model) {
  const response = await client.messages.create({
    model: model,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `You are a calendar event parser. Parse this event description: "${text}"

IMPORTANT: Always return valid JSON. Do not include markdown code blocks.

Extract:
1. title: The event name (required)
2. date: The date in YYYY-MM-DD format (required)
3. time: The time in HH:mm 24-hour format, or null if not mentioned (optional)

Instructions for date:
- "tomorrow" = next day
- "today" = today
- "Monday", "Friday", etc = next occurrence of that day
- "next week" = 7 days from today
- Specific dates like "April 25" = 2025-04-25
- If no date mentioned, use today

Instructions for time:
- "noon" or "12pm" = 12:00
- "morning" or "am" = 09:00 (estimate)
- "afternoon" = 14:00 (estimate)
- "evening" = 18:00 (estimate)
- Specific times like "2pm" or "14:00" = exact time
- If no time mentioned, return null

Return ONLY this JSON format with no extra text:
{
  "title": "event name",
  "date": "YYYY-MM-DD",
  "time": "HH:mm" or null
}`
      }
    ]
  });

  const content = response.content[0].text.trim();
  console.log(`${model} response:`, content);

  // Try to extract JSON from response
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Try to find JSON in the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Could not parse JSON from ${model}`);
    }
  }

  // Validate required fields
  if (!parsed.title || !parsed.date) {
    throw new Error(`Missing required fields from ${model}`);
  }

  // Validate and clean up date
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(parsed.date)) {
    parsed.date = parseDate(parsed.date);
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

// Parse natural language event with fallback
app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;

  try {
    let parsed;
    let usedModel = 'sonnet';

    // Try Sonnet first (fast, cheap)
    try {
      console.log('Trying Sonnet...');
      parsed = await parseEventWithModel(text, 'claude-sonnet-4-20250514');
      console.log('Sonnet succeeded!');
    } catch (sonnetErr) {
      console.log('Sonnet failed, trying Opus...', sonnetErr.message);
      
      // Fallback to Opus (slower, more powerful)
      try {
        parsed = await parseEventWithModel(text, 'claude-opus-4-1-20250805');
        usedModel = 'opus';
        console.log('Opus succeeded!');
      } catch (opusErr) {
        console.error('Both models failed:', opusErr);
        return res.status(400).json({ error: true, message: 'Could not parse event' });
      }
    }

    // Add to database
    const newEvent = {
      id: Date.now().toString(),
      title: parsed.title,
      date: parsed.date,
      time: parsed.time || null,
      endTime: null,
      description: '',
      parsedBy: usedModel
    };
    
    await saveEvent(newEvent);
    console.log(`Event saved (${usedModel}):`, newEvent);

    res.json(newEvent);
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: true });
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
