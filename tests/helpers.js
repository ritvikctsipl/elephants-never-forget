import { writeFileSync, mkdirSync, closeSync, openSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export function setupProjectDir() {
  const projectDir = mkdtempSync(join(tmpdir(), 'enf-test-'));
  const sessionsDir = join(projectDir, '.claude-sessions');
  for (const sub of ['sessions', 'raw', '.opt-out', '.active']) {
    mkdirSync(join(sessionsDir, sub), { recursive: true });
  }
  return {
    projectDir,
    sessionsDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

export function makeSessionFile(sessionsDir, dateStr, slug, {
  sessionId = 'a1b2c3d4',
  tags = ['test'],
  status = 'completed',
} = {}) {
  const content =
    `---\n` +
    `session_id: ${sessionId}\n` +
    `date: ${dateStr}\n` +
    `start_time: "10:00"\n` +
    `tags: [${tags.join(', ')}]\n` +
    `status: ${status}\n` +
    `summary: "Test session"\n` +
    `---\n\n## Intent\nTest intent.\n`;
  const path = join(sessionsDir, 'sessions', `${dateStr}-${slug}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
}

export function makeOptOutMarker(sessionsDir, sessionId) {
  const path = join(sessionsDir, '.opt-out', sessionId);
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'w'));
  return path;
}

export function makeActiveMarker(sessionsDir, sessionId) {
  const path = join(sessionsDir, '.active', sessionId);
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'w'));
  return path;
}

export function makeSyntheticTranscript(path, {
  sessionId,
  numTurns = 5,
  inputTokensPerTurn = 1000,
  outputTokensPerTurn = 500,
  cacheReadTokens = 200,
  cacheCreationTokens = 100,
  model = 'claude-opus-4-7',
  compactionAt = null,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const t0 = new Date(Date.UTC(2026, 3, 17, 10, 0, 0));
  const lines = [];
  for (let i = 0; i < numTurns; i++) {
    const ts = new Date(t0.getTime() + i * 30_000).toISOString();
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: ts,
      sessionId,
      message: { role: 'user', content: `prompt ${i}` },
    }));
    const assistantTs = new Date(t0.getTime() + i * 30_000 + 5_000).toISOString();
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: assistantTs,
      sessionId,
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text: `reply ${i}` }],
        usage: {
          input_tokens: inputTokensPerTurn,
          output_tokens: outputTokensPerTurn,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
        },
      },
    }));
    if (compactionAt !== null && i === compactionAt) {
      lines.push(JSON.stringify({
        type: 'system',
        timestamp: assistantTs,
        sessionId,
        subtype: 'compact_boundary',
      }));
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}
