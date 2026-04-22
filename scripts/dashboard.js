/**
 * Elephants Never Forget — HTML Dashboard Generator
 *
 * Generates a self-contained HTML dashboard file and opens it in the browser.
 * Uses Chart.js via CDN for interactive charts.
 *
 * Usage:
 *   node scripts/dashboard.js [--project-dir PATH] [--output PATH] [--no-open]
 */
import { writeFileSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { computeMetrics, generateInsights, pct } from './analytics.js';

function colorForValue(value, goodBelow, warnBelow) {
  if (value <= goodBelow) return 'green';
  if (value <= warnBelow) return 'yellow';
  return 'red';
}

function inverseColor(value, goodAbove, warnAbove) {
  if (value >= goodAbove) return 'green';
  if (value >= warnAbove) return 'yellow';
  return 'red';
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Elephants Never Forget — Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5;
  }
  h1 { font-size: 24px; margin-bottom: 8px; }
  h2 { font-size: 18px; margin-bottom: 16px; color: var(--accent); }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; position: relative;
  }
  .card h3 { font-size: 14px; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat { font-size: 36px; font-weight: 700; }
  .stat-label { font-size: 13px; color: var(--muted); }
  .stat.green { color: var(--green); }
  .stat.red { color: var(--red); }
  .stat.yellow { color: var(--yellow); }
  .stat.purple { color: var(--purple); }
  .chart-container { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; }
  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .insight {
    background: var(--card); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0;
    padding: 12px 16px; margin-bottom: 8px; font-size: 14px;
  }
  .insight strong { color: var(--yellow); }
  .bar { height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; margin-top: 4px; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.6s ease; }
  .bar-fill.green { background: var(--green); }
  .bar-fill.red { background: var(--red); }
  .bar-fill.yellow { background: var(--yellow); }
  .bar-fill.accent { background: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; text-transform: uppercase; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  @media (max-width: 768px) {
    .chart-row { grid-template-columns: 1fr; }
    .grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<h1>Elephants Never Forget</h1>
<p class="subtitle">Analytics Dashboard &mdash; Generated {{GENERATED_AT}}</p>

<!-- KPI Cards -->
<div class="grid">
  <div class="card">
    <h3>Total Sessions</h3>
    <div class="stat">{{TOTAL_SESSIONS}}</div>
    <div class="stat-label">{{COMPLETED_SESSIONS}} completed, {{ACTIVE_SESSIONS}} active</div>
  </div>
  <div class="card">
    <h3>Decisions Tracked</h3>
    <div class="stat">{{TOTAL_DECISIONS}}</div>
    <div class="stat-label">{{TOTAL_REVERSALS}} reversed</div>
  </div>
  <div class="card">
    <h3>Reversal Rate</h3>
    <div class="stat {{REVERSAL_COLOR}}">{{REVERSAL_RATE}}%</div>
    <div class="bar"><div class="bar-fill {{REVERSAL_COLOR}}" style="width:{{REVERSAL_WIDTH}}%"></div></div>
    <div class="stat-label">{{REVERSAL_ASSESSMENT}}</div>
  </div>
  <div class="card">
    <h3>Decision Stability</h3>
    <div class="stat {{STABILITY_COLOR}}">{{STABILITY}}%</div>
    <div class="bar"><div class="bar-fill {{STABILITY_COLOR}}" style="width:{{STABILITY}}%"></div></div>
    <div class="stat-label">Decisions surviving &gt;7 days</div>
  </div>
  <div class="card">
    <h3>Friction Rate</h3>
    <div class="stat {{FRICTION_COLOR}}">{{AVG_FRICTION}}/session</div>
    <div class="stat-label">{{FRICTION_ASSESSMENT}}</div>
  </div>
  <div class="card">
    <h3>Completion Rate</h3>
    <div class="stat {{COMPLETION_COLOR}}">{{COMPLETION_RATE}}%</div>
    <div class="bar"><div class="bar-fill {{COMPLETION_COLOR}}" style="width:{{COMPLETION_RATE}}%"></div></div>
    <div class="stat-label">{{OPEN_PENDING}} open items pending</div>
  </div>
</div>

<!-- Charts Row -->
<div class="chart-row">
  <div class="chart-container">
    <h2>Sessions Over Time</h2>
    <canvas id="sessionsChart"></canvas>
  </div>
  <div class="chart-container">
    <h2>Topic Distribution</h2>
    <canvas id="topicsChart"></canvas>
  </div>
</div>

<div class="chart-row">
  <div class="chart-container">
    <h2>Decision Confidence</h2>
    <canvas id="confidenceChart"></canvas>
  </div>
  <div class="chart-container">
    <h2>Sessions by Day</h2>
    <canvas id="dayChart"></canvas>
  </div>
</div>

<h2>Insights &amp; Recommendations</h2>
{{INSIGHTS_HTML}}

<br><br>
<p class="subtitle">Data from .claude-sessions/ &mdash; Elephants Never Forget</p>

<script>
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';

new Chart(document.getElementById('sessionsChart'), {
  type: 'bar',
  data: {
    labels: {{SESSION_DATES_JSON}},
    datasets: [{
      label: 'Sessions',
      data: {{SESSION_COUNTS_JSON}},
      backgroundColor: '#58a6ff',
      borderRadius: 4,
    }]
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
});

new Chart(document.getElementById('topicsChart'), {
  type: 'doughnut',
  data: {
    labels: {{TOPIC_LABELS_JSON}},
    datasets: [{
      data: {{TOPIC_VALUES_JSON}},
      backgroundColor: ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff'],
    }]
  },
  options: { plugins: { legend: { position: 'right' } } }
});

new Chart(document.getElementById('confidenceChart'), {
  type: 'doughnut',
  data: {
    labels: {{CONF_LABELS_JSON}},
    datasets: [{
      data: {{CONF_VALUES_JSON}},
      backgroundColor: {{CONF_COLORS_JSON}},
    }]
  },
  options: { plugins: { legend: { position: 'right' } } }
});

new Chart(document.getElementById('dayChart'), {
  type: 'bar',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [{
      label: 'Sessions',
      data: {{DAY_VALUES_JSON}},
      backgroundColor: '#bc8cff',
      borderRadius: 4,
    }]
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
});
</script>

<section>
  <h2>Token Spend (v1.1.0)</h2>
  <canvas id="chartTokensByType"></canvas>
  <canvas id="chartCacheHitRate"></canvas>
</section>
<section>
  <h2>Estimated Cost</h2>
  <canvas id="chartCostPerSession"></canvas>
  <p class="disclaimer">Estimates use public per-model rates as of 2026-01. Unknown models are omitted.</p>
</section>
<section>
  <h2>Context Pressure</h2>
  <canvas id="chartContextUtilization"></canvas>
</section>
<section>
  <h2>Pacing</h2>
  <canvas id="chartPromptToFirstTool"></canvas>
</section>
<script>
(function() {
  const METRICS = {{V11_METRICS_JSON}};
  const tokens = METRICS.tokens || {};
  const cost = METRICS.cost || {};
  const pressure = METRICS.pressure || {};
  const pacing = METRICS.pacing || {};
  const sids = Object.keys(tokens);

  if (sids.length > 0) {
    new Chart(document.getElementById('chartTokensByType'), {
      type: 'bar',
      data: {
        labels: sids,
        datasets: [
          {label: 'input',          data: sids.map(s => tokens[s].input          || 0), stack: 't'},
          {label: 'output',         data: sids.map(s => tokens[s].output         || 0), stack: 't'},
          {label: 'cache_read',     data: sids.map(s => tokens[s].cache_read     || 0), stack: 't'},
          {label: 'cache_creation', data: sids.map(s => tokens[s].cache_creation || 0), stack: 't'},
        ],
      },
      options: {scales: {x: {stacked: true}, y: {stacked: true}}},
    });

    new Chart(document.getElementById('chartCacheHitRate'), {
      type: 'line',
      data: {
        labels: sids,
        datasets: [{
          label: 'Cache hit rate %',
          data: sids.map(s => tokens[s].cache_hit_rate || 0),
          tension: 0.2,
        }],
      },
    });
  }

  const knownCost = sids.filter(s => cost[s] && cost[s].cost_usd != null);
  if (knownCost.length > 0) {
    new Chart(document.getElementById('chartCostPerSession'), {
      type: 'bar',
      data: {
        labels: knownCost,
        datasets: [{label: 'Cost USD', data: knownCost.map(s => cost[s].cost_usd)}],
      },
    });
  }

  const knownPressure = sids.filter(s => pressure[s] && pressure[s].max_utilization_pct != null);
  if (knownPressure.length > 0) {
    new Chart(document.getElementById('chartContextUtilization'), {
      type: 'line',
      data: {
        labels: knownPressure,
        datasets: [{
          label: 'Max utilization %',
          data: knownPressure.map(s => pressure[s].max_utilization_pct),
          tension: 0.2,
        }],
      },
      options: {scales: {y: {min: 0, max: 100}}},
    });
  }

  const pacingSids = Object.keys(pacing);
  if (pacingSids.length > 0) {
    const flat = [];
    pacingSids.forEach(s => (pacing[s].prompt_to_first_tool_ms || []).forEach(v => flat.push(v)));
    if (flat.length > 0) {
      const buckets = [0, 500, 1000, 2500, 5000, 10000, 30000];
      const counts = new Array(buckets.length).fill(0);
      flat.forEach(v => {
        for (let i = buckets.length - 1; i >= 0; i--) {
          if (v >= buckets[i]) { counts[i]++; break; }
        }
      });
      new Chart(document.getElementById('chartPromptToFirstTool'), {
        type: 'bar',
        data: {
          labels: buckets.map(b => b < 1000 ? \`\${b}ms\` : \`\${b/1000}s\`),
          datasets: [{label: 'Prompt \\u2192 first tool (count)', data: counts}],
        },
      });
    }
  }
})();
</script>
</body>
</html>`;

export function generateHtml(metrics) {
  const s = metrics.summary;
  const p = metrics.planning;
  const c = metrics.clarity;
  const e = metrics.efficiency;
  const pat = metrics.patterns;
  const t = metrics.trends;

  const revRate = p.reversal_rate;
  const revAssess =
    revRate < 10 ? 'Excellent planning' :
    revRate < 20 ? 'Good stability' :
    revRate < 35 ? 'Needs attention' :
    'Review planning process';

  const avgF = c.avg_friction_per_session;
  const frictionAssess =
    avgF < 0.5 ? 'Clear communicator' :
    avgF < 1 ? 'Generally clear' :
    avgF < 2 ? 'Some ambiguity' :
    'Review instruction clarity';

  const insights = generateInsights(metrics);
  const insightsHtml = insights.map((i) => `<div class="insight">${escapeHtml(i)}</div>`).join('\n');

  const sessionDates = Object.keys(t.sessions_by_date || {}).sort();
  const sessionCounts = sessionDates.map((d) => t.sessions_by_date[d]);

  const topics = (pat.top_topics || []).slice(0, 8);
  const topicLabels = topics.map((tt) => tt[0]);
  const topicValues = topics.map((tt) => tt[1]);

  const conf = p.confidence_distribution || {};
  const confColorMap = { high: '#3fb950', medium: '#d29922', low: '#f85149', unknown: '#8b949e' };
  const confOrder = ['high', 'medium', 'low', 'unknown'];
  const confPresent = confOrder.filter((l) => l in conf);
  const confLabels = confPresent.map((l) => l[0].toUpperCase() + l.slice(1));
  const confValues = confPresent.map((l) => conf[l]);
  const confColors = confPresent.map((l) => confColorMap[l]);

  const days = pat.sessions_by_day || {};
  const dayValues = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => days[d] || 0);

  const stability = p.decision_stability;
  const completion = e.completion_rate;

  const v11MetricsJson = JSON.stringify({
    tokens: metrics.tokens || {},
    cost: metrics.cost || {},
    pressure: metrics.pressure || {},
    pacing: metrics.pacing || {},
  });

  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const generatedAt = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  const substitutions = {
    GENERATED_AT: generatedAt,
    TOTAL_SESSIONS: s.total_sessions,
    COMPLETED_SESSIONS: s.completed_sessions,
    ACTIVE_SESSIONS: s.active_sessions,
    TOTAL_DECISIONS: s.total_decisions,
    TOTAL_REVERSALS: s.total_reversals,
    REVERSAL_RATE: revRate,
    REVERSAL_COLOR: colorForValue(revRate, 10, 25),
    REVERSAL_WIDTH: Math.min(revRate, 100),
    REVERSAL_ASSESSMENT: revAssess,
    STABILITY: stability,
    STABILITY_COLOR: inverseColor(stability, 70, 40),
    AVG_FRICTION: avgF,
    FRICTION_COLOR: colorForValue(avgF, 0.5, 1.5),
    FRICTION_ASSESSMENT: frictionAssess,
    COMPLETION_RATE: completion,
    COMPLETION_COLOR: inverseColor(completion, 80, 60),
    OPEN_PENDING: e.open_items_pending,
    INSIGHTS_HTML: insightsHtml,
    SESSION_DATES_JSON: JSON.stringify(sessionDates),
    SESSION_COUNTS_JSON: JSON.stringify(sessionCounts),
    TOPIC_LABELS_JSON: JSON.stringify(topicLabels),
    TOPIC_VALUES_JSON: JSON.stringify(topicValues),
    CONF_LABELS_JSON: JSON.stringify(confLabels),
    CONF_COLORS_JSON: JSON.stringify(confColors),
    CONF_VALUES_JSON: JSON.stringify(confValues),
    DAY_VALUES_JSON: JSON.stringify(dayValues),
    V11_METRICS_JSON: v11MetricsJson,
  };

  let html = HTML_TEMPLATE;
  for (const [key, val] of Object.entries(substitutions)) {
    html = html.replaceAll(`{{${key}}}`, String(val));
  }
  return html;
}

function openBrowser(filePath) {
  const url = pathToFileURL(resolve(filePath)).href;
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // swallow — not critical
  }
}

function parseArgs(argv) {
  const out = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    output: null,
    noOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-dir' && argv[i + 1] !== undefined) out.projectDir = argv[++i];
    else if (a === '--output' && argv[i + 1] !== undefined) out.output = argv[++i];
    else if (a === '--no-open') out.noOpen = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionsDir = join(args.projectDir, '.claude-sessions');
  try {
    if (!statSync(sessionsDir).isDirectory()) throw new Error('not a dir');
  } catch {
    process.stderr.write('No .claude-sessions/ directory found.\n');
    process.exit(1);
    return;
  }

  const metrics = computeMetrics(sessionsDir);
  const html = generateHtml(metrics);

  const outputPath = args.output || join(sessionsDir, 'dashboard.html');
  writeFileSync(outputPath, html, 'utf8');
  process.stdout.write(`Dashboard saved to: ${outputPath}\n`);

  if (!args.noOpen) {
    openBrowser(outputPath);
    process.stdout.write('Opened in browser.\n');
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
