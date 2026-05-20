/**
 * User model for CalPal multi-user support
 * Not yet wired to server.js — scaffold for future auth implementation
 */

/**
 * User document shape for MongoDB 'users' collection:
 * {
 *   _id: ObjectId,
 *   userId: string (UUID),
 *   email: string (unique, lowercase),
 *   passwordHash: string (bcrypt, 12 rounds),
 *   createdAt: Date,
 *   lastLoginAt: Date,
 *   settings: {
 *     timezone: string,           // e.g. 'America/New_York'
 *     notificationsEnabled: bool,
 *     theme: 'dark' | 'light',
 *   },
 *   // E2E encryption: salt stored per user; key derived client-side from password
 *   encryptionSalt: string | null, // base64 — null means not encrypted
 * }
 */

/**
 * Events collection: each document has userId field for scoping
 * {
 *   _id: ObjectId,
 *   id: string,      // CalPal event ID (timestamp-based)
 *   userId: string,  // owner — indexes on this for fast queries
 *   title: string,   // encrypted ciphertext when E2E enabled
 *   date: string,
 *   endDate: string | null,
 *   time: string | null,
 *   endTime: string | null,
 *   isAllDay: bool,
 *   description: string,
 *   isMultiDay: bool,
 *   createdAt: Date,
 *   updatedAt: Date,
 *   // E2E fields (present when encryption enabled)
 *   encrypted: bool,
 *   iv: string | null,  // base64 AES-GCM IV
 * }
 */

// Validation helpers (reuse in server.js when auth is wired up)
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

module.exports = { validateEmail, validatePassword };
