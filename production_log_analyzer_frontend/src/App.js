import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Best-effort normalization: backend report is an object with "additionalProperties",
 * so field names may vary slightly between versions. This UI tries common variants.
 */
function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== "object") return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function safeNumber(n, fallback = 0) {
  return Number.isFinite(Number(n)) ? Number(n) : fallback;
}

function normalizeSeverity(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "low";
  if (["critical", "crit", "sev0", "sev-0", "p0"].includes(s)) return "critical";
  if (["high", "sev1", "sev-1", "p1"].includes(s)) return "high";
  if (["medium", "med", "sev2", "sev-2", "p2"].includes(s)) return "medium";
  if (["low", "sev3", "sev-3", "p3", "info"].includes(s)) return "low";
  // "warning" is not a severity tier, but treat it as medium for rendering.
  if (["warn", "warning"].includes(s)) return "medium";
  return s;
}

function severityRank(sev) {
  const s = normalizeSeverity(sev);
  if (s === "critical") return 4;
  if (s === "high") return 3;
  if (s === "medium") return 2;
  return 1;
}

function severityLabel(sev) {
  const s = normalizeSeverity(sev);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// PUBLIC_INTERFACE
function App() {
  /**
   * Theme support is kept from template, but default aligns with work item style guide ("light").
   */
  const [theme, setTheme] = useState("light");

  const [selectedFile, setSelectedFile] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [parseWarnings, setParseWarnings] = useState([]);
  const [report, setReport] = useState(null);
  const [filename, setFilename] = useState("");

  // Filters
  const [minSeverity, setMinSeverity] = useState("low");
  const [searchText, setSearchText] = useState("");
  const [showOnlyActionable, setShowOnlyActionable] = useState(false);

  // Chart controls
  const [chartMetric, setChartMetric] = useState("errors"); // errors | warnings | total
  const chartCanvasRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // PUBLIC_INTERFACE
  const toggleTheme = () => {
    setTheme((prevTheme) => (prevTheme === "light" ? "dark" : "light"));
  };

  const apiBaseUrl = useMemo(() => {
    /**
     * IMPORTANT:
     * - CRA only exposes vars prefixed with REACT_APP_.
     * - In many environments no env var is set and CRA proxy is not configured.
     *
     * When apiBaseUrl is empty, fetch(`${apiBaseUrl}/api/...`) becomes a same-origin request
     * to the frontend (port 3000) and will 404, making “Analyze” appear broken.
     *
     * To make the app work out-of-the-box in Kavia’s multi-container setup, we fall back to:
     *   same hostname, backend port 3001
     *
     * In production, set REACT_APP_API_BASE (recommended) or REACT_APP_BACKEND_URL.
     */
    const explicit = process.env.REACT_APP_API_BASE || process.env.REACT_APP_BACKEND_URL;
    if (explicit) return explicit.replace(/\/+$/, "");

    if (typeof window !== "undefined" && window.location?.hostname) {
      return `${window.location.protocol}//${window.location.hostname}:3001`;
    }
    return "";
  }, []);

  const timelineBuckets = useMemo(() => {
    // Accept common names used in log-analysis reports.
    // Current backend returns `report.timeline` (see openapi + runtime).
    // Expected: array of buckets like { ts, start, end, bucket_start, bucket_end, errors, warnings, info, total, count }
    const buckets = pick(report, ["timeline", "timeline_buckets", "time_buckets", "buckets"], []);
    return Array.isArray(buckets) ? buckets : [];
  }, [report]);

  const patterns = useMemo(() => {
    const p = pick(report, ["patterns", "pattern_detection", "pattern_results"], []);
    return Array.isArray(p) ? p : [];
  }, [report]);

  const findings = useMemo(() => {
    // "findings" may be called "issues", "issue_clusters", etc.
    const f = pick(report, ["findings", "issues", "issue_clusters", "clusters"], []);
    return Array.isArray(f) ? f : [];
  }, [report]);

  const troubleshootingSteps = useMemo(() => {
    const steps = pick(report, ["troubleshooting_steps", "recommended_steps", "recommendations", "actions"], []);
    return Array.isArray(steps) ? steps : [];
  }, [report]);

  const stats = useMemo(() => {
    // Some versions may use report.stats or report.summary.statistics, etc.
    // Current backend returns:
    //   report.summary_statistics.total_events
    //   report.summary_statistics.counts_by_severity.{critical,high,medium,low}
    const root = report || {};
    const statsObj =
      pick(root, ["summary_statistics", "stats", "summary_stats", "summary"], null) ||
      pick(root, ["statistics"], null) ||
      pick(pick(root, ["summary"], null), ["statistics", "stats", "summary_statistics"], null);

    const countsBySeverity = pick(statsObj, ["counts_by_severity", "counts", "by_severity"], null);

    // Try both flattened and nested representations.
    const totalErrors = safeNumber(
      pick(statsObj, ["total_errors", "errors", "error_count"], pick(countsBySeverity, ["critical", "high"], 0)),
    );
    const totalWarnings = safeNumber(
      pick(statsObj, ["total_warnings", "warnings", "warning_count"], pick(countsBySeverity, ["medium"], 0)),
    );
    const totalInfo = safeNumber(pick(statsObj, ["total_info", "info", "info_count"], pick(countsBySeverity, ["low"], 0)));

    const total = safeNumber(
      pick(
        statsObj,
        ["total_events", "total", "total_lines", "line_count", "count"],
        totalErrors + totalWarnings + totalInfo,
      ),
    );

    return {
      total,
      totalErrors,
      totalWarnings,
      totalInfo,
    };
  }, [report]);

  const filteredFindings = useMemo(() => {
    const minRank = severityRank(minSeverity);
    const q = searchText.trim().toLowerCase();

    return findings
      .filter((f) => severityRank(pick(f, ["severity", "level", "priority"], "low")) >= minRank)
      .filter((f) => {
        if (!q) return true;
        const title = String(pick(f, ["title", "name", "summary"], "")).toLowerCase();
        const desc = String(pick(f, ["description", "details"], "")).toLowerCase();
        const category = String(pick(f, ["category", "type"], "")).toLowerCase();
        return title.includes(q) || desc.includes(q) || category.includes(q);
      })
      .filter((f) => {
        if (!showOnlyActionable) return true;
        const steps = pick(f, ["troubleshooting_steps", "recommended_steps", "actions"], null);
        return asArray(steps).length > 0;
      })
      .sort((a, b) => {
        const ra = severityRank(pick(a, ["severity", "level", "priority"], "low"));
        const rb = severityRank(pick(b, ["severity", "level", "priority"], "low"));
        return rb - ra;
      });
  }, [findings, minSeverity, searchText, showOnlyActionable]);

  const filteredTroubleshootingSteps = useMemo(() => {
    const minRank = severityRank(minSeverity);
    const q = searchText.trim().toLowerCase();
    return troubleshootingSteps
      .filter((s) => severityRank(pick(s, ["severity", "level", "priority"], "low")) >= minRank)
      .filter((s) => {
        if (!q) return true;
        const title = String(pick(s, ["title", "step", "action"], "")).toLowerCase();
        const desc = String(pick(s, ["description", "details", "rationale"], "")).toLowerCase();
        return title.includes(q) || desc.includes(q);
      })
      .sort((a, b) => severityRank(pick(b, ["severity", "level", "priority"], "low")) - severityRank(pick(a, ["severity", "level", "priority"], "low")));
  }, [troubleshootingSteps, minSeverity, searchText]);

  const chartSeries = useMemo(() => {
    const buckets = timelineBuckets;
    if (!buckets.length) return { labels: [], values: [] };

    const labels = buckets.map((b, idx) => {
      const start =
        pick(b, ["bucket_start", "start", "ts", "time", "from"], null) ??
        idx;
      // Keep label compact; show ISO prefix if it looks like a timestamp string.
      const s = String(start);
      if (s.includes("T")) return s.replace("Z", "").slice(0, 16);
      return s.length > 22 ? s.slice(0, 22) + "…" : s;
    });

    const values = buckets.map((b) => {
      if (chartMetric === "warnings") return safeNumber(pick(b, ["warnings", "warning_count"], 0));
      if (chartMetric === "total") return safeNumber(pick(b, ["total", "count"], 0));
      // default errors
      return safeNumber(pick(b, ["errors", "error_count"], 0));
    });

    return { labels, values };
  }, [timelineBuckets, chartMetric]);

  // Simple canvas bar chart (no extra dependency)
  useEffect(() => {
    const canvas = chartCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { labels, values } = chartSeries;
    const w = canvas.width;
    const h = canvas.height;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // If no data, draw placeholder
    if (!values.length) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted-text").trim() || "#64748b";
      ctx.font = "12px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillText("No timeline buckets available in report.", 12, 24);
      return;
    }

    const max = Math.max(...values, 1);
    const padding = { top: 16, right: 12, bottom: 28, left: 36 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    // Axes
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.stroke();

    // Y ticks (0..max)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted-text").trim() || "#64748b";
    ctx.font = "11px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = Math.round((max * i) / ticks);
      const y = padding.top + plotH - (plotH * i) / ticks;
      ctx.fillText(String(v), 6, y + 4);
      ctx.strokeStyle = "rgba(100,116,139,0.12)";
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
    }

    // Bars
    const gap = 6;
    const barW = Math.max(6, (plotW - gap * (values.length - 1)) / values.length);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#3b82f6";

    values.forEach((v, i) => {
      const x = padding.left + i * (barW + gap);
      const barH = (v / max) * plotH;
      const y = padding.top + plotH - barH;
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, barW, barH);
    });

    // X labels (sampled)
    const maxLabels = 6;
    const step = Math.ceil(labels.length / maxLabels);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted-text").trim() || "#64748b";
    ctx.font = "10px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    labels.forEach((lab, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const x = padding.left + i * (barW + gap);
      const y = padding.top + plotH + 16;
      const txt = String(lab);
      ctx.fillText(txt.length > 12 ? txt.slice(0, 12) + "…" : txt, x, y);
    });
  }, [chartSeries, theme]);

  // PUBLIC_INTERFACE
  async function analyzeSelectedFile() {
    setApiError(null);
    setParseWarnings([]);
    setReport(null);
    setFilename("");

    if (!selectedFile) {
      setApiError("Please choose a log file to upload.");
      return;
    }

    setIsAnalyzing(true);
    try {
      const form = new FormData();
      form.append("file", selectedFile);

      const url = `${apiBaseUrl}/api/logs/analyze`;
      const res = await fetch(url, { method: "POST", body: form });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend returned ${res.status}. ${text || ""}`.trim());
      }

      const data = await res.json();
      setFilename(pick(data, ["filename"], selectedFile.name) || selectedFile.name);
      setParseWarnings(pick(data, ["parse_warnings"], []));
      setReport(pick(data, ["report"], null));
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div className="App">
      <div className="TopBar" role="banner">
        <div className="TopBar__left">
          <div className="BrandMark" aria-hidden="true">PLI</div>
          <div>
            <div className="TopBar__title">Production Log Insights</div>
            <div className="TopBar__subtitle">Upload logs → analyze → view structured report + timeline</div>
          </div>
        </div>

        <div className="TopBar__right">
          <button
            className="Btn Btn--ghost"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            type="button"
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
        </div>
      </div>

      <div className="Shell">
        <aside className="SidePanel" aria-label="Upload and filters panel">
          <div className="PanelSection">
            <div className="SectionTitle">Upload</div>

            <label className="FileDrop">
              <input
                className="FileDrop__input"
                type="file"
                accept=".log,.txt,.json,.ndjson,.zip,application/zip,application/json,text/plain"
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  setSelectedFile(file);
                  // Clear previous output/errors so the user sees the new run clearly.
                  setApiError(null);
                  setParseWarnings([]);
                  setReport(null);
                  setFilename("");
                }}
              />
              <div className="FileDrop__body">
                <div className="FileDrop__headline">Choose a log file</div>
                <div className="FileDrop__meta">
                  {selectedFile ? (
                    <>
                      <span className="Mono">{selectedFile.name}</span>
                      <span className="Dot">•</span>
                      <span>{Math.round(selectedFile.size / 1024)} KB</span>
                    </>
                  ) : (
                    <span className="Muted">Supported: .log .txt .json .ndjson .zip</span>
                  )}
                </div>
              </div>
            </label>

            <button
              className="Btn Btn--primary Btn--block"
              onClick={analyzeSelectedFile}
              disabled={isAnalyzing || !selectedFile}
              type="button"
            >
              {isAnalyzing ? "Analyzing…" : "Analyze logs"}
            </button>

            <div className="HelpText">
              Backend: <span className="Mono">{apiBaseUrl ? apiBaseUrl : "(not configured)"}</span>
              <div className="HelpText__hint">
                You can override with <span className="Mono">REACT_APP_API_BASE</span> (recommended) or{" "}
                <span className="Mono">REACT_APP_BACKEND_URL</span>. If unset, this UI defaults to{" "}
                <span className="Mono">{typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:3001` : "http://localhost:3001"}</span>.
              </div>
            </div>

            {apiError ? (
              <div className="Alert Alert--error" role="alert">
                <div className="Alert__title">Request failed</div>
                <div className="Alert__body">{apiError}</div>
              </div>
            ) : null}

            {parseWarnings && parseWarnings.length ? (
              <div className="Alert Alert--warn" role="status">
                <div className="Alert__title">Parse warnings</div>
                <ul className="List">
                  {parseWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="PanelSection">
            <div className="SectionTitle">Filters</div>

            <div className="Field">
              <label className="Field__label" htmlFor="minSeverity">Minimum severity</label>
              <select
                id="minSeverity"
                className="Select"
                value={minSeverity}
                onChange={(e) => setMinSeverity(e.target.value)}
              >
                <option value="low">Low+</option>
                <option value="medium">Medium+</option>
                <option value="high">High+</option>
                <option value="critical">Critical only</option>
              </select>
            </div>

            <div className="Field">
              <label className="Field__label" htmlFor="searchText">Search</label>
              <input
                id="searchText"
                className="Input"
                placeholder="e.g. timeout, 500, database…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </div>

            <label className="Checkbox">
              <input
                type="checkbox"
                checked={showOnlyActionable}
                onChange={(e) => setShowOnlyActionable(e.target.checked)}
              />
              <span>Only items with troubleshooting steps</span>
            </label>
          </div>

          <div className="PanelSection">
            <div className="SectionTitle">Timeline chart</div>
            <div className="Field">
              <label className="Field__label" htmlFor="chartMetric">Metric</label>
              <select id="chartMetric" className="Select" value={chartMetric} onChange={(e) => setChartMetric(e.target.value)}>
                <option value="errors">Errors</option>
                <option value="warnings">Warnings</option>
                <option value="total">Total events</option>
              </select>
            </div>
            <div className="HelpText">
              Uses <span className="Mono">report.timeline_buckets</span> (or equivalent) if present.
            </div>
          </div>
        </aside>

        <main className="Main" aria-label="Analysis report">
          <div className="MainHeader">
            <div>
              <div className="MainHeader__title">Analysis report</div>
              <div className="MainHeader__subtitle">
                {report ? (
                  <>
                    File: <span className="Mono">{filename || "uploaded log"}</span>
                  </>
                ) : (
                  <span className="Muted">Upload a log file to generate the structured report.</span>
                )}
              </div>
            </div>

            {report ? (
              <div className="Pills" aria-label="Summary statistics">
                <div className="Pill Pill--neutral">
                  <div className="Pill__label">Total</div>
                  <div className="Pill__value">{stats.total}</div>
                </div>
                <div className="Pill Pill--critical">
                  <div className="Pill__label">Errors</div>
                  <div className="Pill__value">{stats.totalErrors}</div>
                </div>
                <div className="Pill Pill--medium">
                  <div className="Pill__label">Warnings</div>
                  <div className="Pill__value">{stats.totalWarnings}</div>
                </div>
                <div className="Pill Pill--low">
                  <div className="Pill__label">Info</div>
                  <div className="Pill__value">{stats.totalInfo}</div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="Grid">
            <section className="Card" aria-label="Timeline chart">
              <div className="Card__header">
                <div className="Card__title">Error timeline / frequency</div>
                <div className="Card__meta">{chartSeries.values.length ? `${chartSeries.values.length} buckets` : "No timeline data"}</div>
              </div>
              <div className="Card__body">
                <div className="ChartWrap">
                  <canvas ref={chartCanvasRef} width={860} height={240} className="ChartCanvas" />
                </div>
              </div>
            </section>

            <section className="Card" aria-label="Findings list">
              <div className="Card__header">
                <div className="Card__title">Findings (issues & root causes)</div>
                <div className="Card__meta">{report ? `${filteredFindings.length} shown` : "—"}</div>
              </div>
              <div className="Card__body">
                {!report ? (
                  <div className="EmptyState">
                    <div className="EmptyState__title">No report yet</div>
                    <div className="EmptyState__body">Upload a production log file to see clustered issues, root cause hypotheses, and evidence.</div>
                  </div>
                ) : filteredFindings.length ? (
                  <div className="Stack">
                    {filteredFindings.map((f, idx) => {
                      const sev = normalizeSeverity(pick(f, ["severity", "level", "priority"], "low"));
                      const title = pick(f, ["title", "name", "summary"], `Finding #${idx + 1}`);
                      const category = pick(f, ["category", "type"], null);
                      const description = pick(f, ["description", "details"], null);

                      const rootCause = pick(f, ["root_cause", "rootCause", "root_causes", "hypothesis", "hypotheses"], null);
                      const evidence = pick(f, ["evidence", "evidence_samples", "examples"], null);
                      const steps = asArray(pick(f, ["troubleshooting_steps", "recommended_steps", "actions"], []));

                      return (
                        <article key={idx} className="Finding">
                          <div className="Finding__top">
                            <span className={`SeverityBadge SeverityBadge--${sev}`}>{severityLabel(sev)}</span>
                            <div className="Finding__title">{title}</div>
                          </div>

                          {category ? <div className="Finding__meta">Category: <span className="Mono">{String(category)}</span></div> : null}
                          {description ? <div className="Finding__desc">{String(description)}</div> : null}

                          {rootCause ? (
                            <div className="Finding__block">
                              <div className="BlockTitle">Root cause (hypothesis)</div>
                              <div className="BlockBody">{typeof rootCause === "string" ? rootCause : JSON.stringify(rootCause, null, 2)}</div>
                            </div>
                          ) : null}

                          {evidence ? (
                            <div className="Finding__block">
                              <div className="BlockTitle">Evidence (redacted)</div>
                              <pre className="CodeBlock">{typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2)}</pre>
                            </div>
                          ) : null}

                          {steps.length ? (
                            <div className="Finding__block">
                              <div className="BlockTitle">Troubleshooting steps</div>
                              <ol className="List">
                                {steps.map((s, i) => (
                                  <li key={i}>{typeof s === "string" ? s : JSON.stringify(s)}</li>
                                ))}
                              </ol>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="EmptyState">
                    <div className="EmptyState__title">No findings match current filters</div>
                    <div className="EmptyState__body">Try lowering the minimum severity or clearing search.</div>
                  </div>
                )}
              </div>
            </section>

            <section className="Card" aria-label="Pattern detection">
              <div className="Card__header">
                <div className="Card__title">Pattern detection</div>
                <div className="Card__meta">{report ? `${patterns.length} patterns` : "—"}</div>
              </div>
              <div className="Card__body">
                {!report ? (
                  <div className="Muted">Pattern detection results will appear here after analysis.</div>
                ) : patterns.length ? (
                  <ul className="List">
                    {patterns.map((p, i) => {
                      const title = pick(p, ["title", "name", "pattern"], `Pattern #${i + 1}`);
                      const detail = pick(p, ["description", "details", "summary"], null);
                      return (
                        <li key={i}>
                          <div className="Strong">{String(title)}</div>
                          {detail ? <div className="Muted">{String(detail)}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="Muted">No patterns provided by report.</div>
                )}
              </div>
            </section>

            <section className="Card" aria-label="Recommended troubleshooting steps">
              <div className="Card__header">
                <div className="Card__title">Recommended troubleshooting (prioritized)</div>
                <div className="Card__meta">{report ? `${filteredTroubleshootingSteps.length} shown` : "—"}</div>
              </div>
              <div className="Card__body">
                {!report ? (
                  <div className="Muted">After analysis, steps will be prioritized by severity and shown here.</div>
                ) : filteredTroubleshootingSteps.length ? (
                  <div className="Stack">
                    {filteredTroubleshootingSteps.map((s, i) => {
                      const sev = normalizeSeverity(pick(s, ["severity", "level", "priority"], "low"));
                      const title = pick(s, ["title", "step", "action"], `Step #${i + 1}`);
                      const desc = pick(s, ["description", "details", "rationale"], null);
                      return (
                        <div key={i} className="StepRow">
                          <span className={`SeverityDot SeverityDot--${sev}`} aria-hidden="true" />
                          <div>
                            <div className="Strong">{String(title)} <span className={`InlineBadge InlineBadge--${sev}`}>{severityLabel(sev)}</span></div>
                            {desc ? <div className="Muted">{String(desc)}</div> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="Muted">No troubleshooting steps match current filters.</div>
                )}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
