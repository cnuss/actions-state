'use strict';

const crypto = require('crypto');

const MAGIC = Buffer.from('ASTE1');
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
// N=2^15, r=8 needs 32 MiB, exactly scrypt's default maxmem; raise the ceiling.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

function isEncrypted(blob) {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

function aadFor(repository, name) { return `${repository}:${name}`; }

// MAGIC | salt | nonce | ciphertext | tag
function encrypt(plaintext, passphrase, aad) {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, salt, nonce, body, cipher.getAuthTag()]);
}

function decrypt(blob, passphrase, aad) {
  const head = MAGIC.length + SALT_LEN + NONCE_LEN;
  if (!isEncrypted(blob) || blob.length < head + TAG_LEN) {
    throw new Error('decryption failed: not an actions-state encrypted blob');
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = blob.subarray(MAGIC.length + SALT_LEN, head);
  const body = blob.subarray(head, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('decryption failed: wrong passphrase or tampered state');
  }
}

module.exports = { MAGIC, encrypt, decrypt, isEncrypted, aadFor };
