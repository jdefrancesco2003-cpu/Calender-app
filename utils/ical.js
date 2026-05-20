/**
 * CalPal iCal (.ics) Import/Export
 * RFC 5545 compliant, compatible with Apple Calendar, Google Calendar, Outlook
 */

function formatICalDate(dateStr, timeStr) {
  if (!timeStr) return `TZID=America/New_York:${dateStr.replace(/-/g, '')}`;
  return `TZID=America/New_York:${dateStr.replace(/-/g, '')}T${timeStr.replace(':', '')}00`;
}

function parseICalDate(dtValue) {
  // Handle VALUE=DATE (all-day) and TZID formats
  const clean = dtValue.replace(/TZID=[^:]+:/,'').replace(/VALUE=DATE:/,'');
  if (clean.length === 8) {
    // All-day: YYYYMMDD
    return { date: `${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`, time: null };
  }
  // DateTime: YYYYMMDDTHHMMSS
  return {
    date: `${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`,
    time: `${clean.slice(9,11)}:${clean.slice(11,13)}`
  };
}

/**
 * Export CalPal events array to iCal string
 */
function exportToICal(events, calendarName = 'CalPal') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CalPal//CalPal Calendar//EN',
    `X-WR-CALNAME:${calendarName}`,
    'X-WR-TIMEZONE:America/New_York',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  events.forEach(ev => {
    const uid = `${ev.id}@calpal.app`;
    const created = ev.createdAt ? new Date(ev.createdAt).toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z' : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`SUMMARY:${ev.title}`);
    if (created) lines.push(`DTSTAMP:${created}`);
    if (ev.description) lines.push(`DESCRIPTION:${ev.description.replace(/\n/g,'\\n')}`);

    if (ev.isAllDay || !ev.time) {
      lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g,'')}`);
      const endDate = ev.endDate || ev.date;
      // iCal all-day DTEND is exclusive (day after last day)
      const endDateObj = new Date(endDate + 'T00:00:00');
      endDateObj.setDate(endDateObj.getDate() + 1);
      const endStr = endDateObj.toISOString().slice(0,10).replace(/-/g,'');
      lines.push(`DTEND;VALUE=DATE:${endStr}`);
    } else {
      lines.push(`DTSTART;${formatICalDate(ev.date, ev.time)}`);
      const endTime = ev.endTime || ev.time;
      const endDate = ev.endDate || ev.date;
      lines.push(`DTEND;${formatICalDate(endDate, endTime)}`);
    }

    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  // Fold lines > 75 chars per RFC 5545
  return lines.map(line => {
    if (line.length <= 75) return line;
    const chunks = [];
    for (let i = 0; i < line.length; i += 74) chunks.push((i === 0 ? '' : ' ') + line.slice(i, i + 74));
    return chunks.join('\r\n');
  }).join('\r\n') + '\r\n';
}

/**
 * Parse an iCal string into CalPal event objects
 * Returns array of partial event objects (caller assigns IDs and saves)
 */
function importFromICal(icalStr) {
  const events = [];
  const vevents = icalStr.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

  vevents.forEach(block => {
    const get = (key) => {
      const match = block.match(new RegExp(`^${key}[;:][^\r\n]+`, 'm'));
      return match ? match[0].replace(new RegExp(`^${key}[^:]*:`), '').trim() : null;
    };

    const title = get('SUMMARY') || 'Untitled';
    const dtstart = get('DTSTART');
    const dtend = get('DTEND');
    const description = (get('DESCRIPTION') || '').replace(/\\n/g, '\n');

    if (!dtstart) return;

    const start = parseICalDate(dtstart);
    const end = dtend ? parseICalDate(dtend) : null;
    const isAllDay = !start.time;

    let endDate = null;
    if (end && end.date !== start.date) {
      // iCal all-day DTEND is exclusive — subtract one day
      if (isAllDay) {
        const d = new Date(end.date + 'T00:00:00');
        d.setDate(d.getDate() - 1);
        endDate = d.toISOString().slice(0, 10);
      } else {
        endDate = end.date;
      }
    }

    events.push({
      title,
      date: start.date,
      endDate: endDate || null,
      time: start.time,
      endTime: end?.time || null,
      isAllDay,
      description,
      isMultiDay: !!endDate,
    });
  });

  return events;
}

module.exports = { exportToICal, importFromICal };
