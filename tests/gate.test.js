import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setupProjectDir, makeSessionFile, makeOptOutMarker, makeRawJsonl } from './helpers.js';

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

function backdate(filePath, secondsAgo) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(filePath, t, t);
}

function eventsSince(sessionId, count, spreadSecondsAgo) {
  // Generates `count` user_prompt events with timestamps spread across the last
  // `spreadSecondsAgo` seconds (all in the past, all > a session-file mtime
  // backdated to before that window).
  const now = Date.now();
  const events = [];
  for (let i = 0; i < count; i++) {
    const offsetMs = ((spreadSecondsAgo * 1000) * (count - i)) / (count + 1);
    events.push({
      timestamp: new Date(now - offsetMs).toISOString(),
      event: 'user_prompt',
      session_id: sessionId,
      prompt: `p${i}`,
    });
  }
  return events;
}

test('heartbeat: no reminder when fresh (1 prompt since mtime)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'fresh', { sessionId: 's1' });
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 1, 1));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('heartbeat: reminder fires at 5-prompt threshold', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const filePath = makeSessionFile(sessionsDir, today(), 'stale-five', { sessionId: 's1' });
    backdate(filePath, 3600);
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 5, 1800));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('<system-reminder>'), 'expected system-reminder');
    assert.ok(r.stdout.includes('HEARTBEAT'), 'expected HEARTBEAT marker');
    assert.ok(r.stdout.includes('-stale-five.md'), 'expected filename in reminder');
    assert.ok(r.stdout.includes('5 user prompts'), 'expected count=5 in reminder');
  } finally { cleanup(); }
});

test('heartbeat: no reminder at 4 prompts (just below threshold)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const filePath = makeSessionFile(sessionsDir, today(), 'under', { sessionId: 's1' });
    backdate(filePath, 3600);
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 4, 1800));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('heartbeat: count capped at threshold+1 when 7 prompts present', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const filePath = makeSessionFile(sessionsDir, today(), 'cap', { sessionId: 's1' });
    backdate(filePath, 3600);
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 7, 1800));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('HEARTBEAT'));
    assert.ok(r.stdout.includes('6 user prompts'), 'count should cap at 6 (threshold+1)');
    assert.ok(!r.stdout.includes('7 user prompts'), 'count must not exceed cap');
  } finally { cleanup(); }
});

test('heartbeat: fail-open when jsonl missing', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const filePath = makeSessionFile(sessionsDir, today(), 'no-jsonl', { sessionId: 's1' });
    backdate(filePath, 3600);
    // No raw/s1.jsonl written.
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('heartbeat: skips malformed jsonl lines, still fires on 5 valid', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const filePath = makeSessionFile(sessionsDir, today(), 'malformed', { sessionId: 's1' });
    backdate(filePath, 3600);
    const valid = eventsSince('s1', 5, 1800);
    // 2 valid + garbage + 3 valid = 5 valid total, 1 unparseable
    const lines = [
      JSON.stringify(valid[0]),
      JSON.stringify(valid[1]),
      '{not json',
      JSON.stringify(valid[2]),
      JSON.stringify(valid[3]),
      JSON.stringify(valid[4]),
    ];
    makeRawJsonl(sessionsDir, 's1', lines);
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('HEARTBEAT'), 'reminder should fire despite malformed line');
    assert.ok(r.stdout.includes('5 user prompts'));
  } finally { cleanup(); }
});

test('heartbeat: does NOT fire when no session file (gate deny path)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    // Even if jsonl has many stale events, no session file → only gate reminder fires.
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 7, 1800));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('SESSION GATE'), 'expected gate reminder');
    assert.ok(!r.stdout.includes('HEARTBEAT'), 'must not fire heartbeat when gate denies');
  } finally { cleanup(); }
});

test('heartbeat: respects opt-out marker (silent)', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeOptOutMarker(sessionsDir, 's1');
    // Stale jsonl present, but no session file and opt-out → silent.
    makeRawJsonl(sessionsDir, 's1', eventsSince('s1', 7, 1800));
    const r = runGate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' },
      projectDir
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});
