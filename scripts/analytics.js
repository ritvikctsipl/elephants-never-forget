/**
 * Elephants Never Forget — Analytics Engine
 *
 * Parses .claude-sessions/ data and computes metrics about session patterns,
 * decision quality, and collaboration habits.
 *
 * Usage:
 *   node scripts/analytics.js [--project-dir PATH] [--format json|markdown]
 *
 * Default: reads from CLAUDE_PROJECT_DIR or cwd, outputs markdown.
 */
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import {
  findTranscriptPath,
  parseTranscript,
  computeUsageTotals,
  estimateCost,
  computePacing,
  computeContextPressure,
} from './transcript_parser.js';

// ── Unicode chart helpers ──────────────────────────────────────────────

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

export function sparkline(values) {
  if (!values || !values.length) return '';
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const rng = mx - mn || 1;
  return values
    .map((v) => SPARK_CHARS[Math.min(7, Math.floor(((v - mn) / rng) * 7))])
    .join('');
}

export function bar(value, maxValue, width = 16) {
  if (maxValue === 0) return BLOCK_EMPTY.repeat(width);
  const filled = Math.floor((value / maxValue) * width);
  return BLOCK_FULL.repeat(filled) + BLOCK_EMPTY.repeat(width - filled);
}

export function pct(n, d) {
  if (d === 0) return 0.0;
  return Math.round((n / d) * 100 * 10) / 10;
}

// ── Frontmatter + file parsers ─────────────────────────────────────────

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return [{}, content];
  const end = content.indexOf('---', 3);
  if (end === -1) return [{}, content];
  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();

  const fm = {};
  for (const line of fmText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((t) => {
          let tok = t.trim();
          if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.slice(1, -1);
          else if (tok.startsWith("'") && tok.endsWith("'")) tok = tok.slice(1, -1);
          return tok;
        });
    }
    fm[key] = val;
  }
  return [fm, body];
}

function parseSessionFile(filepath) {
  let content;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    return null;
  }
  const [fm, body] = parseFrontmatter(content);
  const session = {
    file: basename(filepath),
    session_id: fm.session_id || '',
    date: fm.date || '',
    start_time: fm.start_time || '',
    tags: fm.tags || [],
    status: fm.status || '',
    summary: fm.summary || '',
    decisions: [],
    reversals: [],
    errors: [],
    friction_events: [],
    files_touched: [],
    open_items: [],
  };

  let currentSection = null;
  for (const rawLine of body.split('\n')) {
    const stripped = rawLine.trim();
    if (stripped.startsWith('## ')) {
      currentSection = stripped.slice(3).toLowerCase();
    } else if (currentSection === 'decisions' && stripped.startsWith('- ')) {
      session.decisions.push(stripped.slice(2));
    } else if (currentSection === 'reversals' && stripped.startsWith('- ')) {
      session.reversals.push(stripped.slice(2));
    } else if (
      (currentSection === 'errors & fixes' || currentSection === 'errors and fixes') &&
      stripped.startsWith('- ')
    ) {
      session.errors.push(stripped.slice(2));
    } else if (currentSection === 'friction events' && stripped.startsWith('- ')) {
      session.friction_events.push(stripped.slice(2));
    } else if (currentSection === 'files touched' && stripped.startsWith('- ')) {
      session.files_touched.push(stripped.slice(2));
    } else if (currentSection === 'open items' && stripped.startsWith('- [')) {
      const done = stripped[3] === 'x';
      session.open_items.push({ text: stripped.slice(6), done });
    }
  }
  return session;
}

