#!/usr/bin/env python
"""
Elephants Never Forget — HTML Dashboard Generator

Generates a self-contained HTML dashboard file and opens it in the browser.
Uses Chart.js via CDN for interactive charts.

Usage:
    python dashboard.py [--project-dir PATH] [--output PATH] [--no-open]
"""

import html
import json
import sys
import os
import webbrowser
import argparse
from datetime import datetime
from pathlib import Path

# Import the analytics engine
sys.path.insert(0, os.path.dirname(__file__))
from analytics import compute_metrics, pct


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Elephants Never Forget — Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {{
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5;
  }}
  h1 {{ font-size: 24px; margin-bottom: 8px; }}
  h2 {{ font-size: 18px; margin-bottom: 16px; color: var(--accent); }}
  .subtitle {{ color: var(--muted); margin-bottom: 24px; font-size: 14px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }}
  .card {{
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; position: relative;
  }}
  .card h3 {{ font-size: 14px; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }}
  .stat {{ font-size: 36px; font-weight: 700; }}
  .stat-label {{ font-size: 13px; color: var(--muted); }}
  .stat.green {{ color: var(--green); }}
  .stat.red {{ color: var(--red); }}
  .stat.yellow {{ color: var(--yellow); }}
  .stat.purple {{ color: var(--purple); }}
  .chart-container {{ background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; }}
  .chart-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }}
  .insight {{
    background: var(--card); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0;
    padding: 12px 16px; margin-bottom: 8px; font-size: 14px;
  }}
  .insight strong {{ color: var(--yellow); }}
  .bar {{ height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; margin-top: 4px; }}
  .bar-fill {{ height: 100%; border-radius: 4px; transition: width 0.6s ease; }}
  .bar-fill.green {{ background: var(--green); }}
  .bar-fill.red {{ background: var(--red); }}
  .bar-fill.yellow {{ background: var(--yellow); }}
  .bar-fill.accent {{ background: var(--accent); }}
  table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
  th {{ text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; text-transform: uppercase; }}
  td {{ padding: 8px 12px; border-bottom: 1px solid var(--border); }}
  @media (max-width: 768px) {{
    .chart-row {{ grid-template-columns: 1fr; }}
    .grid {{ grid-template-columns: 1fr 1fr; }}
  }}
</style>
</head>
<body>

<h1>Elephants Never Forget</h1>
<p class="subtitle">Analytics Dashboard &mdash; Generated {generated_at}</p>

<!-- KPI Cards -->
<div class="grid">
  <div class="card">
    <h3>Total Sessions</h3>
    <div class="stat">{total_sessions}</div>
    <div class="stat-label">{completed_sessions} completed, {active_sessions} active</div>
  </div>
  <div class="card">
    <h3>Decisions Tracked</h3>
    <div class="stat">{total_decisions}</div>
    <div class="stat-label">{total_reversals} reversed</div>
  </div>
  <div class="card">
    <h3>Reversal Rate</h3>
    <div class="stat {reversal_color}">{reversal_rate}%</div>
    <div class="bar"><div class="bar-fill {reversal_color}" style="width:{reversal_width}%"></div></div>
    <div class="stat-label">{reversal_assessment}</div>
  </div>
  <div class="card">
    <h3>Decision Stability</h3>
    <div class="stat {stability_color}">{stability}%</div>
    <div class="bar"><div class="bar-fill {stability_color}" style="width:{stability}%"></div></div>
    <div class="stat-label">Decisions surviving &gt;7 days</div>
  </div>
  <div class="card">
    <h3>Friction Rate</h3>
    <div class="stat {friction_color}">{avg_friction}/session</div>
    <div class="stat-label">{friction_assessment}</div>
  </div>
  <div class="card">
    <h3>Completion Rate</h3>
    <div class="stat {completion_color}">{completion_rate}%</div>
    <div class="bar"><div class="bar-fill {completion_color}" style="width:{completion_rate}%"></div></div>
    <div class="stat-label">{open_pending} open items pending</div>
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

<!-- Insights -->
<h2>Insights &amp; Recommendations</h2>
{insights_html}

<br><br>
<p class="subtitle">Data from .claude-sessions/ &mdash; Elephants Never Forget</p>

<script>
const chartDefaults = {{
  color: '#8b949e',
  borderColor: '#30363d',
  font: {{ family: '-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif' }}
}};
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';

// Sessions over time
new Chart(document.getElementById('sessionsChart'), {{
  type: 'bar',
  data: {{
    labels: {session_dates_json},
    datasets: [{{
      label: 'Sessions',
      data: {session_counts_json},
      backgroundColor: '#58a6ff',
      borderRadius: 4,
    }}]
  }},
  options: {{ plugins: {{ legend: {{ display: false }} }}, scales: {{ y: {{ beginAtZero: true, ticks: {{ stepSize: 1 }} }} }} }}
}});

// Topics
new Chart(document.getElementById('topicsChart'), {{
  type: 'doughnut',
  data: {{
    labels: {topic_labels_json},
    datasets: [{{
      data: {topic_values_json},
      backgroundColor: ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff'],
    }}]
  }},
  options: {{ plugins: {{ legend: {{ position: 'right' }} }} }}
}});

