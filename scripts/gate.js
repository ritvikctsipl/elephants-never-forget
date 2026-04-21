/**
 * Elephants Never Forget — Hard Gate.
 *
 * Runs on UserPromptSubmit and PreToolUse. Fails open on any error (default allow).
 * Hot-path target: <10ms per invocation when today's session file exists.
 */
import { readdirSync, mkdirSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

export function sanitizeSessionId(sid) {
  const cleaned = String(sid || '').replace(/[^a-zA-Z0-9-]/g, '');
  return cleaned || 'unknown';
}

function getSessionsDir() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude-sessions');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sessionFileExistsToday(sessionsDir) {
  const prefix = `${todayStr()}-`;
  try {
    const files = readdirSync(join(sessionsDir, 'sessions'));
    return files.some((f) => f.startsWith(prefix) && f.endsWith('.md'));
  } catch {
    return false;
  }
}

export function optOutMarkerExists(sessionId, sessionsDir) {
  const sid = sanitizeSessionId(sessionId);
  return existsSync(join(sessionsDir, '.opt-out', sid));
}

function logGateDecision(sessionId, event, decision, reason, sessionsDir) {
  try {
    const sid = sanitizeSessionId(sessionId);
    const rawDir = join(sessionsDir, 'raw');
    mkdirSync(rawDir, { recursive: true });
    const rawPath = join(rawDir, `${sid}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      event: 'gate_decision',
      hook_event: event,
      session_id: sid,
      decision,
      reason,
    };
    appendFileSync(rawPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // best-effort; never crash
  }
}

function reminderTemplate(today, sessionIdPrefix) {
  return `<system-reminder>
ELEPHANTS NEVER FORGET — SESSION GATE

No session file exists for today (${today}). Before responding to this prompt,
you MUST:

1. Create \`.claude-sessions/sessions/${today}-<slug>.md\` where \`<slug>\` is a
   2-5 word kebab-case summary of the session's intent. Slug rules: only
   \`[a-z0-9-]\`, maximum 40 characters. Same-day collision? Append \`-<first-4-chars-of-session-id>\`.

2. Write the required frontmatter (session_id, date, start_time, tags,
   status: active, summary) and an \`## Intent\` section.

3. Optionally create an empty marker at \`.claude-sessions/.active/${sessionIdPrefix}\`.

If the user said "don't track this session", instead create an empty marker at
\`.claude-sessions/.opt-out/${sessionIdPrefix}\` — that satisfies the gate.

Until one of these files exists, PreToolUse will deny any tool call other than
a Write into .claude-sessions/sessions/ or .claude-sessions/.opt-out/.
</system-reminder>`;
}

function denyReason(today, sessionIdPrefix) {
  return (
    `No session file exists for today (${today}). The Elephants Never Forget gate is ` +
    `blocking this tool call. Create \`.claude-sessions/sessions/${today}-<slug>.md\` ` +
    `first, OR create \`.claude-sessions/.opt-out/${sessionIdPrefix}\` to opt out of ` +
    `tracking for this session.`
  );
}

function handleUserPromptSubmit(input, sessionsDir) {
  const sessionId = input.session_id || 'unknown';
  if (sessionFileExistsToday(sessionsDir)) return;
  if (optOutMarkerExists(sessionId, sessionsDir)) return;
  const sidPrefix = sanitizeSessionId(sessionId).slice(0, 8);
  const today = todayStr();
  process.stdout.write(reminderTemplate(today, sidPrefix) + '\n');
  logGateDecision(sessionId, 'UserPromptSubmit', 'reminder', 'no_session_file', sessionsDir);
}

function isWriteUnder(toolName, toolInput, ...allowedPrefixes) {
  if (toolName !== 'Write') return false;
  const fp = toolInput && typeof toolInput === 'object' ? toolInput.file_path : '';
  if (!fp) return false;
  const fpAbs = resolve(String(fp));
  for (const prefix of allowedPrefixes) {
    const prefixAbs = resolve(prefix);
    if (fpAbs === prefixAbs || fpAbs.startsWith(prefixAbs + sep)) return true;
  }
  return false;
}

function handlePreToolUse(input, sessionsDir) {
  const sessionId = input.session_id || 'unknown';
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (sessionFileExistsToday(sessionsDir)) return;
  if (optOutMarkerExists(sessionId, sessionsDir)) return;

  const sessionsSub = join(sessionsDir, 'sessions');
  const optOutSub = join(sessionsDir, '.opt-out');
  if (isWriteUnder(toolName, toolInput, sessionsSub, optOutSub)) return;

  const sidPrefix = sanitizeSessionId(sessionId).slice(0, 8);
  const today = todayStr();
  const payload = { decision: 'deny', reason: denyReason(today, sidPrefix) };
  process.stdout.write(JSON.stringify(payload) + '\n');
  logGateDecision(sessionId, 'PreToolUse', 'deny', toolName, sessionsDir);
}

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
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }
  const event = input.hook_event_name || '';
  const sessionsDir = getSessionsDir();
  try {
    if (event === 'UserPromptSubmit') handleUserPromptSubmit(input, sessionsDir);
    else if (event === 'PreToolUse') handlePreToolUse(input, sessionsDir);
  } catch {
    // swallow
  }
  process.exit(0);
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
