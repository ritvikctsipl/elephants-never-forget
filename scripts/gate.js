/**
 * Elephants Never Forget — Hard Gate.
 *
 * Runs on UserPromptSubmit and PreToolUse. Fails open on any error (default allow).
 * Hot-path target: <10ms per invocation when today's session file exists.
 */
import { readdirSync, readFileSync, mkdirSync, appendFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

const HEARTBEAT_THRESHOLD = 5;
const HEARTBEAT_COUNT_CAP = HEARTBEAT_THRESHOLD + 1;

export function sanitizeSessionId(sid) {
  const cleaned = String(sid || '').replace(/[^a-zA-Z0-9-]/g, '');
  return cleaned || 'unknown';
}

function getSessionsDir() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude-sessions');
}

function dateNDaysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return dateNDaysAgoStr(0);
}

function parseSessionIdFromFile(filepath) {
  try {
    const content = readFileSync(filepath, 'utf8');
    if (!content.startsWith('---\n')) return null;
    const fmEnd = content.indexOf('\n---', 4);
    if (fmEnd === -1) return null;
    const fm = content.slice(4, fmEnd);
    const m = fm.match(/^session_id:\s*([a-zA-Z0-9-]+)\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function findSessionFileForSession(sessionsDir, sessionId) {
  const sid8 = sanitizeSessionId(sessionId).slice(0, 8);
  if (!sid8 || sid8 === 'unknown') return null;
  const sessionsSub = join(sessionsDir, 'sessions');
  let files;
  try {
    files = readdirSync(sessionsSub);
  } catch {
    return null;
  }
  // Scan today + yesterday to cover cross-midnight resume; bounded for hot-path.
  const today = todayStr();
  const yesterday = dateNDaysAgoStr(1);
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    if (!(f.startsWith(`${today}-`) || f.startsWith(`${yesterday}-`))) continue;
    const path = join(sessionsSub, f);
    const fileSid = parseSessionIdFromFile(path);
    if (fileSid && fileSid.slice(0, 8) === sid8) return { path, fname: f };
  }
  return null;
}

export function sessionFileExistsForSession(sessionsDir, sessionId) {
  return findSessionFileForSession(sessionsDir, sessionId) != null;
}

function getSessionFileMtimeMs(filepath) {
  try { return statSync(filepath).mtimeMs; }
  catch { return null; }
}

function countUserPromptsSince(jsonlPath, sinceMs, cap) {
  let content;
  try { content = readFileSync(jsonlPath, 'utf8'); } catch { return 0; }
  let count = 0;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.event !== 'user_prompt') continue;
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts)) continue;
    if (ts > sinceMs) {
      count++;
      if (count >= cap) return count;
    }
  }
  return count;
}

function heartbeatTemplate(filename, count) {
  return `<system-reminder>
ELEPHANTS NEVER FORGET — HEARTBEAT

Your session file (.claude-sessions/sessions/${filename}) has not been updated
in ${count} user prompts. Per the elephants-never-forget skill, you should
update the session log every 5–10 interactions at natural breakpoints.

Take a moment now to:
- Append recent significant interactions to the Interactions section (not every
  tool call — only ones a future session would care about)
- Capture decisions made (Y-statements; also append to decisions.md if standing)
- Add to Files Touched, Errors & Fixes, Friction Events as applicable

This is advisory, not a deny. Continue with the user's request after updating.
</system-reminder>`;
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

No session file exists for THIS session (id ${sessionIdPrefix}) on ${today}. Another
session's file dated today does NOT satisfy the gate — every Claude Code session
needs its own file with matching \`session_id\` in the frontmatter. Before
responding to this prompt, you MUST:

1. Create \`.claude-sessions/sessions/${today}-<slug>.md\` where \`<slug>\` is a
   2-5 word kebab-case summary of the session's intent. Slug rules: only
   \`[a-z0-9-]\`, maximum 40 characters. Same-day collision? Append \`-<first-4-chars-of-session-id>\`.

2. Write the required frontmatter — \`session_id: ${sessionIdPrefix}\` MUST match
   this session — plus date, start_time, tags, status: active, summary, and an
   \`## Intent\` section.

3. Optionally create an empty marker at \`.claude-sessions/.active/${sessionIdPrefix}\`.

If the user said "don't track this session", instead create an empty marker at
\`.claude-sessions/.opt-out/${sessionIdPrefix}\` — that satisfies the gate.

Until your session file (or opt-out marker) exists, PreToolUse will deny any tool
call other than a Write into .claude-sessions/sessions/ or .claude-sessions/.opt-out/.
</system-reminder>`;
}

function denyReason(today, sessionIdPrefix) {
  return (
    `No session file exists for THIS session (id ${sessionIdPrefix}) on ${today}. ` +
    `Another session's file dated today does NOT satisfy the Elephants Never Forget ` +
    `gate. Create \`.claude-sessions/sessions/${today}-<slug>.md\` with frontmatter ` +
    `\`session_id: ${sessionIdPrefix}\`, OR create \`.claude-sessions/.opt-out/${sessionIdPrefix}\` ` +
    `to opt out of tracking for this session.`
  );
}

function handleUserPromptSubmit(input, sessionsDir) {
  const sessionId = input.session_id || 'unknown';
  const match = findSessionFileForSession(sessionsDir, sessionId);
  if (match) {
    try {
      const mtimeMs = getSessionFileMtimeMs(match.path);
      if (mtimeMs == null) return;
      const sid = sanitizeSessionId(sessionId);
      const jsonlPath = join(sessionsDir, 'raw', `${sid}.jsonl`);
      const count = countUserPromptsSince(jsonlPath, mtimeMs, HEARTBEAT_COUNT_CAP);
      if (count >= HEARTBEAT_THRESHOLD) {
        process.stdout.write(heartbeatTemplate(match.fname, count) + '\n');
        logGateDecision(sessionId, 'UserPromptSubmit', 'heartbeat', `stale:${count}`, sessionsDir);
      }
    } catch {
      // fail-open: any heartbeat error must not surface to the user
    }
    return;
  }
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

  if (sessionFileExistsForSession(sessionsDir, sessionId)) return;
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
