/**
 * Elephants Never Forget — Mechanical Session Logger
 *
 * Append-only JSONL logger for Claude Code hooks.
 * Writes raw event data to .claude-sessions/raw/<session-id>.jsonl
 *
 * Design principles:
 * - NEVER crash, NEVER block — always exit 0
 * - Append-only JSONL — atomic writes, no file locking needed
 * - Fire-and-forget — under 100ms per invocation
 * - Captures both user prompts and Claude responses (tool outputs)
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function sanitizeSessionId(sid) {
  const cleaned = String(sid || '').replace(/[^a-zA-Z0-9-]/g, '');
  return cleaned || 'unknown';
}

function getSessionsDir() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude-sessions');
}

function ensureDirs(sessionsDir) {
  mkdirSync(join(sessionsDir, 'raw'), { recursive: true });
  mkdirSync(join(sessionsDir, 'sessions'), { recursive: true });
}

function appendJsonl(filepath, entry) {
  appendFileSync(filepath, JSON.stringify(entry) + '\n', 'utf8');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function localDateTime() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function localTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function handleSessionStart(input, sessionsDir) {
  const sessionId = sanitizeSessionId(input.session_id);
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'session_start',
    session_id: sessionId,
    source: input.session_start_source || 'startup',
    cwd: input.cwd || '',
  };
  appendJsonl(join(sessionsDir, 'raw', `${sessionId}.jsonl`), entry);
  appendFileSync(
    join(sessionsDir, 'log.md'),
    `- [${localDateTime()}] SESSION ${sessionId.slice(0, 8)} started (${entry.source})\n`,
    'utf8'
  );
}

function handleUserPrompt(input, sessionsDir) {
  const sessionId = sanitizeSessionId(input.session_id);
  const prompt = input.prompt || '';
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'user_prompt',
    session_id: sessionId,
    prompt: prompt.slice(0, 2000),
  };
  appendJsonl(join(sessionsDir, 'raw', `${sessionId}.jsonl`), entry);
  const shortPrompt = prompt.slice(0, 120).replace(/\n/g, ' ').trim();
  appendFileSync(
    join(sessionsDir, 'log.md'),
    `- [${localTime()}] PROMPT: ${shortPrompt}\n`,
    'utf8'
  );
}

function handlePostToolUse(input, sessionsDir) {
  const sessionId = sanitizeSessionId(input.session_id);
  const toolName = input.tool_name || 'unknown';
  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response || '';

  let summary = '';
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    summary = `Modified ${basename(toolInput.file_path || '')}`;
  } else if (toolName === 'Read') {
    summary = `Read ${basename(toolInput.file_path || '')}`;
  } else if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '').slice(0, 200);
    summary = `Ran: ${cmd}`;
  } else if (toolName === 'Grep' || toolName === 'Glob') {
    summary = `Searched: ${toolInput.pattern || ''}`;
  } else {
    summary = `Used ${toolName}`;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    event: 'tool_use',
    session_id: sessionId,
    tool_name: toolName,
    summary,
    input_preview: JSON.stringify(toolInput).slice(0, 500),
    response_preview: toolResponse ? String(toolResponse).slice(0, 500) : '',
  };
  appendJsonl(join(sessionsDir, 'raw', `${sessionId}.jsonl`), entry);
}

function handleStop(input, sessionsDir) {
  const sessionId = sanitizeSessionId(input.session_id);
  appendJsonl(join(sessionsDir, 'raw', `${sessionId}.jsonl`), {
    timestamp: new Date().toISOString(),
    event: 'stop',
    session_id: sessionId,
  });
}

function handleSessionEnd(input, sessionsDir) {
  const sessionId = sanitizeSessionId(input.session_id);
  appendJsonl(join(sessionsDir, 'raw', `${sessionId}.jsonl`), {
    timestamp: new Date().toISOString(),
    event: 'session_end',
    session_id: sessionId,
  });
  appendFileSync(
    join(sessionsDir, 'log.md'),
    `- [${localTime()}] SESSION ${sessionId.slice(0, 8)} ended\n`,
    'utf8'
  );
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPrompt,
  PostToolUse: handlePostToolUse,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
};

function readStdin() {
  return new Promise((resolveStdin) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', () => resolveStdin(''));
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    const event = input.hook_event_name || '';
    const sessionsDir = getSessionsDir();
    ensureDirs(sessionsDir);
    const handler = HANDLERS[event];
    if (handler) handler(input, sessionsDir);
  } catch {
    // NEVER crash, NEVER block
  }
  process.exit(0);
}

main();
