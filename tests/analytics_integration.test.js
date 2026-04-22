import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { setupProjectDir, makeSessionFile, makeSyntheticTranscript } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'analytics.js');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function runAnalytics(projectDir, fmt = 'json', envExtra = {}) {
  return spawnSync('node', [SCRIPT, '--project-dir', projectDir, '--format', fmt], {
    env: { ...process.env, ...envExtra },
    timeout: 20_000,
    encoding: 'utf8',
  });
}

test('analytics handles no transcripts', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runAnalytics(projectDir, 'json');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.summary.total_sessions, 1);
    assert.ok(!('tokens' in data) || Object.keys(data.tokens).length === 0);
  } finally { cleanup(); }
});

test('analytics merges transcript data when present', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  const { projectDir: fakeHome, cleanup: cleanupHome } = setupProjectDir();
  try {
    const projectsDir = join(fakeHome, '.claude', 'projects', '-fake-cwd');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 's1.jsonl');
    makeSyntheticTranscript(transcriptPath, { sessionId: 's1', numTurns: 3, model: 'claude-opus-4-7' });
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runAnalytics(projectDir, 'json', { HOME: fakeHome });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assert.ok('tokens' in data);
    assert.ok(data.tokens.s1 && data.tokens.s1.total > 0);
  } finally {
    cleanup();
    cleanupHome();
  }
});
