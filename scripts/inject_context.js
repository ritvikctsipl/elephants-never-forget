/**
 * Elephants Never Forget — SessionStart Context Injector
 *
 * Reads index.md, decisions.md, and the most recent session files from
 * .claude-sessions/ and outputs them as context for Claude.
 *
 * Output goes to stdout and is injected into Claude's context window.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function readFileSafe(path, maxChars = 4000) {
  try {
    const full = readFileSync(path, 'utf8');
    const head = full.slice(0, maxChars + 200);
    if (head.length > maxChars) {
      let truncated = head.slice(0, maxChars);
      const lastNl = truncated.lastIndexOf('\n');
      if (lastNl > 0) truncated = truncated.slice(0, lastNl);
      return truncated + '\n... (truncated — read full file for more)';
    }
    return head;
  } catch {
    return '';
  }
}

function getRecentSessions(sessionsDir, maxFiles = 3, maxCharsEach = 2700) {
  const dir = join(sessionsDir, 'sessions');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
  const results = [];
  for (const fname of files.slice(0, maxFiles)) {
    const content = readFileSafe(join(dir, fname), maxCharsEach);
    if (content) {
      results.push(`### ${fname}\n${content}`);
    }
  }
  return results;
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
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionsDir = join(projectDir, '.claude-sessions');
    const sessionId = input.session_id || 'unknown';

    const indexContent = readFileSafe(join(sessionsDir, 'index.md'));
    const decisionsContent = readFileSafe(join(sessionsDir, 'decisions.md'));
    const recentSessions = getRecentSessions(sessionsDir);

    if (!indexContent && !decisionsContent && recentSessions.length === 0) {
      process.exit(0);
      return;
    }

    const parts = [];
    parts.push('=== ELEPHANTS NEVER FORGET: Cross-Session Context ===');
    parts.push(`Current session: ${String(sessionId).slice(0, 8)}`);
    parts.push('');

    if (indexContent) {
      parts.push('## Session Index');
      parts.push(indexContent);
      parts.push('');
    }

    if (decisionsContent) {
      parts.push('## Standing Decisions');
      parts.push(decisionsContent);
      parts.push('');
    }

    if (recentSessions.length > 0) {
      parts.push('## Recent Sessions (Hot Tier — last 3)');
      for (const s of recentSessions) parts.push(s);
      parts.push('');
    }

    parts.push('---');
    parts.push('Use the elephants-never-forget skill to maintain this session\'s log.');

    process.stdout.write(parts.join('\n') + '\n');
  } catch {
    // swallow
  }
  process.exit(0);
}

main();
