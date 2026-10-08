'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, isEncrypted, aadFor, MAGIC } = require('../../src/core/crypto');

const state = Buffer.from('{"version":4,"serial":1}');

test('round trip', () => {
  const blob = encrypt(state, 'correct horse battery', 'o/r:root');
  assert.ok(isEncrypted(blob));
  assert.deepEqual(decrypt(blob, 'correct horse battery', 'o/r:root'), state);
});

test('layout: magic, salt, nonce, ciphertext, tag', () => {
  const blob = encrypt(state, 'p', 'a');
  assert.ok(blob.subarray(0, 5).equals(MAGIC));
  assert.equal(blob.length, 5 + 16 + 12 + state.length + 16);
});

test('every encryption uses a fresh salt and nonce', () => {
  assert.notDeepEqual(encrypt(state, 'p', 'a'), encrypt(state, 'p', 'a'));
});

test('a wrong passphrase fails', () => {
  const blob = encrypt(state, 'right', 'a');
  assert.throws(() => decrypt(blob, 'wrong', 'a'), /wrong passphrase or tampered state/);
});

test('a blob moved to another repo or state name fails', () => {
  const blob = encrypt(state, 'p', 'o/r:root');
  assert.throws(() => decrypt(blob, 'p', 'o/r:other'), /wrong passphrase or tampered state/);
});

test('tampered ciphertext fails', () => {
  const blob = encrypt(state, 'p', 'a');
  blob[blob.length - 20] ^= 1;
  assert.throws(() => decrypt(blob, 'p', 'a'), /wrong passphrase or tampered state/);
});

test('plaintext is not mistaken for an encrypted blob', () => {
  assert.equal(isEncrypted(state), false);
  assert.throws(() => decrypt(state, 'p', 'a'), /not an actions-state encrypted blob/);
});

test('aadFor binds repository and state name', () => {
  assert.equal(aadFor('o/r', 'infra/zone'), 'o/r:infra/zone');
});
