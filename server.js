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

// Parse natural language event
app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Parse this event description: "${text}"

Return ONLY valid JSON with no markdown or extra text.

Rules:
- Extract event title (short, clear name)
- Infer date relative to today (tomorrow, next Friday, etc)
- Extract time if mentioned (HH:mm format, 24-hour)
- If time not mentioned, set to null
- Handle today, tomorrow, next week, specific days, dates
- Be flexible - "lunch tmrw" should parse

Return ONLY this JSON format:
{
  "title": "event name",
  "date": "YYYY-MM-DD",
  "time": "HH:mm" or null
}

If you cannot parse it, return: {"error": true}`
        }
      ]
    });

    const content = response.content[0].text.trim();
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    if (parsed.error) {
      return res.status(400).json({ error: true });
    }

    // Add to database
    const newEvent = {
      id: Date.now().toString(),
      ...parsed,
      endTime: null,
      description: ''
    };
    await saveEvent(newEvent);

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