// Confidence
new Chart(document.getElementById('confidenceChart'), {{
  type: 'doughnut',
  data: {{
    labels: {conf_labels_json},
    datasets: [{{
      data: {conf_values_json},
      backgroundColor: {conf_colors_json},
    }}]
  }},
  options: {{ plugins: {{ legend: {{ position: 'right' }} }} }}
}});

// Day of week
new Chart(document.getElementById('dayChart'), {{
  type: 'bar',
  data: {{
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [{{
      label: 'Sessions',
      data: {day_values_json},
      backgroundColor: '#bc8cff',
      borderRadius: 4,
    }}]
  }},
  options: {{ plugins: {{ legend: {{ display: false }} }}, scales: {{ y: {{ beginAtZero: true, ticks: {{ stepSize: 1 }} }} }} }}
}});
</script>
</body>
</html>"""


def color_for_value(value, good_below, warn_below):
    """Return color class based on thresholds."""
    if value <= good_below:
        return "green"
    elif value <= warn_below:
        return "yellow"
    return "red"


def inverse_color(value, good_above, warn_above):
    """Return color class (higher is better)."""
    if value >= good_above:
        return "green"
    elif value >= warn_above:
        return "yellow"
    return "red"


def generate_html(metrics):
    """Generate the HTML dashboard from metrics."""
    s = metrics["summary"]
    p = metrics["planning"]
    c = metrics["clarity"]
    e = metrics["efficiency"]
    pat = metrics["patterns"]
    t = metrics["trends"]

    # Reversal assessment
    rev_rate = p["reversal_rate"]
    if rev_rate < 10:
        rev_assess = "Excellent planning"
    elif rev_rate < 20:
        rev_assess = "Good stability"
    elif rev_rate < 35:
        rev_assess = "Needs attention"
    else:
        rev_assess = "Review planning process"

    # Friction assessment
    avg_f = c["avg_friction_per_session"]
    if avg_f < 0.5:
        friction_assess = "Clear communicator"
    elif avg_f < 1:
        friction_assess = "Generally clear"
    elif avg_f < 2:
        friction_assess = "Some ambiguity"
    else:
        friction_assess = "Review instruction clarity"

    # Insights HTML
    from analytics import generate_insights
    insights = generate_insights(metrics)
    insights_html = "\n".join(f'<div class="insight">{html.escape(i)}</div>' for i in insights)

    # Chart data
    session_dates = sorted(t.get("sessions_by_date", {}).keys())
    session_counts = [t["sessions_by_date"][d] for d in session_dates]

    topics = pat.get("top_topics", [])[:8]
    topic_labels = [t[0] for t in topics]
    topic_values = [t[1] for t in topics]

    conf = p.get("confidence_distribution", {})
    conf_color_map = {"high": "#3fb950", "medium": "#d29922", "low": "#f85149", "unknown": "#8b949e"}
    conf_order = ["high", "medium", "low", "unknown"]
    conf_present = [l for l in conf_order if l in conf]
    conf_labels = [l.capitalize() for l in conf_present]
    conf_values = [conf[l] for l in conf_present]
    conf_colors = [conf_color_map[l] for l in conf_present]

    days = pat.get("sessions_by_day", {})
    day_values = [days.get(d, 0) for d in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]]

    stability = p["decision_stability"]
    completion = e["completion_rate"]

    return HTML_TEMPLATE.format(
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M"),
        total_sessions=s["total_sessions"],
        completed_sessions=s["completed_sessions"],
        active_sessions=s["active_sessions"],
        total_decisions=s["total_decisions"],
        total_reversals=s["total_reversals"],
        reversal_rate=rev_rate,
        reversal_color=color_for_value(rev_rate, 10, 25),
        reversal_width=min(rev_rate, 100),
        reversal_assessment=rev_assess,
        stability=stability,
        stability_color=inverse_color(stability, 70, 40),
        avg_friction=avg_f,
        friction_color=color_for_value(avg_f, 0.5, 1.5),
        friction_assessment=friction_assess,
        completion_rate=completion,
        completion_color=inverse_color(completion, 80, 60),
        open_pending=e["open_items_pending"],
        insights_html=insights_html,
        session_dates_json=json.dumps(session_dates),
        session_counts_json=json.dumps(session_counts),
        topic_labels_json=json.dumps(topic_labels),
        topic_values_json=json.dumps(topic_values),
        conf_labels_json=json.dumps(conf_labels),
        conf_colors_json=json.dumps(conf_colors),
        conf_values_json=json.dumps(conf_values),
        day_values_json=json.dumps(day_values),
    )


def main():
    parser = argparse.ArgumentParser(description="Elephants Never Forget — HTML Dashboard")
    parser.add_argument("--project-dir", default=os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    parser.add_argument("--output", default=None)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    sessions_dir = os.path.join(args.project_dir, ".claude-sessions")
    if not os.path.isdir(sessions_dir):
        print("No .claude-sessions/ directory found.")
        sys.exit(1)

    metrics = compute_metrics(sessions_dir)
    html = generate_html(metrics)

    output_path = args.output or os.path.join(sessions_dir, "dashboard.html")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Dashboard saved to: {output_path}")

    if not args.no_open:
        webbrowser.open(Path(output_path).resolve().as_uri())
        print("Opened in browser.")


if __name__ == "__main__":
    main()
