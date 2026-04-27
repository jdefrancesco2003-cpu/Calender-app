# 📅 Natural Language Calendar

A beautiful, fast calendar app that understands natural language. Type "lunch tomorrow at noon" and it's done.

**[Live Demo](https://calendar-app-production.up.railway.app)** · Built with Node.js & Claude AI

---

## ✨ Features

- **🗣️ Natural Language Parsing** — Type events naturally: "meeting next Tuesday at 2pm" or "coffee with Alex Friday morning"
- **⚡ Lightning Fast** — Powered by Claude Sonnet for instant parsing
- **📱 iOS Home Screen App** — Add to home screen, works like a native app
- **🌙 Dark Mode** — Easy on the eyes, perfect for late-night planning
- **🔔 Smart Notifications** — Get reminders 15, 30, or 60 minutes before events
- **📅 Month & Week Views** — Switch between calendar layouts instantly
- **✏️ Full Event Editing** — Edit, delete, add times, notes, and more
- **⏱️ Start & End Times** — Set event durations precisely
- **💾 Auto-Backup** — Events sync to localStorage & export as JSON
- **⚠️ Overlap Detection** — Warns when adding events too close together

---

## 🚀 Quick Start

### Add to iPhone Home Screen
1. Open in Safari: [calendar-app-production.up.railway.app](https://calendar-app-production.up.railway.app)
2. Tap **Share** → **Add to Home Screen**
3. Name it "Calendar" → **Add**
4. Open from home screen (works offline, syncs when online)

### On Desktop
Just visit the link above and start adding events.

---

## 💡 How to Use

### Quick Add (Natural Language)
1. Go to **Add Event** tab
2. Type naturally:
   - "lunch tomorrow at noon"
   - "dentist appointment next friday 2pm"
   - "workout saturday morning"
3. Tap **Add Event** (watch the smooth loading bar)
4. Done! ✓

### Manual Entry
1. Go to **Add Event** tab
2. Scroll to **Manual Entry**
3. Fill in title, date, times, notes
4. Tap **Save Event**

### Edit Events
1. Tap any event on the calendar or in the list
2. Edit any field
3. Tap **Save** or **Delete**

### Notification Settings
1. Tap **Settings** in header
2. Toggle **Enable Notifications**
3. Choose alert timing: 15, 30, or 60 minutes before
4. Tap **Done**

---

## 🛠️ Built With

- **Frontend**: HTML5, CSS3, vanilla JavaScript
- **Backend**: Node.js, Express
- **AI**: Claude Sonnet 4 (natural language parsing)
- **Hosting**: Railway.app
- **Storage**: JSON files + browser localStorage

---

## 📦 Installation (Self-Hosted)

### Prerequisites
- Node.js 14+
- npm
- Anthropic API key ([get one free](https://console.anthropic.com))

### Local Setup
```bash
git clone https://github.com/YOUR_USERNAME/calendar-app.git
cd calendar-app
npm install
```

### Environment Variables
Create a `.env` file or set in Railway:
```
ANTHROPIC_API_KEY=your_api_key_here
PORT=3000
```

### Run Locally
```bash
npm start
```
Open `http://localhost:3000`

### Deploy to Railway
1. Push to GitHub
2. Connect repo to Railway
3. Add `ANTHROPIC_API_KEY` env variable
4. Deploy (auto-deploys on every commit)

---

## 📂 Project Structure

```
calendar-app/
├── server.js              # Express API backend
├── package.json           # Dependencies
├── public/
│   └── index.html         # Full app (HTML + CSS + JS)
└── events.json            # Event storage
```

---

## 🔌 API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/events` | Get all events |
| POST | `/api/events/parse` | Parse natural language |
| POST | `/api/events` | Create event |
| PUT | `/api/events/:id` | Update event |
| DELETE | `/api/events/:id` | Delete event |

### Parse Natural Language
```bash
POST /api/events/parse
Content-Type: application/json

{
  "text": "lunch tomorrow at noon"
}
```

Returns:
```json
{
  "id": "1234567890",
  "title": "lunch",
  "date": "2025-04-28",
  "time": "12:00",
  "endTime": null,
  "description": ""
}
```

---

## ⚙️ Configuration

### Notification Timing
Edit `notificationTiming` in settings (15, 30, or 60 minutes)

### Date Parsing
The app understands:
- Today, tomorrow, next week
- Specific dates: "April 25"
- Relative dates: "Friday", "next Tuesday"
- Weekday names: "Monday", "Wednesday"

### Timezone
Currently set to **Eastern Time (ET)**. To change:
1. Edit `formatTimeEastern()` function in `index.html`
2. Update the timezone conversion logic

---

## 🐛 Troubleshooting

**Events disappear after refresh?**
- Make sure ANTHROPIC_API_KEY is set in Railway Variables
- Check browser localStorage under Settings

**Notifications not working?**
- Grant notification permission when prompted
- Check browser notification settings
- Only works with timed events (all-day events don't notify)

**Natural language parsing fails?**
- Try a simpler description: "meeting Friday 2pm"
- Check API key is valid
- Verify Railway deployment is active

---

## 🎨 Customization

### Change Colors
Edit CSS variables in `index.html` `<style>`:
```css
:root {
  --primary: #4a9d6f;        /* Green accent */
  --bg-dark: #1c1c1e;        /* Dark background */
  --text-primary: #ffffff;   /* White text */
}
```

### Change Notification Defaults
Edit in JavaScript `init()` function:
```javascript
notificationTiming = 15; // Change to 30 or 60
```

---

## 📝 Privacy

- Events stored **locally on your device** (localStorage)
- Server stores events in `events.json` (ephemeral on Railway)
- API key required but not logged/stored
- No analytics or tracking
- No data sold or shared

---

## 🤝 Contributing

Found a bug? Have an idea? Feel free to:
1. Fork the repo
2. Create a branch
3. Submit a pull request

---

## 📄 License

MIT — Use freely, modify, redistribute. See LICENSE file.

---

## 🙏 Credits

Built with ❤️ using Claude AI for natural language magic.

**Natural language parsing powered by:**
- [Anthropic Claude API](https://anthropic.com)

**Inspired by:**
- Clean, minimal design
- Fast, smooth interactions
- Voice-like input methods

---

## 📱 Screenshots

### Calendar View
Dark mode with month view, event counts on days, today highlighted in green.

### Quick Add
Type naturally, get instant parsing, watch the loading bar fill smoothly.

### Notifications
Get reminded before events with customizable timing (15/30/60 min).

### Settings
Toggle notifications on/off, choose alert timing, clean modal interface.

---

## 🚀 Future Ideas

- [ ] Multi-device sync (Firebase)
- [ ] Color categories for events
- [ ] Recurring events
- [ ] Shared calendars
- [ ] Google Calendar integration
- [ ] Reminders via email/SMS
- [ ] Dark/light theme toggle

---

**Made with Claude AI** 🤖✨

Have a question? Open an issue or reach out!

---

*Last updated: April 2025*
