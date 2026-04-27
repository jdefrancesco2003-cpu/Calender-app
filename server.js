const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Anthropic } = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const EVENTS_FILE = path.join(__dirname, 'events.json');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function loadEvents() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const data = fs.readFileSync(EVENTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.log('Starting with empty events');
  }
  return [];
}

function saveEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}

async function parseEventFromNaturalLanguage(text) {
  try {
    const prompt = `Parse this natural language event description and extract event details. Return ONLY valid JSON with no additional text.

Input: "${text}"

Return a JSON object with:
- title: string (the event name)
- date: string (YYYY-MM-DD format, use today's date as reference: ${new Date().toISOString().split('T')[0]})
- time: string (HH:mm format, or null if not specified)
- description: string (optional additional details)

If the input doesn't describe an event, return {"error": "not an event"}

Examples:
- "lunch tomorrow at noon" → {"title":"Lunch","date":"2025-04-27","time":"12:00","description":""}
- "dentist appointment next Tuesday at 2:30pm" → {"title":"Dentist appointment","date":"2025-04-29","time":"14:30","description":""}
- "yoga class Friday morning" → {"title":"Yoga class","date":"2025-05-02","time":"09:00","description":""}`;

    const message = await anthropic.messages.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    }
    return { error: 'Could not parse event' };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return { error: err.message };
  }
}

app.get('/api/events', (req, res) => {
  const events = loadEvents();
  res.json(events);
});

app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const parsed = await parseEventFromNaturalLanguage(text);
  
  if (parsed.error) {
    return res.status(400).json(parsed);
  }

  const events = loadEvents();
  const event = {
    id: Date.now().toString(),
    title: parsed.title,
    date: parsed.date,
    time: parsed.time,
    description: parsed.description || '',
    createdAt: new Date().toISOString()
  };
  
  events.push(event);
  saveEvents(events);
  
  res.json(event);
});

app.post('/api/events', (req, res) => {
  const { title, date, time, description } = req.body;
  
  if (!title || !date) {
    return res.status(400).json({ error: 'Title and date are required' });
  }

  const events = loadEvents();
  const event = {
    id: Date.now().toString(),
    title,
    date,
    time: time || null,
    description: description || '',
    createdAt: new Date().toISOString()
  };
  
  events.push(event);
  saveEvents(events);
  
  res.json(event);
});

app.put('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const { title, date, time, description } = req.body;
  
  const events = loadEvents();
  const eventIndex = events.findIndex(e => e.id === id);
  
  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  events[eventIndex] = {
    ...events[eventIndex],
    title: title || events[eventIndex].title,
    date: date || events[eventIndex].date,
    time: time !== undefined ? time : events[eventIndex].time,
    description: description !== undefined ? description : events[eventIndex].description
  };
  
  saveEvents(events);
  res.json(events[eventIndex]);
});

app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;
  
  const events = loadEvents();
  const filteredEvents = events.filter(e => e.id !== id);
  
  if (filteredEvents.length === events.length) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  saveEvents(filteredEvents);
  res.json({ success: true });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🗓️  Calendar app is running on port ${PORT}`);
  console.log(`Make sure you have ANTHROPIC_API_KEY set as an environment variable`);
});
