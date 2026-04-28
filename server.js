const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();
const mongoUri = process.env.MONGODB_URI;
let eventsCollection;
let mongoClient;

// Connect to MongoDB BEFORE starting server
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

// Load events from database
async function loadEvents() {
  if (!eventsCollection) {
    console.error('MongoDB not connected');
    return [];
  }
  try {
    const events = await eventsCollection.find({}).toArray();
    return events;
  } catch (err) {
    console.error('Error loading events:', err.message);
    return [];
  }
}

// Save event to database
async function saveEvent(event) {
  if (!eventsCollection) {
    console.error('MongoDB not connected');
    return null;
  }
  try {
    const result = await eventsCollection.insertOne(event);
    return { ...event, _id: result.insertedId };
  } catch (err) {
    console.error('Error saving event:', err.message);
    return null;
  }
}

// Update event
async function updateEvent(id, updates) {
  if (!eventsCollection) {
    console.error('MongoDB not connected');
    return null;
  }
  try {
    await eventsCollection.updateOne(
      { id },
      { $set: updates }
    );
    return updates;
  } catch (err) {
    console.error('Error updating event:', err.message);
    return null;
  }
}

// Delete event
async function deleteEvent(id) {
  if (!eventsCollection) {
    console.error('MongoDB not connected');
    return false;
  }
  try {
    const result = await eventsCollection.deleteOne({ id });
    return result.deletedCount > 0;
  } catch (err) {
    console.error('Error deleting event:', err.message);
    return false;
  }
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

// Helper: Format date for display
function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
}

// Parse event with Claude
async function parseEvent(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Event text cannot be empty');
  }

  const today = getTodayString();
  const tomorrow = getTomorrowString();
  const formattedToday = getFormattedDate();

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-20250805',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `You are a calendar event parser. Today is ${formattedToday} (${today}). Parse this event: "${text}"

Return ONLY valid JSON. No markdown, no extra text.

Extract:
1. title: Event name
2. date: Date in YYYY-MM-DD format
3. time: Time in HH:mm 24-hour format, or null if not specified
4. endTime: End time in HH:mm format, or null if not specified

Date rules (TODAY = ${today}, TOMORROW = ${tomorrow}):
- "today" → ${today}
- "tomorrow" → ${tomorrow}
- "next week" → 7 days from today
- Day names like "Friday" → next occurring Friday
- "next Friday" → next Friday
- If no date mentioned, use TODAY (${today})

Time rules:
- "noon" or "12pm" → 12:00
- "morning" → 09:00
- "afternoon" → 14:00  
- "evening" → 18:00
- "night" → 20:00
- Specific times → exact (2pm = 14:00)
- No time mentioned → null

Return ONLY this JSON format:
{
  "title": "event name",
  "date": "YYYY-MM-DD",
  "time": "HH:mm" or null,
  "endTime": "HH:mm" or null
}`
        }
      ]
    });

    const content = response.content[0].text.trim();
    console.log('Claude response:', content);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not extract JSON from response');
      }
    }

    // Validate required fields
    if (!parsed.title || !parsed.date) {
      throw new Error('Missing required fields: title and date');
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(parsed.date)) {
      throw new Error(`Invalid date format: ${parsed.date}`);
    }

    // Validate time format if present
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

    return parsed;
  } catch (err) {
    console.error('Parse error:', err.message);
    throw err;
  }
}

// Parse natural language event
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
      time: parsed.time || null,
      endTime: parsed.endTime || null,
      description: '',
      isMultiDay: false,
      createdAt: new Date()
    };
    
    await saveEvent(newEvent);
    console.log('✓ Event parsed and saved:', newEvent);
    res.json(newEvent);
  } catch (err) {
    console.error('✗ Parse error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to parse event' });
  }
});

// Get all events
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

// Add event (manual entry)
app.post('/api/events', async (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  
  // Validate required fields
  if (!title || !date) {
    return res.status(400).json({ error: 'Title and date are required' });
  }

  const newEvent = {
    id: Date.now().toString(),
    title: title.trim(),
    date,
    time: time || null,
    endTime: endTime || null,
    description: description || '',
    isMultiDay: false,
    createdAt: new Date()
  };
  
  const result = await saveEvent(newEvent);
  if (result) {
    res.json(result);
  } else {
    res.status(500).json({ error: 'Failed to save event' });
  }
});

// Update event
app.put('/api/events/:id', async (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  const eventId = req.params.id;

  // Validate required fields
  if (!title || !date) {
    return res.status(400).json({ error: 'Title and date are required' });
  }

  const updates = {
    title: title.trim(),
    date,
    time: time || null,
    endTime: endTime || null,
    description: description || '',
    updatedAt: new Date()
  };

  await updateEvent(eventId, updates);
  
  const events = await loadEvents();
  const updated = events.find(e => e.id === eventId);
  
  if (updated) {
    res.json(updated);
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
  const success = await deleteEvent(req.params.id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start server AFTER MongoDB is connected
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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

startServer();
