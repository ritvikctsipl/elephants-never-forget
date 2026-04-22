/**
 * Elephants Never Forget — PreCompact Warning
 *
 * Outputs a warning to stdout so Claude knows context is about to compress.
 * Also logs the event to the raw JSONL.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function sanitizeSessionId(sid) {
  const cleaned = String(sid || '').replace(/[^a-zA-Z0-9-]/g, '');
  return cleaned || 'unknown';
}

function pad2(n) { return String(n).padStart(2, '0'); }

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
    const input = raw ? JSON.parse(raw) : {};
    const sessionId = sanitizeSessionId(input.session_id);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionsDir = join(projectDir, '.claude-sessions');

    const rawDir = join(sessionsDir, 'raw');
    mkdirSync(rawDir, { recursive: true });
    const rawPath = join(rawDir, `${sessionId}.jsonl`);
    appendFileSync(rawPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'pre_compact',
      session_id: sessionId,
    }) + '\n', 'utf8');

    const d = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    appendFileSync(
      join(sessionsDir, 'log.md'),
      `- [${hm}] COMPACT: Context compaction triggered for ${sessionId.slice(0, 8)}\n`,
      'utf8'
    );

    process.stdout.write('ELEPHANTS NEVER FORGET: Context compaction is about to occur.\n');
    process.stdout.write(`Session: ${sessionId.slice(0, 8)}\n`);
    process.stdout.write('ACTION REQUIRED: Update your session file NOW before context is lost.\n');
    process.stdout.write('File: .claude-sessions/sessions/ (find today\'s session file)\n');
  } catch {
    // swallow
  }
  process.exit(0);
}

main();
