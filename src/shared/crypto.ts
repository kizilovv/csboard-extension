// ============================================================
// CSBOARD — Cryptographic Token Protection
// ============================================================
// AES-GCM encryption for sensitive tokens (Steam access tokens, etc.)
// - Session key stored in chrome.storage.session (ephemeral, cleared on browser close)
// - Encrypted tokens stored in chrome.storage.local (persistent)
// - On browser restart: session key gone → user must re-enter token
// - NEVER send access tokens to CSBOARD servers
// - Based on CSFloat's open-source security patterns

import { createLogger } from './logger';
import { type Result, Ok, Fail } from './result';

const logger = createLogger('crypto');

// --- Constants ---

const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256; // bits
const IV_LENGTH = 12; // bytes (96 bits for GCM is standard)
const SESSION_KEY_NAME = 'csboard_session_crypto_key';

// --- Types ---

export interface EncryptedToken {
  ciphertext: string; // base64
  iv: string; // base64
  algorithm: string;
}

// --- Session Key Management ---

/**
 * Get or create the ephemeral session encryption key.
 * Stored in chrome.storage.session so it's cleared when browser closes.
 * This forces users to re-enter sensitive tokens after restart (by design).
 */
async function getOrCreateSessionKey(): Promise<CryptoKey> {
  try {
    // Try to get existing key from session storage
    const stored = await chrome.storage.session.get(SESSION_KEY_NAME);
    if (stored[SESSION_KEY_NAME]) {
      const keyData = stored[SESSION_KEY_NAME] as JsonWebKey;
      return await crypto.subtle.importKey(
        'jwk',
        keyData,
        { name: ENCRYPTION_ALGORITHM },
        false, // not extractable (can't export after import)
        ['encrypt', 'decrypt'],
      );
    }
  } catch (err) {
    logger.warn('Failed to retrieve session key, generating new one', { error: String(err) });
  }

  // Generate new key
  logger.debug('Generating new session encryption key');
  const key = await crypto.subtle.generateKey(
    { name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH },
    true, // extractable so we can store it
    ['encrypt', 'decrypt'],
  );

  // Export and store in session storage
  const exported = await crypto.subtle.exportKey('jwk', key);
  try {
    await chrome.storage.session.set({
      [SESSION_KEY_NAME]: exported,
    });
  } catch (err) {
    logger.error('Failed to store session key', { error: String(err) });
    // Key exists in memory even if storage fails
  }

  return key;
}

/**
 * Clear the session key (for logout or token removal).
 */
export async function clearSessionKey(): Promise<void> {
  try {
    await chrome.storage.session.remove(SESSION_KEY_NAME);
    logger.debug('Session key cleared');
  } catch (err) {
    logger.error('Failed to clear session key', { error: String(err) });
  }
}

// --- Encryption / Decryption ---

/**
 * Encrypt a plaintext token using AES-GCM.
 * Returns: { ciphertext, iv } both as base64
 */
export async function encryptToken(plaintext: string): Promise<Result<EncryptedToken>> {
  try {
    const key = await getOrCreateSessionKey();

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Encrypt
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      key,
      encoded,
    );

    // Convert to base64 for storage
    const ciphertextB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const ivB64 = btoa(String.fromCharCode(...iv));

    logger.debug('Token encrypted', { tokenLength: plaintext.length });

    return Ok({
      ciphertext: ciphertextB64,
      iv: ivB64,
      algorithm: ENCRYPTION_ALGORITHM,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Encryption failed', { error: message });
    return Fail(message, 'STORAGE_ERROR');
  }
}

/**
 * Decrypt a token encrypted with encryptToken.
 * Expects: { ciphertext, iv } both as base64
 */
export async function decryptToken(encrypted: EncryptedToken): Promise<Result<string>> {
  try {
    const key = await getOrCreateSessionKey();

    // Decode base64
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (c) => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0));

    // Decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      key,
      ciphertext,
    );

    const decoded = new TextDecoder().decode(plaintext);
    logger.debug('Token decrypted', { tokenLength: decoded.length });

    return Ok(decoded);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Decryption failed', { error: message });
    return Fail(message, 'STORAGE_ERROR');
  }
}

/**
 * Check if session key exists (useful for UI: show "enter token again" prompt).
 */
export async function hasSessionKey(): Promise<boolean> {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY_NAME);
    return !!stored[SESSION_KEY_NAME];
  } catch {
    return false;
  }
}
