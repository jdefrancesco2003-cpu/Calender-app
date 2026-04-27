const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();
const eventsFile = 'events.json';

// Load events from file
function loadEvents() {
  if (fs.existsSync(eventsFile)) {
    return JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
  }
  return [];
}

// Save events to file
function saveEvents(events) {
  fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
}

// Parse natural language event
app.post('/api/events/parse', async (req, res) => {
  const { text } = req.body;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Parse this event: "${text}". Return ONLY valid JSON: {"title":"event name","date":"YYYY-MM-DD","time":"HH:mm or null"}. Be smart about dates (tomorrow, next week, etc). If you can't parse it, return {"error":true}`
        }
      ]
    });

    const content = response.content[0].text;
    const parsed = JSON.parse(content);

    if (parsed.error) {
      return res.status(400).json({ error: true });
    }

    // Add to events
    const events = loadEvents();
    const newEvent = {
      id: Date.now().toString(),
      ...parsed,
      endTime: null,
      description: ''
    };
    events.push(newEvent);
    saveEvents(events);

    res.json(newEvent);
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: true });
  }
});

// Get all events
app.get('/api/events', (req, res) => {
  res.json(loadEvents());
});

// Add event
app.post('/api/events', (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  const events = loadEvents();
  
  const newEvent = {
    id: Date.now().toString(),
    title,
    date,
    time: time || null,
    endTime: endTime || null,
    description: description || ''
  };
  
  events.push(newEvent);
  saveEvents(events);
  res.json(newEvent);
});

// Update event
app.put('/api/events/:id', (req, res) => {
  const { title, date, time, endTime, description } = req.body;
  let events = loadEvents();
  
  events = events.map(e => 
    e.id === req.params.id 
      ? { ...e, title, date, time: time || null, endTime: endTime || null, description: description || '' }
      : e
  );
  
  saveEvents(events);
  res.json(events.find(e => e.id === req.params.id));
});

// Delete event
app.delete('/api/events/:id', (req, res) => {
  let events = loadEvents();
  events = events.filter(e => e.id !== req.params.id);
  saveEvents(events);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Calendar API running on port ${PORT}`);
});
