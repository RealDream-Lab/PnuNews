import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const validEnv = {
  PORT: '3010',
  NODE_ENV: 'development',
  PUBLIC_URL: 'http://localhost:3010',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'pnu_news',
  DB_USER: 'pnu_news',
  DB_PASSWORD: 'local-test',
  APP_SECRET: 'a'.repeat(64),
  UPLOAD_DIR: './uploads',
};

test('loads and validates application configuration', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.port, 3010);
  assert.equal(config.db.port, 3306);
  assert.equal(config.publicUrl, 'http://localhost:3010');
});

test('rejects missing and placeholder configuration', () => {
  assert.throws(() => loadConfig({ ...validEnv, DB_PASSWORD: 'CHANGE_ME' }), /DB_PASSWORD/);
  assert.throws(() => loadConfig({ ...validEnv, APP_SECRET: 'short' }), /۶۴/);
});
