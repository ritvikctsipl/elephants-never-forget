import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tp from '../scripts/transcript_parser.js';
import { makeSyntheticTranscript } from './helpers.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'enf-tp-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parse_transcript missing file returns empty', () => {
  assert.deepEqual(tp.parseTranscript('/no/such/path.jsonl'), {});
});

test('parse_transcript well formed', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 'sid', numTurns: 3 });
    const r = tp.parseTranscript(path);
    assert.notDeepEqual(r, {});
    assert.equal(r.messages.length, 6);
    assert.equal(r.usage_per_message.length, 3);
    assert.equal(r.model, 'claude-opus-4-7');
  } finally { cleanup(); }
});

test('parse_transcript skips malformed lines', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    writeFileSync(
      path,
      '{"type": "user", "sessionId": "s", "message": {}}\n' +
      'not-json\n' +
      '{"type": "assistant", "sessionId": "s", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}}\n'
    );
    const r = tp.parseTranscript(path);
    assert.equal(r.messages.length, 2);
    assert.equal(r.usage_per_message.length, 1);
  } finally { cleanup(); }
});

test('find_transcript_path returns null for unknown', () => {
  const { dir, cleanup } = tmp();
  try {
    assert.equal(tp.findTranscriptPath('nonexistent-session', dir), null);
  } finally { cleanup(); }
});

test('compute_usage_totals basic', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, {
      sessionId: 's',
      numTurns: 3,
      inputTokensPerTurn: 1000,
      outputTokensPerTurn: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    });
    const t = tp.parseTranscript(path);
    const totals = tp.computeUsageTotals(t);
    assert.equal(totals.input, 3000);
    assert.equal(totals.output, 1500);
    assert.equal(totals.cache_read, 600);
    assert.equal(totals.cache_creation, 300);
    assert.equal(totals.total, 3000 + 1500 + 600 + 300);
    assert.ok(totals.cache_hit_rate > 10 && totals.cache_hit_rate < 20);
  } finally { cleanup(); }
});

test('compute_usage_totals empty', () => {
  assert.deepEqual(tp.computeUsageTotals({}), {
    input: 0, output: 0, cache_read: 0, cache_creation: 0,
    total: 0, cache_hit_rate: 0.0,
  });
});

test('estimate_cost known model', () => {
  const r = tp.estimateCost(
    { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_creation: 0 },
    'claude-opus-4-7'
  );
  assert.ok(r.cost_usd !== null && r.cost_usd > 0);
  assert.equal(r.model, 'claude-opus-4-7');
  assert.equal(r.pricing_version, 'v1');
  assert.ok(r.disclaimer.includes('rates as of'));
});

test('estimate_cost unknown model', () => {
  const r = tp.estimateCost(
    { input: 1000, output: 500, cache_read: 0, cache_creation: 0 },
    'claude-future-x-0'
  );
  assert.equal(r.cost_usd, null);
  assert.ok(r.disclaimer.toLowerCase().includes('unknown model'));
});

test('estimate_cost null model', () => {
  const r = tp.estimateCost(
    { input: 1000, output: 500, cache_read: 0, cache_creation: 0 },
    null
  );
  assert.equal(r.cost_usd, null);
});

test('compute_pacing basic', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 4 });
    const t = tp.parseTranscript(path);
    const p = tp.computePacing(t);
    assert.ok(p.inter_turn_median_ms > 0);
    assert.ok(p.inter_turn_p95_ms >= p.inter_turn_median_ms);
    assert.ok(Array.isArray(p.idle_gaps_sec));
  } finally { cleanup(); }
});

test('compute_pacing empty', () => {
  const p = tp.computePacing({});
  assert.equal(p.inter_turn_median_ms, 0);
  assert.equal(p.inter_turn_p95_ms, 0);
  assert.deepEqual(p.idle_gaps_sec, []);
  assert.deepEqual(p.prompt_to_first_tool_ms, []);
});

test('compute_context_pressure known model', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 5, compactionAt: 2 });
    const t = tp.parseTranscript(path);
    const pr = tp.computeContextPressure(t, 'claude-opus-4-7');
    assert.equal(pr.window_tokens, 200_000);
    assert.equal(pr.compaction_count, 1);
    assert.ok(pr.max_utilization_pct !== null);
    assert.ok(pr.max_utilization_pct >= 0 && pr.max_utilization_pct <= 100);
  } finally { cleanup(); }
});

test('compute_context_pressure unknown model', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 2 });
    const t = tp.parseTranscript(path);
    const pr = tp.computeContextPressure(t, 'claude-future-x-0');
    assert.equal(pr.window_tokens, null);
    assert.equal(pr.max_utilization_pct, null);
  } finally { cleanup(); }
});
