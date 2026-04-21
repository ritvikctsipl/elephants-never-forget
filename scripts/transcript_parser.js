/**
 * Elephants Never Forget — Transcript Parser.
 *
 * Pure, stateless module that reads a Claude Code transcript JSONL and computes
 * derived metrics (token usage, cost estimate, inter-turn pacing, context pressure).
 *
 * Runtime: stdlib only. Defensive: never throws; returns {} or null on failure.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export const PRICING_TABLE_V1 = Object.freeze({
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cache_read: 1.50, cache_creation: 18.75 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00, cache_read: 1.50, cache_creation: 18.75 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cache_read: 0.30, cache_creation:  3.75 },
  'claude-sonnet-4-5': { input:  3.00, output: 15.00, cache_read: 0.30, cache_creation:  3.75 },
  'claude-haiku-4-5':  { input:  0.80, output:  4.00, cache_read: 0.08, cache_creation:  1.00 },
});

export const PRICING_AS_OF = '2026-01';

export const MODEL_WINDOWS = Object.freeze({
  'claude-opus-4-7':   200_000,
  'claude-opus-4-6':   200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5':  200_000,
});

function normalizeModel(model) {
  if (!model) return null;
  let m = String(model).toLowerCase().trim();
  if (m.includes('[')) m = m.split('[', 1)[0];
  const lastDash = m.lastIndexOf('-');
  if (lastDash > 0) {
    const tail = m.slice(lastDash + 1);
    if (tail.length === 8 && /^\d+$/.test(tail)) {
      m = m.slice(0, lastDash);
    }
  }
  return m;
}

function parseTimestamp(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0.0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.round((p / 100) * (sortedValues.length - 1))
  );
  return sortedValues[idx];
}

export function parseTranscript(path) {
  if (!path) return {};
  try {
    if (!statSync(path).isFile()) return {};
  } catch {
    return {};
  }
  try {
    const content = readFileSync(path, 'utf8');
    const messages = [];
    const usage_per_message = [];
    const tool_uses = [];
    const compactions = [];
    let model = null;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      messages.push(entry);
      const msg = (entry.message && typeof entry.message === 'object') ? entry.message : {};
      if (msg.usage) {
        usage_per_message.push({ timestamp: entry.timestamp, usage: msg.usage });
      }
      if (!model && msg.model) model = msg.model;
      const content2 = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content2) {
        if (c && typeof c === 'object' && c.type === 'tool_use') {
          tool_uses.push({ timestamp: entry.timestamp, name: c.name, input: c.input });
        }
      }
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        compactions.push({ timestamp: entry.timestamp });
      }
    }
    return { messages, usage_per_message, tool_uses, compactions, model };
  } catch {
    return {};
  }
}

export function findTranscriptPath(sessionId, cwd = null) {
  if (!sessionId) return null;
  const home = homedir();
  const projectsRoot = join(home, '.claude', 'projects');
  try {
    if (!statSync(projectsRoot).isDirectory()) return null;
  } catch {
    return null;
  }

  if (cwd) {
    let encoded = String(cwd).split(sep).join('-');
    if (!encoded.startsWith('-')) encoded = '-' + encoded;
    const direct = join(projectsRoot, encoded, `${sessionId}.jsonl`);
    try {
      if (statSync(direct).isFile()) return direct;
    } catch {}
  }

  try {
    const entries = readdirSync(projectsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = join(projectsRoot, e.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function computeUsageTotals(transcript) {
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const entries = (transcript && transcript.usage_per_message) || [];
  for (const e of entries) {
    const u = e.usage || {};
    totals.input += parseInt(u.input_tokens || 0, 10) || 0;
    totals.output += parseInt(u.output_tokens || 0, 10) || 0;
    totals.cache_read += parseInt(u.cache_read_input_tokens || 0, 10) || 0;
    totals.cache_creation += parseInt(u.cache_creation_input_tokens || 0, 10) || 0;
  }
  const total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
  const denom = totals.cache_read + totals.input;
  const cache_hit_rate = denom > 0
    ? Math.round((totals.cache_read / denom) * 100 * 100) / 100
    : 0.0;
  return { ...totals, total, cache_hit_rate };
}

export function estimateCost(usage, model = null) {
  const normalized = normalizeModel(model);
  const pricing = normalized ? PRICING_TABLE_V1[normalized] : null;
  if (!pricing) {
    return {
      cost_usd: null,
      disclaimer: `Unknown model '${model}'. Cost cannot be estimated.`,
      model,
      pricing_version: 'v1',
    };
  }
  const cost =
    ((usage.input || 0) * pricing.input +
      (usage.output || 0) * pricing.output +
      (usage.cache_read || 0) * pricing.cache_read +
      (usage.cache_creation || 0) * pricing.cache_creation) /
    1_000_000;
  return {
    cost_usd: Math.round(cost * 10_000) / 10_000,
    disclaimer: `Estimate based on public rates as of ${PRICING_AS_OF}; may drift.`,
    model,
    pricing_version: 'v1',
  };
}

export function computePacing(transcript) {
  const messages = (transcript && transcript.messages) || [];
  const deltasMs = [];
  const idleGaps = [];
  let prev = null;
  for (const m of messages) {
    const ts = parseTimestamp(m.timestamp);
    if (ts === null) continue;
    if (prev !== null) {
      const deltaSec = (ts.getTime() - prev.getTime()) / 1000;
      deltasMs.push(deltaSec * 1000);
      if (deltaSec > 60) idleGaps.push(Math.round(deltaSec * 10) / 10);
    }
    prev = ts;
  }

  const toolUses = (transcript && transcript.tool_uses) || [];
  const userTimestamps = messages
    .filter((m) => m.type === 'user')
    .map((m) => parseTimestamp(m.timestamp))
    .filter((t) => t !== null);

  const promptToTool = [];
  for (const uTs of userTimestamps) {
    const following = toolUses
      .map((t) => parseTimestamp(t.timestamp))
      .filter((t) => t !== null && t.getTime() > uTs.getTime());
    if (following.length > 0) {
      const earliest = following.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
      const deltaS = (earliest.getTime() - uTs.getTime()) / 1000;
      promptToTool.push(Math.round(deltaS * 1000 * 10) / 10);
    }
  }

  const sorted = [...deltasMs].sort((a, b) => a - b);
  return {
    inter_turn_median_ms: Math.round(percentile(sorted, 50) * 10) / 10,
    inter_turn_p95_ms: Math.round(percentile(sorted, 95) * 10) / 10,
    idle_gaps_sec: idleGaps,
    prompt_to_first_tool_ms: promptToTool,
  };
}

export function computeContextPressure(transcript, model = null) {
  const normalized = normalizeModel(model);
  const window = normalized ? MODEL_WINDOWS[normalized] : null;
  const compactions = (transcript && transcript.compactions) || [];
  const compactionCount = compactions.length;

  if (window == null) {
    return {
      window_tokens: null,
      max_utilization_pct: null,
      compaction_count: compactionCount,
      utilization_trend: [],
    };
  }

  const compactTs = compactions
    .map((c) => c.timestamp)
    .filter((t) => t)
    .sort();
  let running = 0;
  let maxLoad = 0;
  const trend = [];
  let nextCompactIdx = 0;
  const usages = (transcript && transcript.usage_per_message) || [];
  for (const entry of usages) {
    const ts = entry.timestamp;
    if (
      nextCompactIdx < compactTs.length &&
      ts &&
      ts >= compactTs[nextCompactIdx]
    ) {
      running = 0;
      nextCompactIdx += 1;
    }
    const u = entry.usage || {};
    running +=
      (parseInt(u.input_tokens || 0, 10) || 0) +
      (parseInt(u.cache_read_input_tokens || 0, 10) || 0);
    if (running > maxLoad) maxLoad = running;
    const pct = Math.round((running / window) * 100 * 100) / 100;
    trend.push([ts, pct]);
  }

  return {
    window_tokens: window,
    max_utilization_pct: Math.round((maxLoad / window) * 100 * 100) / 100,
    compaction_count: compactionCount,
    utilization_trend: trend,
  };
}