function parseDecisionsFile(filepath) {
  let content;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    return [];
  }
  const decisions = [];
  let currentTopic = '';
  for (const rawLine of content.split('\n')) {
    const stripped = rawLine.trim();
    if (stripped.startsWith('## ')) {
      currentTopic = stripped.slice(3);
    } else if (stripped.startsWith('- [') && !stripped.startsWith('- ~~')) {
      const dateMatch = stripped.match(/^- \[(\d{4}-\d{2}-\d{2})\]/);
      const isSuperseded = stripped.includes('SUPERSEDED');
      let confidence = 'unknown';
      for (const level of ['high', 'medium', 'low']) {
        if (stripped.includes(`Confidence: ${level}`)) {
          confidence = level;
          break;
        }
      }
      decisions.push({
        topic: currentTopic,
        date: dateMatch ? dateMatch[1] : '',
        text: stripped,
        confidence,
        superseded: isSuperseded,
      });
    } else if (stripped.startsWith('- ~~') && stripped.includes('SUPERSEDED')) {
      const dateMatch = stripped.match(/^- ~~\[(\d{4}-\d{2}-\d{2})\]/);
      decisions.push({
        topic: currentTopic,
        date: dateMatch ? dateMatch[1] : '',
        text: stripped,
        confidence: 'unknown',
        superseded: true,
      });
    }
  }
  return decisions;
}

function parseRawJsonl(filepath) {
  const events = [];
  let content;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    return events;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return events;
}

