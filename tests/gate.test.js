import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setupProjectDir, makeSessionFile, makeOptOutMarker } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'gate.js');

function runGate(stdinPayload, projectDir, envExtra = {}) {
  return spawnSync('node', [SCRIPT], {
    input: JSON.stringify(stdinPayload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...envExtra },
    timeout: 5000,
    encoding: 'utf8',
  });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('helpers importable', async () => {
  const mod = await import('../scripts/gate.js');
  assert.equal(typeof mod.sessionFileExistsForSession, 'function');
  assert.equal(typeof mod.optOutMarkerExists, 'function');
  assert.equal(typeof mod.sanitizeSessionId, 'function');
});

test('UserPromptSubmit silent when session file exists', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('UserPromptSubmit silent when opt-out', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeOptOutMarker(sessionsDir, 's1');
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('UserPromptSubmit injects reminder when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('<system-reminder>'));
    assert.ok(r.stdout.includes('.claude-sessions/sessions/'));
    assert.ok(r.stdout.includes('</system-reminder>'));
  } finally { cleanup(); }
});

test('PreToolUse allows when session file exists', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows opt-out', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeOptOutMarker(sessionsDir, 's1');
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows write to sessions dir', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const target = join(sessionsDir, 'sessions', `${today()}-foo.md`);
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: target } },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows write to opt-out dir', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const target = join(sessionsDir, '.opt-out', 's1');
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: target } },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse denies Read when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
    assert.ok(payload.reason.toLowerCase().includes('session'));
  } finally { cleanup(); }
});

test('PreToolUse denies Bash when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      projectDir
    );
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
  } finally { cleanup(); }
});

test('malformed stdin fails open', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = spawnSync('node', [SCRIPT], {
      input: 'not json at all',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 5000,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse denies when only another session\'s file exists today', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    // A different session ('other') already wrote its file today.
    makeSessionFile(sessionsDir, today(), 'other-work', { sessionId: 'other' });
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
    assert.ok(payload.reason.toLowerCase().includes('this session'));
  } finally { cleanup(); }
});

test('UserPromptSubmit reminds when only another session\'s file exists today', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'other-work', { sessionId: 'other' });
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('<system-reminder>'));
    assert.ok(r.stdout.toLowerCase().includes('this session'));
  } finally { cleanup(); }
});

test('PreToolUse allows when matching file dated yesterday (cross-midnight resume)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, yesterday(), 'long-task', { sessionId: 's1' });
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse denies when file has malformed frontmatter (no session_id)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const path = join(sessionsDir, 'sessions', `${today()}-broken.md`);
    writeFileSync(path, 'no frontmatter here\n', 'utf8');
    const r = runGate(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      projectDir
    );
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
  } finally { cleanup(); }
});

test('sessionFileExistsForSession matches by 8-char prefix of session_id', async () => {
  const { sessionsDir, cleanup } = setupProjectDir();
  try {
    const mod = await import('../scripts/gate.js');
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 'abcd1234efgh5678' });
    // Full id matches.
    assert.equal(mod.sessionFileExistsForSession(sessionsDir, 'abcd1234efgh5678'), true);
    // First-8-chars match (e.g. caller passed only the prefix).
    assert.equal(mod.sessionFileExistsForSession(sessionsDir, 'abcd1234'), true);
    // Different id with different first 8 chars does not match.
    assert.equal(mod.sessionFileExistsForSession(sessionsDir, 'wxyz9999'), false);
    // 'unknown' (sanitized fallback) never matches.
    assert.equal(mod.sessionFileExistsForSession(sessionsDir, ''), false);
  } finally { cleanup(); }
});
