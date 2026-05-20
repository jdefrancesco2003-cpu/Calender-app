/**
 * CalPal E2E Encryption Utilities (browser / Web Crypto API)
 *
 * Architecture:
 * - User password → PBKDF2 → AES-256-GCM key
 * - Each event encrypted individually client-side
 * - Server stores ciphertext only — zero knowledge
 *
 * Usage (future client integration):
 *   const key = await deriveKey(password, salt);
 *   const { ciphertext, iv } = await encryptEvent(event, key);
 *   // store { ciphertext, iv, salt } on server
 *   const event = await decryptEvent(ciphertext, iv, key);
 */

const PBKDF2_ITERATIONS = 200000;

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptEvent(eventObj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(eventObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv)
  };
}

async function decryptEvent(ciphertext, iv, key) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(iv) },
    key,
    base64ToBuf(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function generateSalt() {
  return bufToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// Node.js export (for testing)
if (typeof module !== 'undefined') {
  module.exports = { deriveKey, encryptEvent, decryptEvent, generateSalt };
}