function listMd(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function listJsonl(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// Counter utility — returns object with helpers
function makeCounter() {
  const m = new Map();
  return {
    inc(key, n = 1) {
      m.set(key, (m.get(key) || 0) + n);
    },
    get(key) { return m.get(key) || 0; },
    entries() { return [...m.entries()]; },
    size() { return m.size; },
    values() { return [...m.values()]; },
    mostCommon(n) {
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    },
    toObject() {
      return Object.fromEntries(m);
    },
  };
}

// ── Metric calculations ────────────────────────────────────────────────

export function computeMetrics(sessionsDir) {
  const sessionFiles = listMd(join(sessionsDir, 'sessions'));
  const sessions = [];
  for (const f of sessionFiles) {
    const s = parseSessionFile(f);
    if (s) sessions.push(s);
  }

  const decisions = parseDecisionsFile(join(sessionsDir, 'decisions.md'));
  const rawFiles = listJsonl(join(sessionsDir, 'raw'));
  const sessionEvents = {};
  for (const rf of rawFiles) {
    const events = parseRawJsonl(rf);
    const sid = basename(rf).replace(/\.jsonl$/, '');
    sessionEvents[sid] = events;
  }

  // Basic counts
  const totalSessions = sessions.length;
  const totalDecisions = sessions.reduce((s, x) => s + x.decisions.length, 0);
  const totalReversals = sessions.reduce((s, x) => s + x.reversals.length, 0);
  const totalErrors = sessions.reduce((s, x) => s + x.errors.length, 0);
  const totalFriction = sessions.reduce((s, x) => s + x.friction_events.length, 0);
  const totalFiles = sessions.reduce((s, x) => s + x.files_touched.length, 0);
  const completed = sessions.filter((s) => s.status === 'completed');
  const active = sessions.filter((s) => s.status === 'active');

  // Tags
  const tagCounts = makeCounter();
  for (const s of sessions) {
    if (Array.isArray(s.tags)) {
      for (const t of s.tags) tagCounts.inc(t);
    }
  }

  // Open items
  const allOpen = [];
  for (const s of sessions) allOpen.push(...s.open_items);
  const openDone = allOpen.filter((o) => o.done).length;
  const openTotal = allOpen.length;

  // Confidence distribution
  const confidenceCounts = makeCounter();
  for (const d of decisions) {
    if (!d.superseded) confidenceCounts.inc(d.confidence);
  }

  // Decision stability (>7 days old)
  const today = new Date();
  const activeDecisions = decisions.filter((d) => !d.superseded);
  let stableDecisions = 0;
  for (const d of activeDecisions) {
    if (d.date) {
      const dDate = new Date(d.date + 'T00:00:00');
      if (!Number.isNaN(dDate.getTime())) {
        const days = (today.getTime() - dDate.getTime()) / 86_400_000;
        if (days > 7) stableDecisions += 1;
      }
    }
  }

  // Sessions by date / day of week
  const sessionsByDate = makeCounter();
  const dayOfWeekCounts = makeCounter();
  for (const s of sessions) {
    if (s.date) {
      sessionsByDate.inc(s.date);
      const d = new Date(s.date + 'T00:00:00');
      if (!Number.isNaN(d.getTime())) {
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
        dayOfWeekCounts.inc(day);
      }
    }
  }

  // Tool usage
  const toolCounts = makeCounter();
  const promptCountsPerSession = {};
  for (const [sid, events] of Object.entries(sessionEvents)) {
    const prompts = events.filter((e) => e.event === 'user_prompt').length;
    promptCountsPerSession[sid] = prompts;
    for (const e of events) {
      if (e.event === 'tool_use') toolCounts.inc(e.tool_name || 'unknown');
    }
  }

  // Session durations
  const sessionDurations = [];
  for (const events of Object.values(sessionEvents)) {
    const starts = events.filter((e) => e.event === 'session_start');
    const ends = events.filter((e) => e.event === 'session_end');
    if (starts.length && ends.length) {
      try {
        const tStart = new Date(starts[0].timestamp);
        const tEnd = new Date(ends[ends.length - 1].timestamp);
        if (!Number.isNaN(tStart.getTime()) && !Number.isNaN(tEnd.getTime())) {
          sessionDurations.push((tEnd.getTime() - tStart.getTime()) / 60_000);
        }
      } catch {}
    }
  }

  // Error recurrence (backtick-quoted substrings)
  const errorTexts = [];
  for (const s of sessions) {
    for (const e of s.errors) {
      const m = e.match(/`([^`]+)`/);
      if (m) errorTexts.push(m[1]);
    }
  }
  const errorCounts = makeCounter();
  for (const t of errorTexts) errorCounts.inc(t);
  const recurringErrors = {};
  for (const [k, v] of errorCounts.entries()) {
    if (v > 1) recurringErrors[k] = v;
  }

  // Friction types
  const frictionTypes = makeCounter();
  for (const s of sessions) {
    for (const f of s.friction_events) {
      const lower = f.toLowerCase();
      if (lower.includes('redirected')) frictionTypes.inc('Redirected approach');
      else if (lower.includes('abandoned')) frictionTypes.inc('Abandoned approach');
      else frictionTypes.inc('Other friction');
    }
  }

  // Reversal per topic
  const topicDecisionCounts = makeCounter();
  const topicReversalCounts = makeCounter();
  for (const d of decisions) {
    topicDecisionCounts.inc(d.topic);
    if (d.superseded) topicReversalCounts.inc(d.topic);
  }

  // Prompts per session
  const promptValues = Object.values(promptCountsPerSession);
  const avgPrompts = promptValues.length
    ? Math.round((promptValues.reduce((a, b) => a + b, 0) / promptValues.length) * 10) / 10
    : 0;

  // Session focus
  const focusedSessions = sessions.filter(
    (s) => Array.isArray(s.tags) && s.tags.length <= 3
  ).length;

  const metrics = {
    summary: {
      total_sessions: totalSessions,
      completed_sessions: completed.length,
      active_sessions: active.length,
      total_decisions: totalDecisions,
      total_reversals: totalReversals,
      total_errors: totalErrors,
      total_friction_events: totalFriction,
      total_files_touched: totalFiles,
    },
    planning: {
      reversal_rate: pct(totalReversals, totalDecisions),
      decision_stability: activeDecisions.length ? pct(stableDecisions, activeDecisions.length) : 0,
      confidence_distribution: confidenceCounts.toObject(),
      reversals_by_topic: topicReversalCounts.toObject(),
      decisions_by_topic: topicDecisionCounts.toObject(),
    },
    clarity: {
      friction_rate: pct(totalFriction, totalSessions),
      avg_friction_per_session: totalSessions
        ? Math.round((totalFriction / totalSessions) * 100) / 100
        : 0,
      friction_types: frictionTypes.toObject(),
      avg_prompts_per_session: avgPrompts,
    },
    efficiency: {
      completion_rate: pct(completed.length, totalSessions),
      open_items_completion: pct(openDone, openTotal),
      open_items_pending: openTotal - openDone,
      session_focus_rate: pct(focusedSessions, totalSessions),
      avg_session_duration_min: sessionDurations.length
        ? Math.round((sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length) * 10) / 10
        : 0,
    },
    patterns: {
      top_topics: tagCounts.mostCommon(10),
      top_tools: toolCounts.mostCommon(10),
      sessions_by_day: dayOfWeekCounts.toObject(),
      recurring_errors: recurringErrors,
    },
    trends: {
      sessions_by_date: Object.fromEntries(
        sessionsByDate.entries().sort((a, b) => (a[0] < b[0] ? -1 : 1))
      ),
      session_durations: sessionDurations,
      prompts_per_session: promptValues,
    },
  };

  // v1.1.0: transcript-derived
  const tokensBySid = {};
  const costBySid = {};
  const pacingBySid = {};
  const pressureBySid = {};
  // project root is parent of sessionsDir
  const cwd = dirname(sessionsDir);
  for (const s of sessions) {
    const sid = s.session_id || '';
    if (!sid) continue;
    const tpath = findTranscriptPath(sid, cwd);
    if (!tpath) continue;
    const t = parseTranscript(tpath);
    if (!t || Object.keys(t).length === 0) continue;
    tokensBySid[sid] = computeUsageTotals(t);
    costBySid[sid] = estimateCost(tokensBySid[sid], t.model);
    pacingBySid[sid] = computePacing(t);
    pressureBySid[sid] = computeContextPressure(t, t.model);
  }
  metrics.tokens = tokensBySid;
  metrics.cost = costBySid;
  metrics.pacing = pacingBySid;
  metrics.pressure = pressureBySid;

  return metrics;
}

// ── Insights ───────────────────────────────────────────────────────────

export function generateInsights(metrics) {
  const insights = [];
  const s = metrics.summary;
  const p = metrics.planning;
  const c = metrics.clarity;
  const e = metrics.efficiency;
  const pat = metrics.patterns;

  if (p.reversal_rate > 25) {
    insights.push(
      `**High reversal rate (${p.reversal_rate}%)**: You're reversing 1 in 4 decisions. ` +
      `Consider spending more time on initial requirements before committing to an approach.`
    );
  } else if (p.reversal_rate > 0 && p.reversal_rate <= 10) {
    insights.push(
      `**Stable decision-making (${p.reversal_rate}% reversal rate)**: Your planning is solid. ` +
      `Most decisions stick.`
    );
  }

  if (Object.keys(p.reversals_by_topic).length > 0) {
    const worst = Object.entries(p.reversals_by_topic).sort((a, b) => b[1] - a[1])[0];
    if (worst[1] >= 2) {
      insights.push(
        `**${worst[0]}** is your most-reversed topic area (${worst[1]} reversals). ` +
        `This area might benefit from more upfront research.`
      );
    }
  }

  const conf = p.confidence_distribution;
  const lowConf = conf.low || 0;
  const totalConf = Object.values(conf).reduce((a, b) => a + b, 0);
  if (totalConf > 0 && pct(lowConf, totalConf) > 30) {
    insights.push(
      `**${pct(lowConf, totalConf)}% of decisions are low-confidence**: ` +
      `Many choices feel uncertain. Consider gathering more info before deciding.`
    );
  }

  if (c.avg_friction_per_session >= 2) {
    insights.push(
      `**High friction (${c.avg_friction_per_session} redirects/session)**: ` +
      `Try writing a brief goal at the start of each session to reduce mid-session pivots.`
    );
  }

  if (e.completion_rate < 70 && s.total_sessions >= 5) {
    insights.push(
      `**Low completion rate (${e.completion_rate}%)**: ` +
      `Many sessions end without finishing. Consider smaller, more focused goals per session.`
    );
  }

  if (e.open_items_pending > 10) {
    insights.push(
      `**${e.open_items_pending} open items pending**: ` +
      `Backlog is growing. Consider a cleanup session to close outstanding items.`
    );
  }

  if (e.session_focus_rate < 50 && s.total_sessions >= 5) {
    insights.push(
      `**Low session focus (${e.session_focus_rate}%)**: ` +
      `Most sessions span many topics. Single-topic sessions tend to be more productive.`
    );
  }

  if (Object.keys(pat.recurring_errors).length > 0) {
    insights.push(
      `**${Object.keys(pat.recurring_errors).length} recurring errors**: ` +
      `Some errors keep coming back. Consider documenting fixes in the project.`
    );
  }

  if (insights.length === 0) {
    insights.push('Not enough data yet to generate insights. Keep using the system!');
  }

  return insights;
}

// ── Formatters ─────────────────────────────────────────────────────────

function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMarkdown(metrics) {
  const m = metrics;
  const s = m.summary;
  const p = m.planning;
  const c = m.clarity;
  const e = m.efficiency;
  const pat = m.patterns;
  const t = m.trends;

  const lines = [];
  lines.push('## Session Analytics Dashboard');
  lines.push('');

  lines.push('### Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Sessions | ${s.total_sessions} (${s.completed_sessions} completed, ${s.active_sessions} active) |`);
  lines.push(`| Decisions tracked | ${s.total_decisions} |`);
  lines.push(`| Reversals | ${s.total_reversals} |`);
  lines.push(`| Errors resolved | ${s.total_errors} |`);
  lines.push(`| Files touched | ${s.total_files_touched} |`);

  if (Object.keys(t.sessions_by_date).length > 0) {
    const dates = Object.keys(t.sessions_by_date).sort();
    const vals = dates.map((d) => t.sessions_by_date[d]);
    lines.push(`| Activity trend | ${sparkline(vals.slice(-14))} (last 14 days) |`);
  }
  if (e.avg_session_duration_min > 0) {
    lines.push(`| Avg session length | ${e.avg_session_duration_min} min |`);
  }
  lines.push('');

  // Planning
  lines.push('### Planning Quality');
  lines.push('');
  const revRate = p.reversal_rate;
  const stability = p.decision_stability;
  const planningEmoji =
    revRate < 10 ? 'Excellent' :
    revRate < 20 ? 'Good' :
    revRate < 35 ? 'Needs attention' :
    'Review your planning process';
  lines.push('| Metric | Value | Assessment |');
  lines.push('|--------|-------|------------|');
  lines.push(`| Reversal rate | ${revRate}% | ${bar(100 - revRate, 100)} |`);
  lines.push(`| Decision stability (>7d) | ${stability}% | ${bar(stability, 100)} |`);
  lines.push(`| Overall | | ${planningEmoji} |`);
  lines.push('');

  const conf = p.confidence_distribution;
  if (Object.keys(conf).length > 0) {
    const totalConf = Object.values(conf).reduce((a, b) => a + b, 0);
    lines.push('**Decision confidence:**');
    for (const level of ['high', 'medium', 'low', 'unknown']) {
      if (level in conf) {
        const count = conf[level];
        lines.push(
          `- ${level[0].toUpperCase() + level.slice(1)}: ${count} (${pct(count, totalConf)}%)  ${bar(count, totalConf)}`
        );
      }
    }
    lines.push('');
  }

  if (Object.keys(p.reversals_by_topic).length > 0) {
    lines.push('**Reversals by topic:**');
    const sorted = Object.entries(p.reversals_by_topic).sort((a, b) => b[1] - a[1]);
    for (const [topic, count] of sorted) {
      const totalInTopic = p.decisions_by_topic[topic] || count;
      lines.push(`- ${topic}: ${count}/${totalInTopic} decisions reversed (${pct(count, totalInTopic)}%)`);
    }
    lines.push('');
  }

  // Clarity
  lines.push('### Instruction Clarity');
  lines.push('');
  const frictionAssessment =
    c.avg_friction_per_session < 0.5 ? 'Clear communicator' :
    c.avg_friction_per_session < 1 ? 'Generally clear' :
    c.avg_friction_per_session < 2 ? 'Some ambiguity' :
    'Consider planning prompts more carefully';
  lines.push('| Metric | Value | Assessment |');
  lines.push('|--------|-------|------------|');
  lines.push(`| Friction rate | ${c.friction_rate}% of sessions | ${frictionAssessment} |`);
  lines.push(`| Avg redirects/session | ${c.avg_friction_per_session} | |`);
  lines.push(`| Avg prompts/session | ${c.avg_prompts_per_session} | |`);
  lines.push('');

  if (Object.keys(c.friction_types).length > 0) {
    lines.push('**Friction breakdown:**');
    const sorted = Object.entries(c.friction_types).sort((a, b) => b[1] - a[1]);
    for (const [ftype, count] of sorted) {
      lines.push(`- ${ftype}: ${count}`);
    }
    lines.push('');
  }

  // Efficiency
  lines.push('### Efficiency');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Session completion rate | ${e.completion_rate}% ${bar(e.completion_rate, 100)} |`);
  lines.push(`| Open items completion | ${e.open_items_completion}% (${e.open_items_pending} pending) |`);
  lines.push(`| Session focus (<=3 topics) | ${e.session_focus_rate}% |`);
  lines.push('');

  // Patterns
  lines.push('### Where Your Time Goes');
  lines.push('');
  if (pat.top_topics.length > 0) {
    const totalTags = pat.top_topics.reduce((sum, x) => sum + x[1], 0);
    const maxCount = pat.top_topics[0][1];
    for (const [topic, count] of pat.top_topics.slice(0, 6)) {
      lines.push(`- **${topic}**: ${count} sessions (${pct(count, totalTags)}%)  ${bar(count, maxCount)}`);
    }
    lines.push('');
  }

  if (Object.keys(pat.sessions_by_day).length > 0) {
    lines.push('**Sessions by day:**');
    const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const maxDay = Math.max(...Object.values(pat.sessions_by_day), 1);
    for (const day of dayOrder) {
      const count = pat.sessions_by_day[day] || 0;
      lines.push(`- ${day}: ${bar(count, maxDay, 12)} ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(pat.recurring_errors).length > 0) {
    lines.push('### Recurring Errors (seen in multiple sessions)');
    lines.push('');
    const sorted = Object.entries(pat.recurring_errors).sort((a, b) => b[1] - a[1]);
    for (const [err, count] of sorted) {
      lines.push(`- \`${err.slice(0, 80)}\` (${count} times)`);
    }
    lines.push('');
  }

  // v1.1.0: Token Spend
  const tokens = metrics.tokens || {};
  if (Object.keys(tokens).length > 0) {
    lines.push('### Token Spend');
    lines.push('');
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
    let hitRateSum = 0, hitRateCount = 0;
    for (const v of Object.values(tokens)) {
      totalInput += v.input || 0;
      totalOutput += v.output || 0;
      totalCacheRead += v.cache_read || 0;
      totalCacheCreation += v.cache_creation || 0;
      hitRateSum += v.cache_hit_rate || 0;
      hitRateCount += 1;
    }
    const overallTotal = totalInput + totalOutput + totalCacheRead + totalCacheCreation;
    const avgHitRate = hitRateCount ? hitRateSum / hitRateCount : 0;
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total input tokens | ${fmtNum(totalInput)} |`);
    lines.push(`| Total output tokens | ${fmtNum(totalOutput)} |`);
    lines.push(`| Total cache_read tokens | ${fmtNum(totalCacheRead)} |`);
    lines.push(`| Total cache_creation tokens | ${fmtNum(totalCacheCreation)} |`);
    lines.push(`| Overall total | ${fmtNum(overallTotal)} |`);
    lines.push(`| Avg cache hit rate | ${Math.round(avgHitRate * 10) / 10}% ${bar(avgHitRate, 100)} |`);
    lines.push('');
  }

  // v1.1.0: Cost
  const cost = metrics.cost || {};
  const knownCosts = Object.values(cost).filter((v) => v.cost_usd !== null && v.cost_usd !== undefined);
  if (knownCosts.length > 0) {
    lines.push('### Estimated Cost');
    lines.push('');
    const totalCost = knownCosts.reduce((s, v) => s + (v.cost_usd || 0), 0);
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Sessions with known pricing | ${knownCosts.length} / ${Object.keys(cost).length} |`);
    lines.push(`| Total estimated spend | $${totalCost.toFixed(2)} |`);
    if (knownCosts.length > 0) {
      lines.push(`| Avg cost per session | $${(totalCost / knownCosts.length).toFixed(2)} |`);
    }
    const disclaimer = knownCosts[0].disclaimer || '';
    lines.push('');
    lines.push(`_${disclaimer}_`);
    const unknown = Object.keys(cost).length - knownCosts.length;
    if (unknown > 0) lines.push(`_${unknown} session(s) had unknown models; not priced._`);
    lines.push('');
  }

  // v1.1.0: Context Pressure
  const pressure = metrics.pressure || {};
  if (Object.keys(pressure).length > 0) {
    const known = Object.values(pressure).filter((v) => v.max_utilization_pct !== null && v.max_utilization_pct !== undefined);
    lines.push('### Context Pressure');
    lines.push('');
    const totalCompactions = Object.values(pressure).reduce((s, v) => s + (v.compaction_count || 0), 0);
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total compactions across sessions | ${totalCompactions} |`);
    if (known.length > 0) {
      const maxSeen = Math.max(...known.map((v) => v.max_utilization_pct || 0));
      const avgSeen = known.reduce((s, v) => s + (v.max_utilization_pct || 0), 0) / known.length;
      lines.push(`| Peak utilization seen | ${maxSeen.toFixed(1)}% ${bar(maxSeen, 100)} |`);
      lines.push(`| Avg peak utilization | ${avgSeen.toFixed(1)}% ${bar(avgSeen, 100)} |`);
    }
    lines.push('');
  }

  // v1.1.0: Pacing
  const pacing = metrics.pacing || {};
  if (Object.keys(pacing).length > 0) {
    lines.push('### Pacing');
    lines.push('');
    const medians = Object.values(pacing)
      .map((v) => v.inter_turn_median_ms || 0)
      .filter((x) => x > 0);
    const totalIdle = Object.values(pacing).reduce((s, v) => s + (v.idle_gaps_sec || []).length, 0);
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    if (medians.length > 0) {
      const avgMedian = medians.reduce((a, b) => a + b, 0) / medians.length;
      lines.push(`| Avg median inter-turn latency | ${(avgMedian / 1000).toFixed(1)}s |`);
    }
    lines.push(`| Total idle gaps (>60s) | ${totalIdle} |`);
    lines.push('');
  }

  lines.push('### Insights');
  lines.push('');
  const insights = generateInsights(metrics);
  for (const i of insights) lines.push(`- ${i}`);
  lines.push('');

  return lines.join('\n');
}

export function formatJson(metrics) {
  return JSON.stringify(metrics, null, 2);
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    format: 'markdown',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-dir' && argv[i + 1] !== undefined) {
      out.projectDir = argv[++i];
    } else if (a === '--format' && argv[i + 1] !== undefined) {
      out.format = argv[++i];
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionsDir = join(args.projectDir, '.claude-sessions');

  try {
    if (!statSync(sessionsDir).isDirectory()) throw new Error('not a dir');
  } catch {
    process.stderr.write('No .claude-sessions/ directory found. Start tracking sessions first.\n');
    process.exit(1);
    return;
  }

  const metrics = computeMetrics(sessionsDir);
  if (args.format === 'json') {
    process.stdout.write(formatJson(metrics) + '\n');
  } else {
    process.stdout.write(formatMarkdown(metrics) + '\n');
  }
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
