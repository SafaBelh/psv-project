import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Table, Columns, CloudUpload, Search, Download, ChevronDown,
  ArrowUp, ArrowDown, ChevronsUpDown, Check, X, FileText,
  Database, Filter, Rows3, Meh, File, BarChart2,
  GitBranch, MessageSquare, Plus, Trash2, Eye, TrendingUp,
  Link2, Zap, Send, Bot, User, RefreshCw, ChevronRight,
  Layers, AlertCircle, Settings, Hash, Type, Calendar,
  ChevronLeft, PanelRightClose, PanelRightOpen, Maximize2, Minimize2
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ScatterChart, Scatter
} from "recharts";

/* ─────────────────────────────────────────────
   CONSTANTS & PARSING
───────────────────────────────────────────── */
const NULL_TOKEN = "@NULL";
const FLOAT_PREFIX = "@F";
const DATE_PREFIX = "@D";
const ROW_HEIGHT = 32;
const OVERSCAN = 20;

const P = {
  50: "#faf5ff", 100: "#f3e8ff", 200: "#e9d5ff",
  300: "#d8b4fe", 400: "#c084fc", 500: "#a855f7",
  600: "#9333ea", 700: "#7c3aed", 800: "#6d28d9", 900: "#5b21b6"
};

const CHART_COLORS = ["#a855f7", "#7c3aed", "#c084fc", "#6d28d9", "#d8b4fe", "#e9d5ff", "#4f46e5", "#818cf8", "#38bdf8", "#34d399"];

function parseValue(raw) {
  if (!raw || raw === NULL_TOKEN) return { display: "—", raw: null, type: "null" };
  if (raw.startsWith(FLOAT_PREFIX)) {
    const num = parseFloat(raw.slice(2));
    return { display: isNaN(num) ? raw : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }), raw: num, type: "number" };
  }
  if (raw.startsWith(DATE_PREFIX)) {
    const datePart = raw.slice(2).split("T")[0].replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    return { display: datePart, raw: datePart, type: "date" };
  }
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try { JSON.parse(raw); return { display: "{ JSON }", raw, type: "json" }; } catch { }
  }
  return { display: raw, raw, type: "text" };
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 1) return { headers: [], rows: [] };
  const firstLine = lines[0];
  let delim = "|";
  if (!firstLine.includes("|")) {
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    if (tabCount > commaCount && tabCount > semicolonCount) delim = "\t";
    else if (semicolonCount > commaCount) delim = ";";
    else delim = ",";
  }
  const rawHeaders = lines[0].split(delim);
  const headers = rawHeaders[rawHeaders.length - 1] === "" ? rawHeaders.slice(0, -1) : rawHeaders;
  const rows = lines.slice(1).map(line => {
    const cells = line.split(delim);
    return headers.map((_, ci) => parseValue(cells[ci] ?? ""));
  });
  return { headers, rows };
}

function exportCSV(headers, rows, filename) {
  const esc = v => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map(r => r.map(c => esc(c.raw)).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename.replace(/\.[^.]+$/, "") + "_export.csv"; a.click();
  URL.revokeObjectURL(url);
}

/* ─────────────────────────────────────────────
   ANALYTICS HELPERS
───────────────────────────────────────────── */
function computeColumnStats(rows, colIdx, type) {
  const vals = rows.map(r => r[colIdx]?.raw).filter(v => v !== null && v !== undefined);
  if (type === "number") {
    const nums = vals.filter(v => typeof v === "number");
    if (nums.length === 0) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    return {
      count: nums.length, nullCount: rows.length - nums.length,
      min: sorted[0], max: sorted[sorted.length - 1],
      mean: sum / nums.length,
      median: sorted[Math.floor(sorted.length / 2)],
      sum
    };
  }
  if (type === "text" || type === "date") {
    const freq = {};
    vals.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { count: vals.length, nullCount: rows.length - vals.length, unique: Object.keys(freq).length, topValues: top };
  }
  return null;
}

function buildHistogram(rows, colIdx, bins = 10) {
  const nums = rows.map(r => r[colIdx]?.raw).filter(v => typeof v === "number");
  if (nums.length === 0) return [];
  const min = Math.min(...nums), max = Math.max(...nums);
  const binSize = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    range: `${(min + i * binSize).toFixed(1)}`,
    count: 0
  }));
  nums.forEach(v => {
    const i = Math.min(Math.floor((v - min) / binSize), bins - 1);
    buckets[i].count++;
  });
  return buckets;
}

/* ─────────────────────────────────────────────
   RELATIONSHIP DETECTION
───────────────────────────────────────────── */
function detectRelationships(tables) {
  const rels = [];
  const names = Object.keys(tables);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = tables[names[i]], b = tables[names[j]];
      const shared = a.headers.filter(h => b.headers.includes(h));
      shared.forEach(col => {
        const aVals = new Set(a.rows.map(r => r[a.headers.indexOf(col)]?.raw).filter(Boolean));
        const bVals = new Set(b.rows.map(r => r[b.headers.indexOf(col)]?.raw).filter(Boolean));
        const overlap = [...aVals].filter(v => bVals.has(v));
        if (overlap.length > 0) {
          rels.push({ from: names[i], to: names[j], column: col, overlap: overlap.length, type: aVals.size === overlap.length ? "1:N" : "N:M" });
        }
      });
    }
  }
  return rels;
}

/* ─────────────────────────────────────────────
   GLOBAL CSS
───────────────────────────────────────────── */
const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; background: #f8f6ff; }

  .ftv-root {
    min-height: 100vh; background: #f8f6ff;
    padding: 1.5rem 1.5rem 3rem; color: #1e1a2e;
  }
  .ftv-root::before {
    content: ''; position: fixed; inset: 0;
    background-image: radial-gradient(circle at 10% 10%, rgba(168,85,247,0.07) 0%, transparent 45%),
      radial-gradient(circle at 90% 85%, rgba(124,58,237,0.05) 0%, transparent 45%);
    pointer-events: none; z-index: 0;
  }
  .ftv-root > * { position: relative; z-index: 1; }

  .ftv-card {
    background: #fff; border: 1px solid #ece5fb; border-radius: 14px;
    box-shadow: 0 1px 3px rgba(124,58,237,0.06), 0 4px 16px rgba(124,58,237,0.04);
  }

  .ftv-btn-primary {
    background: linear-gradient(135deg, #7c3aed, #a855f7); color: #fff;
    border: none; border-radius: 9px; padding: 8px 16px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    transition: opacity 0.15s, transform 0.1s;
    font-family: 'DM Sans', sans-serif; letter-spacing: -0.01em;
    box-shadow: 0 2px 8px rgba(124,58,237,0.3);
    white-space: nowrap;
  }
  .ftv-btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
  .ftv-btn-primary:active { transform: scale(0.97); }
  .ftv-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

  .ftv-btn-ghost {
    background: transparent; color: #7c3aed;
    border: 1px solid #ddd0f9; border-radius: 9px; padding: 8px 14px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    transition: all 0.15s; font-family: 'DM Sans', sans-serif; letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .ftv-btn-ghost:hover { background: #f3e8ff; border-color: #c084fc; color: #6d28d9; }
  .ftv-btn-ghost.active { background: linear-gradient(135deg,#7c3aed,#a855f7); border-color: transparent; color: #fff; }

  .ftv-btn-danger {
    background: transparent; color: #dc2626;
    border: 1px solid #fecaca; border-radius: 9px; padding: 6px 10px;
    font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 5px;
    transition: all 0.15s; font-family: 'DM Sans', sans-serif;
  }
  .ftv-btn-danger:hover { background: #fef2f2; }

  .ftv-input {
    background: #fff; border: 1px solid #ddd0f9; border-radius: 9px;
    color: #1e1a2e; font-size: 13px; padding: 8px 12px;
    font-family: 'DM Sans', sans-serif; width: 100%;
    transition: border-color 0.15s, box-shadow 0.15s; outline: none;
  }
  .ftv-input:focus { border-color: #a855f7; box-shadow: 0 0 0 3px rgba(168,85,247,0.12); }
  .ftv-input::placeholder { color: #c4b5fd; }

  .ftv-dropdown {
    position: absolute; background: #fff; border: 1px solid #ece5fb;
    border-radius: 14px; padding: 8px; z-index: 999;
    box-shadow: 0 8px 32px rgba(124,58,237,0.14), 0 2px 8px rgba(124,58,237,0.07);
  }
  .ftv-dropdown-item {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 9px; cursor: pointer;
    transition: background 0.1s; font-size: 13px; color: #3d3557;
  }
  .ftv-dropdown-item:hover { background: #f3e8ff; }

  tr.ftv-tr:hover td { background: #faf5ff !important; }

  .ftv-th {
    padding: 10px 14px; font-size: 11px; font-weight: 600; color: #9d8ec4;
    white-space: nowrap; cursor: pointer; user-select: none;
    border-right: 1px solid #ede8fb; border-bottom: 1px solid #ede8fb;
    background: #faf5ff; font-family: 'DM Mono', monospace;
    letter-spacing: 0.04em; text-transform: uppercase;
    transition: color 0.12s, background 0.12s; text-align: left;
  }
  .ftv-th:hover { color: #6d28d9; background: #f3e8ff; }
  .ftv-th.sorted { color: #7c3aed; background: #ede8fb; }

  .ftv-td {
    padding: 7px 14px; border-right: 1px solid #f3eefe;
    border-bottom: 1px solid #f3eefe; max-width: 200px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13px; cursor: pointer; background: #fff; transition: background 0.08s;
  }
  .ftv-td.selected { background: #f3e8ff !important; outline: 1.5px solid #a855f7; outline-offset: -1.5px; }

  .ftv-page-btn {
    min-width: 32px; height: 32px; background: #fff;
    border: 1px solid #ddd0f9; border-radius: 8px; color: #7c3aed;
    font-size: 13px; cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.12s; font-family: 'DM Sans', sans-serif;
  }
  .ftv-page-btn:hover { background: #f3e8ff; border-color: #c084fc; }
  .ftv-page-btn.active { background: linear-gradient(135deg,#7c3aed,#a855f7); border-color: transparent; color: #fff; font-weight: 600; }
  .ftv-page-btn:disabled { opacity: 0.3; cursor: not-allowed; }

  .ftv-scroll::-webkit-scrollbar { height: 5px; width: 5px; }
  .ftv-scroll::-webkit-scrollbar-track { background: #f3eefe; border-radius: 99px; }
  .ftv-scroll::-webkit-scrollbar-thumb { background: #c4b5fd; border-radius: 99px; }
  .ftv-scroll::-webkit-scrollbar-thumb:hover { background: #a855f7; }

  .ftv-badge-json { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; border-radius: 5px; font-size: 10px; padding: 1px 6px; font-family: 'DM Mono', monospace; }
  .ftv-badge-null { opacity: 0.3; font-size: 14px; }

  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 99px; font-size: 11px; font-weight: 500; }
  .chip-num  { background: #eff6ff; color: #3b82f6; border: 1px solid #bfdbfe; }
  .chip-date { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .chip-text { background: #faf5ff; color: #7c3aed; border: 1px solid #e9d5ff; }
  .chip-null { background: #faf5ff; color: #a78bfa; border: 1px solid #e9d5ff; }
  .chip-json { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }

  .ftv-progress-bar { height: 5px; background: #ede9f8; border-radius: 99px; overflow: hidden; }
  .ftv-progress-fill { height: 100%; background: linear-gradient(90deg, #7c3aed, #a855f7, #c084fc); border-radius: 99px; transition: width 0.12s linear; }

  .ftv-stat-card {
    flex: 1 1 110px; min-width: 100px; background: #fff;
    border: 1px solid #ece5fb; border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 1px 4px rgba(124,58,237,0.06);
  }
  .ftv-stat-card.highlight {
    background: linear-gradient(135deg, #5b21b6, #7c3aed, #a855f7);
    border-color: transparent; box-shadow: 0 4px 20px rgba(124,58,237,0.35);
  }

  .drop-zone {
    border: 1.5px dashed #c4b5fd; border-radius: 16px; padding: 2rem;
    text-align: center; cursor: pointer; background: #fff;
    transition: all 0.2s; box-shadow: 0 1px 3px rgba(124,58,237,0.05);
  }
  .drop-zone:hover, .drop-zone.dragging { border-color: #a855f7; background: #faf5ff; box-shadow: 0 4px 24px rgba(168,85,247,0.12); }
  .drop-icon {
    width: 48px; height: 48px; margin: 0 auto 12px; border-radius: 14px;
    background: #f3e8ff; border: 1px solid #ddd0f9;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; color: #a855f7;
  }
  .drop-zone:hover .drop-icon, .drop-zone.dragging .drop-icon {
    background: linear-gradient(135deg,#7c3aed,#a855f7); border-color: transparent; color: #fff;
    box-shadow: 0 4px 16px rgba(168,85,247,0.4);
  }

  .logo-box {
    width: 40px; height: 40px; border-radius: 12px;
    background: linear-gradient(135deg, #5b21b6, #a855f7);
    display: flex; align-items: center; justify-content: center;
    color: #fff; box-shadow: 0 4px 14px rgba(124,58,237,0.4);
  }

  .col-check-box {
    width: 16px; height: 16px; border-radius: 5px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .col-check-box.on { background: linear-gradient(135deg,#7c3aed,#a855f7); }
  .col-check-box.off { background: #f3e8ff; border: 1px solid #ddd0f9; }

  .ext-tag {
    padding: 3px 10px; border-radius: 99px; background: #f3e8ff;
    border: 1px solid #ddd0f9; color: #7c3aed;
    font-size: 11px; font-family: 'DM Mono', monospace;
  }

  .nav-tabs { display: flex; gap: 4px; padding: 5px; background: #f3e8ff; border-radius: 14px; }
  .nav-tab {
    display: flex; align-items: center; gap: 7px; padding: 8px 16px;
    border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 500;
    color: #7c3aed; transition: all 0.15s; border: none; background: transparent;
    font-family: 'DM Sans', sans-serif;
  }
  .nav-tab:hover { background: rgba(255,255,255,0.6); }
  .nav-tab.active { background: #fff; color: #5b21b6; box-shadow: 0 2px 8px rgba(124,58,237,0.12); }

  .table-pill {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-radius: 10px; cursor: pointer; transition: all 0.12s;
    border: 1px solid transparent;
  }
  .table-pill:hover { background: #f3e8ff; border-color: #ddd0f9; }
  .table-pill.active { background: #f3e8ff; border-color: #c084fc; }

  .chat-bubble {
    max-width: 80%; padding: 10px 14px; border-radius: 14px;
    font-size: 13px; line-height: 1.55;
  }
  .chat-bubble.user { background: linear-gradient(135deg,#7c3aed,#a855f7); color: #fff; border-bottom-right-radius: 4px; margin-left: auto; }
  .chat-bubble.bot { background: #fff; border: 1px solid #ece5fb; color: #1e1a2e; border-bottom-left-radius: 4px; box-shadow: 0 2px 8px rgba(124,58,237,0.06); }
  .chat-bubble.bot pre { font-family: 'DM Mono', monospace; font-size: 11px; background: #faf5ff; padding: 8px 10px; border-radius: 8px; overflow-x: auto; margin-top: 6px; border: 1px solid #ede8fb; white-space: pre-wrap; word-break: break-all; }

  .rel-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 600;
    background: #f3e8ff; color: #7c3aed; border: 1px solid #ddd0f9;
    font-family: 'DM Mono', monospace;
  }

  .analytics-col-card {
    background: #fff; border: 1px solid #ece5fb; border-radius: 12px;
    padding: 14px; cursor: pointer; transition: all 0.15s;
  }
  .analytics-col-card:hover { border-color: #c084fc; box-shadow: 0 2px 12px rgba(168,85,247,0.1); }
  .analytics-col-card.active { border-color: #a855f7; background: #faf5ff; }

  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #f3eefe; font-size: 12.5px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-val { font-family: 'DM Mono', monospace; font-size: 12px; color: #7c3aed; font-weight: 500; }

  .typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #a855f7; animation: bounce 1.2s infinite; }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

  /* ── GRAPH CANVAS STYLES ── */
  .graph-canvas-root {
    background: #0d0d14; border-radius: 16px; overflow: hidden;
    position: relative; min-height: 560px;
  }
  .graph-canvas-root.fullscreen {
    position: fixed; inset: 0; z-index: 9999;
    border-radius: 0; min-height: 100vh;
  }
  .graph-canvas-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .graph-toolbar {
    pointer-events: all; display: flex; align-items: center; gap: 8px;
    padding: 12px 16px; background: rgba(13,13,20,0.92);
    backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.06);
    position: relative; z-index: 10;
  }
  .graph-logo {
    width: 28px; height: 28px; border-radius: 8px;
    background: linear-gradient(135deg,#5b21b6,#a855f7);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
  }
  .graph-btn {
    display: flex; align-items: center; gap: 5px; padding: 5px 10px;
    border-radius: 7px; border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.04); color: #a89fc8;
    font-size: 11px; font-family: 'DM Sans', sans-serif;
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .graph-btn:hover { background: rgba(168,85,247,0.15); border-color: rgba(168,85,247,0.4); color: #d8b4fe; }
  .graph-btn.active { background: rgba(168,85,247,0.2); border-color: rgba(168,85,247,0.5); color: #e9d5ff; }
  .graph-badge {
    display: inline-flex; align-items: center; padding: 2px 8px;
    border-radius: 99px; font-size: 10px; font-weight: 600;
    font-family: 'DM Mono', monospace; margin-left: auto;
    background: rgba(168,85,247,0.2); color: #c084fc;
    border: 1px solid rgba(168,85,247,0.3);
  }
  .graph-sep { width: 1px; height: 24px; background: rgba(255,255,255,0.07); }
  .graph-panel {
    position: absolute; top: 62px; right: 12px; width: 256px; z-index: 20;
    background: rgba(13,13,20,0.94); backdrop-filter: blur(16px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
    overflow: hidden; transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1);
    pointer-events: all;
  }
  .graph-panel.closed { transform: translateX(280px); pointer-events: none; }
  .graph-panel-header {
    padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex; align-items: center; gap: 8px;
  }
  .graph-panel-body {
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
    max-height: 400px; overflow-y: auto;
  }
  .graph-panel-body::-webkit-scrollbar { width: 3px; }
  .graph-panel-body::-webkit-scrollbar-thumb { background: #3d3557; border-radius: 99px; }
  .graph-legend {
    position: absolute; bottom: 12px; left: 12px; z-index: 10; pointer-events: none;
    display: flex; align-items: center; gap: 10px;
    background: rgba(13,13,20,0.8); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 6px 10px;
  }
  .graph-hint {
    position: absolute; bottom: 12px; right: 12px; z-index: 10; pointer-events: none;
    font-size: 10px; color: #3d3557; font-family: 'DM Mono', monospace;
  }
  .graph-minimap {
    position: absolute; bottom: 40px; left: 12px; z-index: 10; pointer-events: none;
    border: 1px solid rgba(255,255,255,0.06); border-radius: 7px; overflow: hidden;
  }

  /* ── SCHEMA ERD VIEW ── */
  .erd-root {
    background: #0d0d14; border-radius: 0 0 16px 16px; overflow: hidden;
    position: relative;
  }
  .erd-root.fullscreen-erd {
    position: fixed; inset: 0; z-index: 9999;
    border-radius: 0;
  }
  .erd-viewport {
    width: 100%; height: 560px; overflow: hidden;
    cursor: grab; position: relative; user-select: none;
  }
  .erd-root.fullscreen-erd .erd-viewport { height: calc(100vh - 52px); }
  .erd-viewport:active { cursor: grabbing; }
  .erd-canvas-inner {
    position: absolute; transform-origin: 0 0; will-change: transform;
  }
  .erd-svg { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .erd-table-card {
    position: absolute;
    background: rgba(18,14,30,0.95);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    width: 220px;
    backdrop-filter: blur(12px);
    box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 0 transparent;
    transition: border-color 0.2s, box-shadow 0.2s;
    overflow: hidden;
    cursor: grab;
  }
  .erd-table-card:active { cursor: grabbing; }
  .erd-table-card:hover { border-color: rgba(168,85,247,0.5); box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 20px -4px rgba(168,85,247,0.3); }
  .erd-table-card.highlighted { border-color: rgba(168,85,247,0.8); box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 30px -4px rgba(168,85,247,0.5); }
  .erd-table-card.dragging-card { cursor: grabbing; opacity: 0.92; box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 30px -4px rgba(168,85,247,0.5); z-index: 100; }
  .erd-card-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.07);
    cursor: grab;
  }
  .erd-card-icon {
    width: 24px; height: 24px; border-radius: 7px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: #fff;
  }
  .erd-card-name { font-size: 12px; font-weight: 600; color: #e2e0f0; font-family: 'DM Mono', monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .erd-card-rows { font-size: 10px; color: #4d4567; font-family: 'DM Mono', monospace; }
  .erd-col-row {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 12px; font-size: 11px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    transition: background 0.1s;
  }
  .erd-col-row:last-child { border-bottom: none; }
  .erd-col-row:hover { background: rgba(255,255,255,0.03); }
  .erd-col-name { font-family: 'DM Mono', monospace; color: #9d8ec4; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
  .erd-col-name.pk { color: #fcd34d; }
  .erd-col-name.fk { color: #67e8f9; }
  .erd-col-type { font-size: 9px; color: #4d4567; font-family: 'DM Mono', monospace; text-transform: uppercase; }
  .erd-more { padding: 4px 12px 6px; font-size: 10px; color: #4d4567; }

  /* ── ERD OVERLAY CONTROLS ── */
  .erd-search-bar {
    position: absolute; top: 12px; left: 12px; z-index: 20; pointer-events: all;
    display: flex; align-items: center; gap: 8px;
    background: rgba(13,13,20,0.92); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 9px;
    padding: 0 10px; height: 36px; width: 220px;
  }
  .erd-search-input {
    background: transparent; border: none; outline: none; color: #e2e0f0;
    font-size: 12px; font-family: 'DM Sans', sans-serif; width: 100%;
  }
  .erd-search-input::placeholder { color: #4d4567; }
  .erd-zoom-controls {
    position: absolute; bottom: 12px; left: 12px; z-index: 20; pointer-events: all;
    display: flex; flex-direction: column; gap: 4px;
  }
  .erd-zoom-btn {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    background: rgba(13,13,20,0.92); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: #a89fc8; font-size: 14px; cursor: pointer; transition: all 0.15s;
    font-family: 'DM Sans', sans-serif;
  }
  .erd-zoom-btn:hover { background: rgba(168,85,247,0.2); border-color: rgba(168,85,247,0.4); color: #d8b4fe; }
  .erd-hint {
    position: absolute; bottom: 12px; right: 12px; z-index: 10; pointer-events: none;
    font-size: 10px; color: #3d3557; font-family: 'DM Mono', monospace;
  }

  /* ── ERD SIDEBAR (collapsible) ── */
  .erd-sidebar-wrap {
    display: flex; flex-direction: column; gap: 0;
    transition: width 0.25s cubic-bezier(0.4,0,0.2,1), opacity 0.2s;
    overflow: hidden;
  }
  .erd-sidebar-wrap.open { width: 260px; opacity: 1; }
  .erd-sidebar-wrap.closed { width: 0; opacity: 0; pointer-events: none; }

  .erd-sidebar-toggle {
    position: absolute; right: 48px; top: 12px; z-index: 20; pointer-events: all;
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    background: rgba(13,13,20,0.92); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: #a89fc8; cursor: pointer; transition: all 0.15s;
  }
  .erd-sidebar-toggle:hover { background: rgba(168,85,247,0.2); border-color: rgba(168,85,247,0.4); color: #d8b4fe; }

  .erd-fullscreen-btn {
    position: absolute; right: 12px; top: 12px; z-index: 20; pointer-events: all;
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    background: rgba(13,13,20,0.92); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: #a89fc8; cursor: pointer; transition: all 0.15s;
  }
  .erd-fullscreen-btn:hover { background: rgba(168,85,247,0.2); border-color: rgba(168,85,247,0.4); color: #d8b4fe; }

  .rel-sidebar {
    background: rgba(13,13,20,0.7); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px; overflow: hidden;
  }
  .rel-sidebar-item {
    padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04);
    cursor: pointer; transition: background 0.12s;
  }
  .rel-sidebar-item:last-child { border-bottom: none; }
  .rel-sidebar-item:hover { background: rgba(168,85,247,0.08); }
  .rel-sidebar-item.active { background: rgba(168,85,247,0.12); }

  /* ── UPLOAD PROGRESS ── */
  .upload-progress-overlay {
    position: fixed; inset: 0; background: rgba(10,8,20,0.6);
    backdrop-filter: blur(6px); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
  }
  .upload-progress-card {
    background: #fff; border-radius: 20px; padding: 28px 32px;
    min-width: 380px; max-width: 520px; width: 90vw;
    box-shadow: 0 24px 80px rgba(124,58,237,0.3), 0 4px 16px rgba(0,0,0,0.2);
    border: 1px solid #ece5fb;
  }
  .upload-file-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 0; border-bottom: 1px solid #f3eefe;
  }
  .upload-file-row:last-child { border-bottom: none; }
  .upload-file-icon {
    width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .upload-file-bar { height: 4px; background: #f3e8ff; border-radius: 99px; overflow: hidden; margin-top: 5px; }
  .upload-file-bar-fill {
    height: 100%; border-radius: 99px;
    transition: width 0.15s ease-out;
  }
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .upload-file-bar-fill.loading {
    background: linear-gradient(90deg, #7c3aed 0%, #c084fc 50%, #7c3aed 100%);
    background-size: 200% 100%;
    animation: shimmer 1.2s infinite linear;
  }
  .upload-file-bar-fill.done {
    background: linear-gradient(90deg, #059669, #34d399);
  }

  @media (max-width: 640px) {
    .ftv-root { padding: 1rem 0.75rem 2rem; }
    .nav-tabs { gap: 2px; }
    .nav-tab { padding: 7px 10px; font-size: 12px; }
    .graph-panel { width: 220px; }
    .upload-progress-card { padding: 20px 18px; min-width: unset; }
  }
`;

const TYPE_COLOR = { number: "#3b82f6", date: "#16a34a", text: "#1e1a2e", null: "#c4b5fd", json: "#92400e" };

/* ─────────────────────────────────────────────
   UPLOAD PROGRESS OVERLAY
───────────────────────────────────────────── */
function UploadProgressOverlay({ files }) {
  if (!files || files.length === 0) return null;
  return (
    <div className="upload-progress-overlay">
      <div className="upload-progress-card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg,#5b21b6,#a855f7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CloudUpload size={18} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#1e1a2e", letterSpacing: "-0.02em" }}>Uploading files</div>
            <div style={{ fontSize: 11, color: "#9d8ec4", marginTop: 1 }}>
              {files.filter(f => f.done).length} of {files.length} complete
            </div>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 12, color: "#b8aad6", fontFamily: "'DM Mono', monospace" }}>
            {Math.round(files.reduce((s, f) => s + f.progress, 0) / files.length)}%
          </div>
        </div>

        {/* Overall bar */}
        <div style={{ marginBottom: 20 }}>
          <div className="ftv-progress-bar" style={{ height: 6 }}>
            <div className="ftv-progress-fill" style={{ width: `${files.reduce((s, f) => s + f.progress, 0) / files.length}%` }} />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {files.map((f, i) => (
            <div key={i} className="upload-file-row">
              <div className="upload-file-icon" style={{ background: f.done ? "#f0fdf4" : "#f3e8ff", border: `1px solid ${f.done ? "#bbf7d0" : "#ddd0f9"}` }}>
                {f.done
                  ? <Check size={15} color="#16a34a" />
                  : <File size={15} color="#a855f7" />
                }
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#1e1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{f.name}</span>
                  <span style={{ fontSize: 11, color: f.done ? "#16a34a" : "#a855f7", fontFamily: "'DM Mono', monospace", fontWeight: 600, flexShrink: 0, marginLeft: 8 }}>
                    {f.done ? "✓ Done" : `${f.progress}%`}
                  </span>
                </div>
                <div className="upload-file-bar">
                  <div className={`upload-file-bar-fill ${f.done ? "done" : "loading"}`} style={{ width: `${f.progress}%` }} />
                </div>
                <div style={{ fontSize: 10, color: "#b8aad6", marginTop: 3 }}>{f.sizeLabel}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   TABLE VIEWER COMPONENT
───────────────────────────────────────────── */
function TableViewer({ data, fileName, fileSize }) {
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [visibleCols, setVisibleCols] = useState(() => new Set(data.headers));
  const [selectedCell, setSelectedCell] = useState(null);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [colSearch, setColSearch] = useState("");
  const scrollRef = useRef();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(e => setScrollTop(e.currentTarget.scrollTop), []);

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  };
  const toggleCol = col => setVisibleCols(prev => { const n = new Set(prev); n.has(col) ? n.delete(col) : n.add(col); return n; });
  const toggleAllCols = show => setVisibleCols(show ? new Set(data.headers) : new Set());

  let displayRows = data.rows;
  if (search) {
    const q = search.toLowerCase();
    displayRows = displayRows.filter(r => r.some(c => c.display?.toString().toLowerCase().includes(q)));
  }
  if (sortCol !== null) {
    const idx = data.headers.indexOf(sortCol);
    const sorted = [...displayRows];
    sorted.sort((a, b) => {
      const va = a[idx]?.raw ?? "", vb = b[idx]?.raw ?? "";
      if (va === null && vb === null) return 0;
      if (va === null) return sortDir === "asc" ? 1 : -1;
      if (vb === null) return sortDir === "asc" ? -1 : 1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    displayRows = sorted;
  }

  const totalRows = displayRows.length;
  const activeHeaders = data.headers.filter(h => visibleCols?.has(h));
  const filteredCols = data.headers.filter(h => h.toLowerCase().includes(colSearch.toLowerCase()));
  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

  const totalHeight = totalRows * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(totalRows, startIdx + visibleCount);
  const visibleRows = displayRows.slice(startIdx, endIdx);
  const paddingTop = startIdx * ROW_HEIGHT;
  const paddingBottom = Math.max(0, (totalRows - endIdx) * ROW_HEIGHT);

  const doExport = scope => {
    const hdrs = activeHeaders.length > 0 ? activeHeaders : data.headers;
    const cidxs = hdrs.map(h => data.headers.indexOf(h));
    const rowsToExport = (scope === "filtered" ? displayRows : data.rows).map(row => cidxs.map(ci => row[ci]));
    exportCSV(hdrs, rowsToExport, fileName);
    setShowExportMenu(false);
  };

  return (
    <div onClick={() => { setShowColPicker(false); setShowExportMenu(false); }}>
      <div style={{ display: "flex", gap: 10, marginBottom: "1.25rem", flexWrap: "wrap" }}>
        {[
          { icon: <Rows3 size={13} />, val: data.rows.length.toLocaleString(), label: "Total rows", hl: true },
          { icon: <Columns size={13} />, val: data.headers.length, label: "Columns" },
          { icon: <File size={13} />, val: fmtSize(fileSize), label: "File size" },
          { icon: <Filter size={13} />, val: totalRows.toLocaleString(), label: "Visible rows" },
        ].map(({ icon, val, label, hl }) => (
          <div key={label} className={`ftv-stat-card${hl ? " highlight" : ""}`}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ color: hl ? "rgba(255,255,255,0.6)" : "#b8aad6" }}>{icon}</span>
              <span style={{ fontSize: 10.5, color: hl ? "rgba(255,255,255,0.6)" : "#b8aad6", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>{label}</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, color: hl ? "#fff" : "#1e1a2e", letterSpacing: "-0.03em" }}>{val}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: "1rem", flexWrap: "wrap", alignItems: "center", position: "relative", zIndex: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ position: "relative", flex: "1 1 240px" }}>
          <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#c4b5fd", pointerEvents: "none" }} />
          <input className="ftv-input" type="text" placeholder="Search across all columns…" value={search}
            onChange={e => { setSearch(e.target.value); if (scrollRef.current) scrollRef.current.scrollTop = 0; setScrollTop(0); }}
            style={{ paddingLeft: 36 }} />
        </div>
        <div style={{ position: "relative" }}>
          <button className={`ftv-btn-ghost${showColPicker ? " active" : ""}`} onClick={e => { e.stopPropagation(); setShowColPicker(p => !p); setShowExportMenu(false); }}>
            <Columns size={14} /> Columns <span style={{ opacity: 0.55, fontSize: 11 }}>({visibleCols?.size}/{data.headers.length})</span>
          </button>
          {showColPicker && (
            <div className="ftv-dropdown" style={{ top: "calc(100% + 8px)", left: 0, width: 270, maxHeight: 380, overflowY: "auto" }} onClick={e => e.stopPropagation()}>
              <input className="ftv-input" type="text" placeholder="Filter columns…" value={colSearch} onChange={e => setColSearch(e.target.value)} style={{ marginBottom: 8, fontSize: 12 }} />
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button className="ftv-btn-ghost" style={{ fontSize: 11, flex: 1, padding: "5px 8px", borderRadius: 7 }} onClick={() => toggleAllCols(true)}>Select all</button>
                <button className="ftv-btn-ghost" style={{ fontSize: 11, flex: 1, padding: "5px 8px", borderRadius: 7 }} onClick={() => toggleAllCols(false)}>Clear all</button>
              </div>
              {filteredCols.map(h => {
                const on = visibleCols?.has(h);
                return (
                  <label key={h} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 6px", borderRadius: 8, cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#f3e8ff"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div className={`col-check-box ${on ? "on" : "off"}`}>{on && <Check size={10} color="#fff" />}</div>
                    <input type="checkbox" checked={on} onChange={() => toggleCol(h)} style={{ display: "none" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: on ? "#6d28d9" : "#9d8ec4", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button className="ftv-btn-primary" onClick={e => { e.stopPropagation(); setShowExportMenu(p => !p); setShowColPicker(false); }}>
            <Download size={14} /> Export CSV <ChevronDown size={12} />
          </button>
          {showExportMenu && (
            <div className="ftv-dropdown" style={{ top: "calc(100% + 8px)", right: 0, width: 250 }} onClick={e => e.stopPropagation()}>
              {[
                { scope: "all", icon: <Database size={15} color="#a855f7" />, label: "All rows", sub: `${data.rows.length.toLocaleString()} rows · full dataset` },
                { scope: "filtered", icon: <Filter size={15} color="#a855f7" />, label: "Filtered rows", sub: `${totalRows.toLocaleString()} rows · current view` },
              ].map(({ scope, icon, label, sub }) => (
                <div key={scope} className="ftv-dropdown-item" onClick={() => doExport(scope)}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: "#f3e8ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
                  <div><div style={{ fontSize: 13, color: "#1e1a2e", fontWeight: 500 }}>{label}</div><div style={{ fontSize: 11, color: "#b8aad6", marginTop: 1 }}>{sub}</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#b8aad6", display: "flex", alignItems: "center", gap: 5 }}>
          <Rows3 size={13} color="#c4b5fd" />
          {search ? `${totalRows.toLocaleString()} / ${data.rows.length.toLocaleString()} rows` : `${totalRows.toLocaleString()} rows`}
        </div>
      </div>

      <div className="ftv-card" style={{ borderRadius: 14, overflow: "hidden", position: "relative", zIndex: 1 }}>
        <div ref={scrollRef} onScroll={handleScroll} className="ftv-scroll"
          style={{ height: Math.min(totalRows * ROW_HEIGHT + 2, 560), overflowY: "auto", overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: activeHeaders.length * 120 }}>
            <thead>
              <tr>
                <th className="ftv-th" style={{ textAlign: "center", width: 52, minWidth: 52, cursor: "default", color: "#c4b5fd", borderRight: "1px solid #ede8fb", position: "sticky", top: 0, zIndex: 2 }}>#</th>
                {activeHeaders.map(h => (
                  <th key={h} className={`ftv-th${sortCol === h ? " sorted" : ""}`} onClick={() => toggleSort(h)} style={{ position: "sticky", top: 0, zIndex: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span>{h}</span>
                      {sortCol === h ? (sortDir === "asc" ? <ArrowUp size={11} color="#a855f7" /> : <ArrowDown size={11} color="#a855f7" />) : <ChevronsUpDown size={11} style={{ opacity: 0.3 }} />}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && <tr style={{ height: paddingTop }}><td colSpan={activeHeaders.length + 1} /></tr>}
              {visibleRows.map((row, ri) => {
                const absIdx = startIdx + ri;
                return (
                  <tr key={absIdx} className="ftv-tr" style={{ height: ROW_HEIGHT }}>
                    <td className="ftv-td" style={{ textAlign: "center", color: "#c4b5fd", fontFamily: "'DM Mono', monospace", fontSize: 11, background: "#faf5ff", borderRight: "1px solid #ede8fb", width: 52, minWidth: 52, padding: "0 8px" }}>
                      {absIdx + 1}
                    </td>
                    {activeHeaders.map((h, ci) => {
                      const colIdx = data.headers.indexOf(h);
                      const cell = row[colIdx];
                      const isSelected = selectedCell?.r === absIdx && selectedCell?.c === ci;
                      return (
                        <td key={h} className={`ftv-td${isSelected ? " selected" : ""}`}
                          onClick={() => setSelectedCell(isSelected ? null : { r: absIdx, c: ci, value: cell?.raw, header: h, type: cell?.type })}
                          style={{ color: TYPE_COLOR[cell?.type ?? "text"], fontFamily: cell?.type === "number" || cell?.type === "date" ? "'DM Mono', monospace" : "'DM Sans', sans-serif", textAlign: cell?.type === "number" ? "right" : "left", height: ROW_HEIGHT, padding: "0 14px" }}>
                          {cell?.type === "json" ? <span className="ftv-badge-json">JSON</span> : cell?.type === "null" ? <span className="ftv-badge-null">—</span> : cell?.display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {paddingBottom > 0 && <tr style={{ height: paddingBottom }}><td colSpan={activeHeaders.length + 1} /></tr>}
              {totalRows === 0 && (
                <tr><td colSpan={activeHeaders.length + 1} style={{ padding: "4rem", textAlign: "center", color: "#c4b5fd" }}>
                  <Meh size={32} style={{ display: "block", margin: "0 auto 10px", opacity: 0.4 }} />
                  <div style={{ fontSize: 14 }}>No rows match your search</div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "6px 14px", borderTop: "1px solid #f3eefe", background: "#faf5ff", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#b8aad6", fontFamily: "'DM Mono', monospace" }}>
            rows {Math.min(startIdx + 1, totalRows).toLocaleString()}–{Math.min(endIdx, totalRows).toLocaleString()} of {totalRows.toLocaleString()} visible
          </span>
          <span style={{ fontSize: 11, color: "#c4b5fd" }}>scroll to explore all {data.rows.length.toLocaleString()} rows</span>
        </div>
      </div>

      {selectedCell && (
        <div className="ftv-card" style={{ marginTop: "1rem", padding: "1rem 1.25rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 500, color: "#7c3aed", fontSize: 13 }}>{selectedCell.header}</span>
              {selectedCell.type && <span className={`chip chip-${selectedCell.type}`}>{selectedCell.type}</span>}
            </div>
            <button className="ftv-btn-ghost" style={{ padding: "4px 10px", borderRadius: 7, fontSize: 12 }} onClick={() => setSelectedCell(null)}><X size={12} /> close</button>
          </div>
          <pre style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1e1a2e", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#faf5ff", padding: "12px 14px", borderRadius: 10, border: "1px solid #ede8fb" }}>
            {selectedCell.value === null ? "(null)" : JSON.stringify(selectedCell.value, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   ANALYTICS COMPONENT
───────────────────────────────────────────── */
function Analytics({ data, tableName }) {
  const [selectedCol, setSelectedCol] = useState(null);
  const [chartType, setChartType] = useState("bar");

  const colTypes = useMemo(() => {
    if (!data) return {};
    return Object.fromEntries(data.headers.map(h => {
      const idx = data.headers.indexOf(h);
      const types = data.rows.slice(0, 200).map(r => r[idx]?.type).filter(Boolean);
      const numCount = types.filter(t => t === "number").length;
      const dateCount = types.filter(t => t === "date").length;
      if (numCount > types.length * 0.5) return [h, "number"];
      if (dateCount > types.length * 0.5) return [h, "date"];
      return [h, "text"];
    }));
  }, [data]);

  const activeCol = selectedCol || data?.headers[0];
  const activeIdx = data ? data.headers.indexOf(activeCol) : -1;
  const activeType = colTypes[activeCol] || "text";
  const stats = data && activeIdx >= 0 ? computeColumnStats(data.rows, activeIdx, activeType) : null;
  const histData = data && activeType === "number" && activeIdx >= 0 ? buildHistogram(data.rows, activeIdx) : null;
  const barData = stats?.topValues ? stats.topValues.map(([name, count]) => ({ name: String(name).slice(0, 20), count })) : null;

  if (!data) return <div style={{ padding: "3rem", textAlign: "center", color: "#c4b5fd" }}>No data loaded</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1.25rem", alignItems: "start" }}>
      <div className="ftv-card ftv-scroll" style={{ padding: "1rem", maxHeight: 600, overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#9d8ec4", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>Columns</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {data.headers.map(h => {
            const t = colTypes[h];
            const icon = t === "number" ? <Hash size={11} color="#3b82f6" /> : t === "date" ? <Calendar size={11} color="#16a34a" /> : <Type size={11} color="#a855f7" />;
            return (
              <div key={h} className={`analytics-col-card${activeCol === h ? " active" : ""}`} onClick={() => setSelectedCol(h)}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  {icon}
                  <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: activeCol === h ? "#7c3aed" : "#3d3557", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <div className="ftv-card" style={{ padding: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#1e1a2e", letterSpacing: "-0.02em" }}>{activeCol}</div>
              <span className={`chip chip-${activeType === "number" ? "num" : activeType === "date" ? "date" : "text"}`} style={{ marginTop: 4 }}>{activeType}</span>
            </div>
            {(histData || barData) && (
              <div style={{ display: "flex", gap: 4 }}>
                {["bar", "line", "pie"].map(t => (
                  <button key={t} className={`ftv-btn-ghost${chartType === t ? " active" : ""}`} style={{ padding: "5px 10px", fontSize: 11, borderRadius: 7 }} onClick={() => setChartType(t)}>{t}</button>
                ))}
              </div>
            )}
          </div>
          {stats && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginBottom: "1.25rem" }}>
              {(activeType === "number" ? [
                { label: "Count", val: stats.count?.toLocaleString() },
                { label: "Null", val: stats.nullCount?.toLocaleString() },
                { label: "Min", val: stats.min?.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
                { label: "Max", val: stats.max?.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
                { label: "Mean", val: stats.mean?.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
                { label: "Sum", val: stats.sum?.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
              ] : [
                { label: "Count", val: stats.count?.toLocaleString() },
                { label: "Null", val: stats.nullCount?.toLocaleString() },
                { label: "Unique", val: stats.unique?.toLocaleString() },
              ]).map(({ label, val }) => (
                <div key={label} style={{ background: "#faf5ff", border: "1px solid #ede8fb", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10.5, color: "#b8aad6", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "#1e1a2e", letterSpacing: "-0.02em", fontFamily: "'DM Mono', monospace" }}>{val ?? "—"}</div>
                </div>
              ))}
            </div>
          )}
          {(histData || barData) && (
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                {chartType === "pie" && barData ? (
                  <PieChart>
                    <Pie data={barData} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {barData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                ) : chartType === "line" ? (
                  <LineChart data={histData || barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3eefe" />
                    <XAxis dataKey={histData ? "range" : "name"} tick={{ fontSize: 10, fill: "#9d8ec4" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#9d8ec4" }} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #ece5fb", fontSize: 12 }} />
                    <Line type="monotone" dataKey="count" stroke="#a855f7" strokeWidth={2} dot={false} />
                  </LineChart>
                ) : (
                  <BarChart data={histData || barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3eefe" />
                    <XAxis dataKey={histData ? "range" : "name"} tick={{ fontSize: 10, fill: "#9d8ec4" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#9d8ec4" }} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #ece5fb", fontSize: 12 }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {(histData || barData).map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SCHEMA ERD VIEW — draggable cards + fullscreen
───────────────────────────────────────────── */
const ERD_LAYOUT_OFFSETS = [
  { x: 0, y: 0 },
  { x: 320, y: 0 },
  { x: 640, y: 0 },
  { x: 960, y: 0 },
  { x: 160, y: 340 },
  { x: 480, y: 340 },
  { x: 800, y: 340 },
  { x: 0, y: 680 },
  { x: 320, y: 680 },
];

function inferColType(header) {
  const h = header.toLowerCase();
  if (h.startsWith("id_") || h.endsWith("_id") || h === "id") return "pk";
  if (h.startsWith("code_") || h.endsWith("_code")) return "fk";
  if (h.includes("date") || h.includes("time")) return "date";
  if (h.includes("montant") || h.includes("prix") || h.includes("tva") || h.includes("note")) return "num";
  return "text";
}

function SchemaERD({ tables, relationships, isFullscreen, onToggleFullscreen }) {
  const [search, setSearch] = useState("");
  const [selectedRel, setSelectedRel] = useState(null);
  const [hoveredTable, setHoveredTable] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const viewportRef = useRef();
  const panRef = useRef({ isPanning: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const [cam, setCam] = useState({ x: 40, y: 40, scale: 1 });

  // Draggable card positions stored in state
  const tableNames = Object.keys(tables);
  const PAD = 40;
  const CARD_W = 220;
  const CARD_H_BASE = 46;
  const ROW_H = 26;
  const MAX_COLS = 6;

  const initialPositions = useMemo(() => {
    return Object.fromEntries(tableNames.map((name, i) => {
      const off = ERD_LAYOUT_OFFSETS[i] || { x: (i % 4) * 300, y: Math.floor(i / 4) * 380 };
      return [name, { x: PAD + off.x, y: PAD + off.y }];
    }));
  }, [tableNames.join(",")]);

  const [cardPositions, setCardPositions] = useState(initialPositions);

  // Update positions when tables change
  useEffect(() => {
    setCardPositions(initialPositions);
  }, [tableNames.join(",")]);

  // Card drag state
  const cardDragRef = useRef(null); // { name, startMouseX, startMouseY, startCardX, startCardY }

  const highlighted = useMemo(() => {
    if (!search) return new Set();
    const q = search.toLowerCase();
    return new Set(tableNames.filter(n => n.toLowerCase().includes(q)));
  }, [search, tableNames]);

  const cardHeight = name => CARD_H_BASE + Math.min(tables[name].headers.length, MAX_COLS) * ROW_H + (tables[name].headers.length > MAX_COLS ? 24 : 4);

  const getAnchor = (tableName, colName, side) => {
    const pos = cardPositions[tableName];
    if (!pos) return null;
    const cols = tables[tableName].headers;
    const ci = cols.indexOf(colName);
    const y = pos.y + CARD_H_BASE + (ci < MAX_COLS ? ci + 0.5 : MAX_COLS - 0.5) * ROW_H;
    const x = side === "right" ? pos.x + CARD_W : pos.x;
    return { x, y };
  };

  const canvasW = Math.max(...tableNames.map((n) => (cardPositions[n]?.x || 0) + CARD_W + PAD * 4), 900);
  const canvasH = Math.max(...tableNames.map((n) => (cardPositions[n]?.y || 0) + cardHeight(n) + PAD * 4), 700);

  // Viewport pan
  const onMouseDown = useCallback(e => {
    if (e.target.closest(".erd-table-card")) return;
    panRef.current = {
      isPanning: true,
      startX: e.clientX,
      startY: e.clientY,
      camX: cam.x,
      camY: cam.y,
    };
    viewportRef.current.style.cursor = "grabbing";
    e.preventDefault();
  }, [cam]);

  const onMouseMove = useCallback(e => {
    // Card drag takes priority
    if (cardDragRef.current) {
      const { name, startMouseX, startMouseY, startCardX, startCardY } = cardDragRef.current;
      const dx = (e.clientX - startMouseX) / cam.scale;
      const dy = (e.clientY - startMouseY) / cam.scale;
      setCardPositions(prev => ({
        ...prev,
        [name]: { x: Math.max(0, startCardX + dx), y: Math.max(0, startCardY + dy) }
      }));
      return;
    }
    if (!panRef.current.isPanning) return;
    const dx = e.clientX - panRef.current.startX;
    const dy = e.clientY - panRef.current.startY;
    setCam(c => ({ ...c, x: panRef.current.camX + dx, y: panRef.current.camY + dy }));
  }, [cam.scale]);

  const onMouseUp = useCallback(() => {
    cardDragRef.current = null;
    panRef.current.isPanning = false;
    if (viewportRef.current) viewportRef.current.style.cursor = "grab";
  }, []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    const rect = viewportRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.11;
    setCam(c => {
      const newScale = Math.max(0.3, Math.min(2.5, c.scale * delta));
      const wx = (mx - c.x) / c.scale;
      const wy = (my - c.y) / c.scale;
      return {
        scale: newScale,
        x: mx - wx * newScale,
        y: my - wy * newScale,
      };
    });
  }, []);

  const fitView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const W = vp.clientWidth, H = vp.clientHeight;
    const xs = tableNames.map(n => cardPositions[n]?.x || 0);
    const ys = tableNames.map(n => cardPositions[n]?.y || 0);
    const minX = Math.min(...xs) - PAD;
    const maxX = Math.max(...xs) + CARD_W + PAD * 2;
    const minY = Math.min(...ys) - PAD;
    const maxY = Math.max(...ys.map((y, i) => y + cardHeight(tableNames[i]))) + PAD * 2;
    const cw = maxX - minX || 1, ch = maxY - minY || 1;
    const scaleX = (W - 40) / cw;
    const scaleY = (H - 40) / ch;
    const scale = Math.min(scaleX, scaleY, 1.2);
    setCam({
      scale,
      x: (W - cw * scale) / 2 - minX * scale,
      y: (H - ch * scale) / 2 - minY * scale,
    });
  }, [tableNames, cardPositions]);

  useEffect(() => {
    fitView();
  }, [tableNames.length, isFullscreen]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Card drag start
  const onCardMouseDown = useCallback((e, name) => {
    e.stopPropagation();
    const pos = cardPositions[name];
    cardDragRef.current = {
      name,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startCardX: pos.x,
      startCardY: pos.y,
    };
  }, [cardPositions]);

  return (
    <div style={{ display: "flex", gap: 12, position: "relative" }}>
      <div className={`erd-root${isFullscreen ? " fullscreen-erd" : ""}`} style={{ flex: 1, borderRadius: isFullscreen ? 0 : 16 }}>
        <div
          ref={viewportRef}
          className="erd-viewport"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          <div
            className="erd-canvas-inner"
            style={{
              transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`,
              width: canvasW,
              height: canvasH,
            }}
          >
            <svg
              style={{ position: "absolute", inset: 0, width: canvasW, height: canvasH, pointerEvents: "none", overflow: "visible" }}
            >
              <defs>
                <marker id="erd-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="rgba(168,85,247,0.7)" />
                </marker>
                <marker id="erd-arrow-active" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#a855f7" />
                </marker>
              </defs>
              {relationships.map((rel, i) => {
                const isActive = selectedRel === i ||
                  (hoveredTable && (hoveredTable === rel.from || hoveredTable === rel.to));
                const fromPos = cardPositions[rel.from];
                const toPos = cardPositions[rel.to];
                if (!fromPos || !toPos) return null;

                const fromRight = fromPos.x < toPos.x;
                const aFrom = getAnchor(rel.from, rel.column, fromRight ? "right" : "left");
                const aTo = getAnchor(rel.to, rel.column, fromRight ? "left" : "right");
                if (!aFrom || !aTo) return null;

                const cpOffset = Math.abs(aTo.x - aFrom.x) * 0.45;
                const d = `M ${aFrom.x} ${aFrom.y} C ${aFrom.x + (fromRight ? cpOffset : -cpOffset)} ${aFrom.y}, ${aTo.x + (fromRight ? -cpOffset : cpOffset)} ${aTo.y}, ${aTo.x} ${aTo.y}`;

                return (
                  <g key={i} style={{ pointerEvents: "all", cursor: "pointer" }} onClick={() => setSelectedRel(selectedRel === i ? null : i)}>
                    <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                    {isActive && <path d={d} fill="none" stroke="rgba(168,85,247,0.2)" strokeWidth={6} />}
                    <path d={d} fill="none"
                      stroke={isActive ? "#a855f7" : "rgba(168,85,247,0.3)"}
                      strokeWidth={isActive ? 1.8 : 1}
                      strokeDasharray={rel.type === "N:M" ? "6 3" : "none"}
                      markerEnd={`url(#${isActive ? "erd-arrow-active" : "erd-arrow"})`}
                    />
                    {isActive && (() => {
                      const mx = (aFrom.x + aTo.x) / 2;
                      const my = (aFrom.y + aTo.y) / 2 - 2;
                      return (
                        <g>
                          <rect x={mx - 40} y={my - 9} width={80} height={16} rx={4} fill="rgba(10,10,20,0.9)" stroke="rgba(168,85,247,0.3)" strokeWidth={0.8} />
                          <text x={mx} y={my + 3} textAnchor="middle" fill="#c084fc" fontSize={9} fontFamily="'DM Mono',monospace">{rel.column}</text>
                        </g>
                      );
                    })()}
                    {isActive && (() => {
                      const mx = (aFrom.x + aTo.x) / 2;
                      const my = (aFrom.y + aTo.y) / 2 + 12;
                      return (
                        <g>
                          <rect x={mx - 14} y={my - 7} width={28} height={13} rx={3} fill="rgba(168,85,247,0.15)" stroke="rgba(168,85,247,0.25)" strokeWidth={0.6} />
                          <text x={mx} y={my + 3} textAnchor="middle" fill="#a855f7" fontSize={8} fontFamily="'DM Mono',monospace" fontWeight="600">{rel.type}</text>
                        </g>
                      );
                    })()}
                  </g>
                );
              })}
            </svg>

            {tableNames.map((name, i) => {
              const pos = cardPositions[name] || { x: 0, y: 0 };
              const color = TABLE_PALETTE[i % TABLE_PALETTE.length];
              const cols = tables[name].headers;
              const isHighlighted = highlighted.has(name) || hoveredTable === name ||
                (selectedRel !== null && (relationships[selectedRel]?.from === name || relationships[selectedRel]?.to === name));
              const isDraggingThis = cardDragRef.current?.name === name;

              return (
                <div key={name}
                  className={`erd-table-card${isHighlighted ? " highlighted" : ""}${isDraggingThis ? " dragging-card" : ""}`}
                  style={{ left: pos.x, top: pos.y, borderColor: isHighlighted ? color.fill + "aa" : undefined, boxShadow: isHighlighted ? `0 4px 24px rgba(0,0,0,0.4), 0 0 24px -4px ${color.fill}55` : undefined }}
                  onMouseEnter={() => setHoveredTable(name)}
                  onMouseLeave={() => setHoveredTable(null)}
                  onMouseDown={e => onCardMouseDown(e, name)}
                >
                  <div className="erd-card-header" style={{ borderBottomColor: color.fill + "33" }}>
                    <div className="erd-card-icon" style={{ background: `linear-gradient(135deg, ${color.dark}, ${color.fill})` }}>
                      <Database size={11} color="#fff" />
                    </div>
                    <div className="erd-card-name">{name}</div>
                    <div className="erd-card-rows">{tables[name].rows.length}</div>
                  </div>
                  {cols.slice(0, MAX_COLS).map(col => {
                    const t = inferColType(col);
                    const linkedRels = relationships.filter(r => r.column === col && (r.from === name || r.to === name));
                    const isLinked = linkedRels.length > 0;
                    return (
                      <div key={col} className="erd-col-row">
                        {t === "pk" ? (
                          <span style={{ fontSize: 10, color: "#fcd34d" }}>🔑</span>
                        ) : isLinked ? (
                          <Link2 size={9} color="#67e8f9" />
                        ) : (
                          <span style={{ width: 9, height: 9, borderRadius: 2, border: "1px solid rgba(255,255,255,0.12)", display: "inline-block", flexShrink: 0 }} />
                        )}
                        <span className={`erd-col-name${t === "pk" ? " pk" : isLinked ? " fk" : ""}`}>{col}</span>
                        <span className="erd-col-type">{t === "pk" || isLinked ? "KEY" : t === "date" ? "DATE" : t === "num" ? "NUM" : "TXT"}</span>
                      </div>
                    );
                  })}
                  {cols.length > MAX_COLS && (
                    <div className="erd-more">+{cols.length - MAX_COLS} more columns</div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(168,85,247,0.12) 1px, transparent 1px)", backgroundSize: "28px 28px", pointerEvents: "none", zIndex: 0, borderRadius: isFullscreen ? 0 : 16 }} />
        </div>

        <div className="erd-search-bar">
          <Search size={13} color="#4d4567" />
          <input className="erd-search-input" placeholder="Search tables…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", color: "#6b6882", cursor: "pointer", padding: 0, fontSize: 12 }}>✕</button>}
        </div>

        <div className="erd-zoom-controls">
          <button className="erd-zoom-btn" title="Zoom in" onClick={() => setCam(c => ({ ...c, scale: Math.min(2.5, c.scale * 1.2) }))}>+</button>
          <button className="erd-zoom-btn" title="Fit view" onClick={fitView} style={{ fontSize: 11 }}>⊡</button>
          <button className="erd-zoom-btn" title="Zoom out" onClick={() => setCam(c => ({ ...c, scale: Math.max(0.3, c.scale * 0.85) }))}>−</button>
        </div>

        <button
          className="erd-sidebar-toggle"
          title={sidebarOpen ? "Hide sidebar" : "Show links"}
          onClick={() => setSidebarOpen(p => !p)}
        >
          {sidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>

        <button
          className="erd-fullscreen-btn"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        <div className="erd-hint">Drag cards · Pan canvas · Scroll to zoom</div>
      </div>

      {!isFullscreen && (
        <div className={`erd-sidebar-wrap ${sidebarOpen ? "open" : "closed"}`}>
          <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#4d4567", letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 0 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Discovered links · {relationships.length}</span>
              <button onClick={() => setSidebarOpen(false)} style={{ background: "none", border: "none", color: "#6b6882", cursor: "pointer", padding: 0 }}>
                <X size={12} />
              </button>
            </div>
            <div className="rel-sidebar" style={{ maxHeight: 520, overflowY: "auto" }}>
              {relationships.map((rel, i) => (
                <div key={i} className={`rel-sidebar-item${selectedRel === i ? " active" : ""}`}
                  onClick={() => setSelectedRel(selectedRel === i ? null : i)}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "#4d4567" }}>{rel.type}</span>
                    <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: rel.overlap > 10 ? "#34d399" : "#fcd34d", fontWeight: 600 }}>{rel.overlap} rows</span>
                  </div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10.5 }}>
                    <div style={{ color: "#67e8f9" }}>{rel.from}</div>
                    <div style={{ color: "#5b5378", marginTop: 1 }}>→ <span style={{ color: "#c084fc" }}>{rel.to}</span></div>
                  </div>
                  <div style={{ marginTop: 4, fontSize: 10, color: "#6b6882" }}>
                    via <span style={{ color: "#a78bfa", fontFamily: "'DM Mono', monospace" }}>{rel.column}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen sidebar overlay */}
      {isFullscreen && sidebarOpen && (
        <div style={{ position: "fixed", right: 16, top: 70, zIndex: 10000, width: 240, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#a89fc8", letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 0 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Links · {relationships.length}</span>
            <button onClick={() => setSidebarOpen(false)} style={{ background: "none", border: "none", color: "#6b6882", cursor: "pointer", padding: 0 }}>
              <X size={12} />
            </button>
          </div>
          <div className="rel-sidebar" style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
            {relationships.map((rel, i) => (
              <div key={i} className={`rel-sidebar-item${selectedRel === i ? " active" : ""}`}
                onClick={() => setSelectedRel(selectedRel === i ? null : i)}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "#4d4567" }}>{rel.type}</span>
                  <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: rel.overlap > 10 ? "#34d399" : "#fcd34d", fontWeight: 600 }}>{rel.overlap} rows</span>
                </div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10.5 }}>
                  <div style={{ color: "#67e8f9" }}>{rel.from}</div>
                  <div style={{ color: "#5b5378", marginTop: 1 }}>→ <span style={{ color: "#c084fc" }}>{rel.to}</span></div>
                </div>
                <div style={{ marginTop: 4, fontSize: 10, color: "#6b6882" }}>
                  via <span style={{ color: "#a78bfa", fontFamily: "'DM Mono', monospace" }}>{rel.column}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   FORCE-DIRECTED RELATIONSHIP GRAPH
───────────────────────────────────────────── */
const TABLE_PALETTE = [
  { fill: "#7c3aed", glow: "rgba(124,58,237,0.45)", light: "#c4b5fd", dark: "#5b21b6" },
  { fill: "#0891b2", glow: "rgba(8,145,178,0.45)", light: "#67e8f9", dark: "#0e7490" },
  { fill: "#059669", glow: "rgba(5,150,105,0.45)", light: "#6ee7b7", dark: "#047857" },
  { fill: "#d97706", glow: "rgba(217,119,6,0.45)", light: "#fcd34d", dark: "#b45309" },
  { fill: "#db2777", glow: "rgba(219,39,119,0.45)", light: "#f9a8d4", dark: "#be185d" },
  { fill: "#2563eb", glow: "rgba(37,99,235,0.45)", light: "#93c5fd", dark: "#1d4ed8" },
];

function RelationshipView({ tables }) {
  const canvasRef = useRef(null);
  const minimapRef = useRef(null);
  const stateRef = useRef({
    nodes: [], edges: [], cam: { x: 0, y: 0, scale: 1 },
    drag: null, hover: null, selected: null,
    panStart: null, panCam: null,
    physicsOn: true, showLabels: false,
    tick: 0, particles: [],
    raf: null, W: 0, H: 0
  });
  const [selectedNode, setSelectedNode] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [physicsOn, setPhysicsOn] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [graphView, setGraphView] = useState("circular");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isErdFullscreen, setIsErdFullscreen] = useState(false);

  const relationships = useMemo(() => detectRelationships(tables), [tables]);
  const tableNames = Object.keys(tables);

  // ESC key to exit fullscreen
  useEffect(() => {
    const handler = e => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
        setIsErdFullscreen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth || 600;
    const H = canvas.clientHeight || 520;
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.38;

    s.nodes = tableNames.map((name, i) => {
      const angle = (i / tableNames.length) * Math.PI * 2 - Math.PI / 2;
      const color = TABLE_PALETTE[i % TABLE_PALETTE.length];
      return {
        id: name, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle),
        vx: 0, vy: 0, fx: 0, fy: 0,
        headers: tables[name].headers, rowCount: tables[name].rows.length,
        color, r: 58,
      };
    });

    s.edges = relationships.map(rel => ({
      ...rel,
      fromN: s.nodes.find(n => n.id === rel.from),
      toN: s.nodes.find(n => n.id === rel.to),
    })).filter(e => e.fromN && e.toN);

    fitView();
  }, [tables, relationships]);

  useEffect(() => { stateRef.current.physicsOn = physicsOn; }, [physicsOn]);
  useEffect(() => { stateRef.current.showLabels = showLabels; }, [showLabels]);

  // Re-fit when fullscreen changes
  useEffect(() => {
    setTimeout(() => fitView(), 50);
  }, [isFullscreen]);

  const fitView = useCallback(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.nodes.length) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const xs = s.nodes.map(n => n.x), ys = s.nodes.map(n => n.y);
    const pad = 130;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const sw = maxX - minX || 1, sh = maxY - minY || 1;
    const scale = Math.min((W * 0.85) / sw, (H * 0.80) / sh, 1.6);
    s.cam.scale = scale;
    s.cam.x = W / 2 - ((minX + maxX) / 2) * scale;
    s.cam.y = H / 2 - ((minY + maxY) / 2) * scale;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const minimap = minimapRef.current;
    if (!canvas || !minimap) return;
    const ctx = canvas.getContext("2d");
    const mctx = minimap.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const s = stateRef.current;

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      s.W = rect.width; s.H = Math.max(480, rect.height - 52);
      canvas.width = s.W * dpr; canvas.height = s.H * dpr;
      canvas.style.width = s.W + "px"; canvas.style.height = s.H + "px";
      ctx.scale(dpr, dpr);
      minimap.width = 96 * dpr; minimap.height = 66 * dpr;
      minimap.style.width = "96px"; minimap.style.height = "66px";
      mctx.scale(dpr, dpr);
    }

    function applyPhysics() {
      if (!s.physicsOn) return;
      const repulse = 22000, springK = 0.022, damping = 0.88, centerK = 0.002;
      const MAX_VEL = 6;
      const { nodes, edges } = s;
      const cx = s.W / 2, cy = s.H / 2;

      const totalKE = nodes.reduce((sum, n) => sum + n.vx * n.vx + n.vy * n.vy, 0);
      if (totalKE < 0.08 && s.tick > 120) { s.physicsOn = false; return; }

      for (let i = 0; i < nodes.length; i++) {
        let fx = 0, fy = 0;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const minDist = nodes[i].r + nodes[j].r + 120;
          const f = d < minDist ? repulse * 2 / (d * d) : repulse / (d * d);
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
        fx += (cx - nodes[i].x) * centerK;
        fy += (cy - nodes[i].y) * centerK;
        nodes[i].fx = fx; nodes[i].fy = fy;
      }
      for (const e of edges) {
        const dx = e.toN.x - e.fromN.x, dy = e.toN.y - e.fromN.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = 300, f = (d - rest) * springK;
        const efx = (dx / d) * f, efy = (dy / d) * f;
        e.fromN.fx += efx; e.fromN.fy += efy;
        e.toN.fx -= efx; e.toN.fy -= efy;
      }
      for (const n of nodes) {
        if (n === s.drag) continue;
        n.vx = Math.max(-MAX_VEL, Math.min(MAX_VEL, (n.vx + n.fx) * damping));
        n.vy = Math.max(-MAX_VEL, Math.min(MAX_VEL, (n.vy + n.fy) * damping));
        n.x += n.vx; n.y += n.vy;
      }
    }

    function spawnParticle(e) {
      if (s.tick % 4 !== 0) return;
      const t = Math.random();
      s.particles.push({
        x: e.fromN.x + (e.toN.x - e.fromN.x) * t,
        y: e.fromN.y + (e.toN.y - e.fromN.y) * t,
        life: 1, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
        color: e.fromN.color.fill
      });
      if (s.particles.length > 80) s.particles.shift();
    }

    function drawScene() {
      const { W, H, cam, nodes, edges, particles, selected, hover } = s;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.scale, cam.scale);

      const gs = 56, ox = -cam.x / cam.scale, oy = -cam.y / cam.scale;
      const vw = W / cam.scale, vh = H / cam.scale;
      const sx = Math.floor(ox / gs) * gs, sy2 = Math.floor(oy / gs) * gs;
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      for (let gx = sx; gx < ox + vw + gs; gx += gs)
        for (let gy = sy2; gy < oy + vh + gs; gy += gs) {
          ctx.beginPath(); ctx.arc(gx, gy, 1, 0, Math.PI * 2); ctx.fill();
        }

      for (const e of edges) {
        const { fromN: f, toN: t } = e;
        const dx = t.x - f.x, dy = t.y - f.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / d, ny = dy / d;
        const x1 = f.x + nx * f.r, y1 = f.y + ny * f.r;
        const x2 = t.x - nx * t.r - nx * 8, y2 = t.y - ny * t.r - ny * 8;
        const isActive = selected && (selected.id === f.id || selected.id === t.id);

        if (isActive) {
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          ctx.strokeStyle = f.color.fill + "44";
          ctx.lineWidth = 6; ctx.stroke();
        }

        ctx.setLineDash(e.type === "N:M" ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.strokeStyle = isActive ? f.color.fill : "rgba(168,85,247,0.35)";
        ctx.lineWidth = isActive ? 1.8 : 1; ctx.stroke();
        ctx.setLineDash([]);

        const ax = x2 - nx * 9 - ny * 4.5, ay = y2 - ny * 9 + nx * 4.5;
        const bx = x2 - nx * 9 + ny * 4.5, by = y2 - ny * 9 - nx * 4.5;
        ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(ax, ay); ctx.lineTo(bx, by); ctx.closePath();
        ctx.fillStyle = isActive ? f.color.fill : "rgba(168,85,247,0.5)";
        ctx.fill();

        if (isActive) {
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          ctx.font = "500 10px 'DM Mono',monospace";
          const tw = ctx.measureText(e.column).width + 16;
          ctx.fillStyle = "rgba(10,10,20,0.88)";
          ctx.beginPath(); ctx.roundRect(mx - tw / 2, my - 10, tw, 18, 5); ctx.fill();
          ctx.fillStyle = f.color.light;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(e.column, mx, my);
          const ob = `${e.overlap} rows`;
          const ow = ctx.measureText(ob).width + 12;
          ctx.fillStyle = "rgba(10,10,20,0.7)";
          ctx.beginPath(); ctx.roundRect(mx - ow / 2, my + 12, ow, 14, 4); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.font = "400 9px 'DM Mono',monospace";
          ctx.fillText(ob, mx, my + 19);
          spawnParticle(e);
        }
      }

      for (const p of particles) {
        const alpha = Math.floor(p.life * 200).toString(16).padStart(2, "0");
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = p.color + alpha; ctx.fill();
        p.x += p.vx; p.y += p.vy; p.life -= 0.035;
      }
      s.particles = particles.filter(p => p.life > 0);

      for (const n of nodes) {
        const isSel = selected === n, isHov = hover === n;
        ctx.save();
        ctx.translate(n.x, n.y);
        const scale = isSel ? 1.1 : isHov ? 1.05 : 1;
        if (scale !== 1) ctx.scale(scale, scale);

        if (isSel || isHov) {
          const g = ctx.createRadialGradient(0, 0, n.r * 0.6, 0, 0, n.r * 2.2);
          g.addColorStop(0, n.color.fill + (isSel ? "50" : "30"));
          g.addColorStop(1, "transparent");
          ctx.beginPath(); ctx.arc(0, 0, n.r * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = g; ctx.fill();
        }

        const phase = (s.tick * 0.018 + nodes.indexOf(n) * 1.1) % (Math.PI * 2);
        const pr = n.r + 6 + Math.sin(phase) * 3;
        ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2);
        ctx.strokeStyle = n.color.fill; ctx.lineWidth = 0.7;
        ctx.globalAlpha = 0.18 + Math.sin(phase) * 0.08; ctx.stroke();
        ctx.globalAlpha = 1;

        if (isSel) {
          ctx.beginPath(); ctx.arc(0, 0, n.r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = n.color.fill; ctx.lineWidth = 2; ctx.globalAlpha = 0.8; ctx.stroke();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath(); ctx.arc(0, 0, n.r, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(-n.r * 0.25, -n.r * 0.25, 0, 0, 0, n.r);
        grad.addColorStop(0, n.color.fill + "2a");
        grad.addColorStop(1, "#0a0a12");
        ctx.fillStyle = grad; ctx.fill();
        ctx.strokeStyle = n.color.fill; ctx.lineWidth = isSel ? 2 : 1.5;
        ctx.globalAlpha = isSel ? 1 : 0.75; ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fillStyle = n.color.fill + "cc"; ctx.fill();

        const words = n.id.replace(/_/g, " ").split(" ");
        ctx.font = "600 11px 'DM Sans',sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = n.color.light;
        if (words.length > 1) {
          ctx.fillText(words[0], 0, -8);
          ctx.fillText(words.slice(1).join(" "), 0, 8);
        } else {
          ctx.fillText(n.id, 0, 0);
        }

        ctx.font = "400 9px 'DM Mono',monospace";
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fillText(n.rowCount + " rows", 0, n.r + 14);

        if (s.showLabels) {
          const linkedCols = new Set(relationships.filter(r => r.from === n.id || r.to === n.id).map(r => r.column));
          const cols = n.headers.slice(0, 7);
          const angleStep = (Math.PI * 1.4) / Math.max(cols.length - 1, 1);
          const startA = -Math.PI * 0.7;
          cols.forEach((col, ci) => {
            const a = startA + ci * angleStep;
            const cr = n.r + 52;
            const cx2 = Math.cos(a) * cr, cy2 = Math.sin(a) * cr;
            const isLink = linkedCols.has(col);
            ctx.beginPath(); ctx.moveTo(Math.cos(a) * n.r, Math.sin(a) * n.r); ctx.lineTo(cx2, cy2);
            ctx.strokeStyle = isLink ? "#34d399" : "rgba(255,255,255,0.12)";
            ctx.lineWidth = isLink ? 1.2 : 0.7; ctx.stroke();
            ctx.beginPath(); ctx.arc(cx2, cy2, isLink ? 3.5 : 2.5, 0, Math.PI * 2);
            ctx.fillStyle = isLink ? "#34d399" : "rgba(255,255,255,0.2)"; ctx.fill();
            const short = col.length > 13 ? col.slice(0, 13) + "…" : col;
            ctx.font = "400 8px 'DM Mono',monospace";
            ctx.fillStyle = isLink ? "#6ee7b7" : "rgba(255,255,255,0.35)";
            ctx.textAlign = Math.cos(a) > 0.1 ? "left" : Math.cos(a) < -0.1 ? "right" : "center";
            ctx.textBaseline = "middle";
            const pad = 6;
            ctx.fillText(short, cx2 + Math.cos(a) * pad, cy2 + Math.sin(a) * pad);
          });
          ctx.textAlign = "center";
        }

        ctx.restore();
      }
      ctx.restore();
    }

    function drawMinimap() {
      const { nodes, edges, cam } = s;
      mctx.clearRect(0, 0, 96, 66);
      mctx.fillStyle = "rgba(13,13,20,0.7)";
      mctx.fillRect(0, 0, 96, 66);
      if (!nodes.length) return;
      const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
      const minX = Math.min(...xs) - 70, maxX = Math.max(...xs) + 70;
      const minY = Math.min(...ys) - 70, maxY = Math.max(...ys) + 70;
      const sw = maxX - minX || 1, sh = maxY - minY || 1;
      const ms = Math.min(86 / sw, 58 / sh);
      const ox2 = 5 + (86 - sw * ms) / 2, oy2 = 4 + (58 - sh * ms) / 2;
      for (const e of edges) {
        mctx.beginPath();
        mctx.moveTo(ox2 + (e.fromN.x - minX) * ms, oy2 + (e.fromN.y - minY) * ms);
        mctx.lineTo(ox2 + (e.toN.x - minX) * ms, oy2 + (e.toN.y - minY) * ms);
        mctx.strokeStyle = "rgba(168,85,247,0.35)"; mctx.lineWidth = 0.8; mctx.stroke();
      }
      for (const n of nodes) {
        mctx.beginPath();
        mctx.arc(ox2 + (n.x - minX) * ms, oy2 + (n.y - minY) * ms, 4, 0, Math.PI * 2);
        mctx.fillStyle = n.color.fill; mctx.fill();
      }
      const vx = -cam.x / cam.scale, vy = -cam.y / cam.scale;
      const vw = s.W / cam.scale, vh = s.H / cam.scale;
      mctx.strokeStyle = "rgba(255,255,255,0.25)"; mctx.lineWidth = 0.8;
      mctx.strokeRect(ox2 + (vx - minX) * ms, oy2 + (vy - minY) * ms, vw * ms, vh * ms);
    }

    function loop() {
      s.tick++;
      applyPhysics();
      drawScene();
      drawMinimap();
      s.raf = requestAnimationFrame(loop);
    }

    const ro = new ResizeObserver(() => { resize(); fitView(); });
    ro.observe(canvas.parentElement);
    resize();
    fitView();
    loop();

    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
    };
  }, [tables, relationships]);

  const screenToWorld = useCallback((sx, sy) => {
    const s = stateRef.current;
    return { x: (sx - s.cam.x) / s.cam.scale, y: (sy - s.cam.y) / s.cam.scale };
  }, []);

  const nodeAt = useCallback((wx, wy) => {
    for (const n of stateRef.current.nodes) {
      const dx = n.x - wx, dy = n.y - wy;
      if (Math.sqrt(dx * dx + dy * dy) < n.r + 10) return n;
    }
    return null;
  }, []);

  const handleMouseDown = useCallback(e => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    const n = nodeAt(w.x, w.y);
    const s = stateRef.current;
    if (n) { s.drag = n; s.dragStart = { x: sx, y: sy }; n.vx = 0; n.vy = 0; }
    else { s.panStart = { x: sx, y: sy }; s.panCam = { ...s.cam }; }
  }, [screenToWorld, nodeAt]);

  const handleMouseMove = useCallback(e => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    const s = stateRef.current;
    if (s.drag) { s.drag.x = w.x; s.drag.y = w.y; return; }
    if (s.panStart) {
      s.cam.x = s.panCam.x + (sx - s.panStart.x);
      s.cam.y = s.panCam.y + (sy - s.panStart.y);
      return;
    }
    s.hover = nodeAt(w.x, w.y);
    canvasRef.current.style.cursor = s.hover ? "pointer" : "grab";
  }, [screenToWorld, nodeAt]);

  const handleMouseUp = useCallback(e => {
    const s = stateRef.current;
    if (s.drag && s.dragStart) {
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const moved = Math.abs(sx - s.dragStart.x) + Math.abs(sy - s.dragStart.y);
      if (moved < 6) {
        s.selected = s.selected === s.drag ? null : s.drag;
        setSelectedNode(s.selected);
        setPanelOpen(!!s.selected);
      }
    }
    s.drag = null; s.panStart = null; s.dragStart = null;
  }, []);

  const handleWheel = useCallback(e => {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const s = stateRef.current;
    s.cam.scale *= e.deltaY < 0 ? 1.12 : 0.9;
    s.cam.scale = Math.max(0.25, Math.min(3.5, s.cam.scale));
    const after = screenToWorld(sx, sy);
    s.cam.x += (after.x - before.x) * s.cam.scale;
    s.cam.y += (after.y - before.y) * s.cam.scale;
  }, [screenToWorld]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const closePanel = () => {
    stateRef.current.selected = null;
    setSelectedNode(null);
    setPanelOpen(false);
  };

  const togglePhysicsHandler = () => setPhysicsOn(p => !p);
  const toggleLabelsHandler = () => setShowLabels(p => !p);

  if (tableNames.length < 2) {
    return (
      <div className="ftv-card" style={{ padding: "3rem", textAlign: "center" }}>
        <GitBranch size={40} style={{ margin: "0 auto 12px", color: "#c4b5fd", display: "block" }} />
        <div style={{ fontSize: 14, color: "#9d8ec4" }}>Load at least 2 tables to detect relationships</div>
      </div>
    );
  }

  const nodeRels = selectedNode ? relationships.filter(r => r.from === selectedNode.id || r.to === selectedNode.id) : [];
  const linkedCols = new Set(nodeRels.map(r => r.column));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "inline-flex", padding: "4px", background: "#0d0d14", borderRadius: 10, border: "1px solid rgba(255,255,255,0.07)" }}>
          {[
            { id: "circular", label: "⬡ Force Graph", desc: "Physics-based" },
            { id: "schema", label: "⊞ Schema ERD", desc: "Table cards" },
          ].map(v => (
            <button key={v.id} onClick={() => setGraphView(v.id)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 500,
                transition: "all 0.15s",
                background: graphView === v.id ? "linear-gradient(135deg,#5b21b6,#7c3aed)" : "transparent",
                color: graphView === v.id ? "#fff" : "#6b6882",
                boxShadow: graphView === v.id ? "0 2px 8px rgba(124,58,237,0.4)" : "none",
              }}>
              {v.label}
              <span style={{ fontSize: 10, opacity: 0.6 }}>{v.desc}</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 11, color: "#9d8ec4", display: "flex", alignItems: "center", gap: 5 }}>
          <Link2 size={12} color="#c4b5fd" />
          {relationships.length} link{relationships.length !== 1 ? "s" : ""} · {tableNames.length} tables
        </div>
      </div>

      {graphView === "circular" && (
        <div className={`graph-canvas-root${isFullscreen ? " fullscreen" : ""}`}>
          <div className="graph-toolbar">
            <div className="graph-logo">⬡</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e0f0", letterSpacing: "-0.02em" }}>Force Graph</div>
              <div style={{ fontSize: 10, color: "#5b5378", marginTop: 1 }}>Physics-based layout</div>
            </div>
            <div className="graph-sep" />
            <button className={`graph-btn${physicsOn ? " active" : ""}`} onClick={togglePhysicsHandler}>⚛ Physics</button>
            <button className={`graph-btn${showLabels ? " active" : ""}`} onClick={toggleLabelsHandler}>⊞ Columns</button>
            <button className="graph-btn" onClick={fitView}>⊡ Fit view</button>
            <div className="graph-badge">{relationships.length} link{relationships.length !== 1 ? "s" : ""}</div>
            <button
              className="graph-btn"
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              onClick={() => setIsFullscreen(p => !p)}
              style={{ marginLeft: 4 }}
            >
              {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              {isFullscreen ? " Exit" : " Fullscreen"}
            </button>
          </div>

          <canvas
            ref={canvasRef}
            style={{ display: "block", cursor: "grab" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />

          <div className={`graph-panel${panelOpen ? "" : " closed"}`}>
            {selectedNode && (
              <>
                <div className="graph-panel-header">
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: selectedNode.color.fill, flexShrink: 0 }} />
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e0f0", flex: 1, fontFamily: "'DM Mono', monospace" }}>{selectedNode.id}</div>
                  <button onClick={closePanel} style={{ background: "none", border: "none", color: "#5b5378", cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>✕</button>
                </div>
                <div className="graph-panel-body">
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#4d4567", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Overview</div>
                    {[
                      ["Columns", selectedNode.headers.length],
                      ["Rows", selectedNode.rowCount.toLocaleString()],
                      ["Links", nodeRels.length],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 12 }}>
                        <span style={{ color: "#7a7099" }}>{k}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", color: "#c084fc", fontSize: 11 }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#4d4567", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Schema</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {selectedNode.headers.map(col => {
                        const isLink = linkedCols.has(col);
                        return (
                          <span key={col} style={{
                            display: "inline-flex", alignItems: "center", gap: 3,
                            padding: "2px 7px", borderRadius: 5, fontSize: 9,
                            fontFamily: "'DM Mono', monospace", cursor: "default",
                            background: isLink ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.04)",
                            color: isLink ? "#34d399" : "#6b6882",
                            border: isLink ? "1px solid rgba(52,211,153,0.25)" : "1px solid rgba(255,255,255,0.07)",
                          }}>
                            {isLink && "🔗 "}{col.length > 15 ? col.slice(0, 15) + "…" : col}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  {nodeRels.length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: "#4d4567", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Relationships</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {nodeRels.map((rel, i) => (
                          <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "8px 10px" }}>
                            <div style={{ fontSize: 11, color: "#c084fc", fontFamily: "'DM Mono', monospace" }}>
                              {rel.from} ↔ {rel.to}
                              <span style={{ display: "inline-block", padding: "1px 5px", borderRadius: 99, fontSize: 9, fontWeight: 600, background: "rgba(168,85,247,0.2)", color: "#c084fc", border: "1px solid rgba(168,85,247,0.25)", marginLeft: 5 }}>{rel.type}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "#6b6882", marginTop: 3 }}>
                              via <span style={{ color: "#a78bfa", fontFamily: "'DM Mono', monospace" }}>{rel.column}</span> · {rel.overlap} matching values
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="graph-legend">
            {[{ dot: "#a855f7", label: "Table" }, { dot: "#34d399", label: "Linked col" }].map(({ dot, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6b6882" }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: dot }} />{label}
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6b6882" }}>
              <div style={{ width: 18, height: 1.5, background: "#a855f7", borderRadius: 1 }} />1:N
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6b6882" }}>
              <div style={{ width: 18, height: 1.5, borderTop: "1.5px dashed #7c3aed" }} />N:M
            </div>
          </div>

          <canvas ref={minimapRef} className="graph-minimap" />
          <div className="graph-hint">{isFullscreen ? "Esc to exit · " : ""}Drag · Scroll to zoom · Click to inspect</div>
        </div>
      )}

      {graphView === "schema" && (
        <div className="graph-canvas-root" style={{ borderRadius: 16, overflow: "visible", background: "transparent" }}>
          <div className="graph-toolbar" style={{ borderRadius: "16px 16px 0 0" }}>
            <div className="graph-logo">⊞</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e0f0", letterSpacing: "-0.02em" }}>Schema ERD</div>
              <div style={{ fontSize: 10, color: "#5b5378", marginTop: 1 }}>Drag cards · Pan canvas · Scroll to zoom · Click edges</div>
            </div>
            <div className="graph-badge" style={{ marginLeft: "auto" }}>{relationships.length} link{relationships.length !== 1 ? "s" : ""}</div>
          </div>
          <div style={{ background: "#0d0d14", borderRadius: "0 0 16px 16px", overflow: "hidden" }}>
            <SchemaERD
              tables={tables}
              relationships={relationships}
              isFullscreen={isErdFullscreen}
              onToggleFullscreen={() => setIsErdFullscreen(p => !p)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   AI CHATBOT COMPONENT
───────────────────────────────────────────── */
function ChatBot({ tables }) {
  const [messages, setMessages] = useState([
    { role: "bot", content: "Hi! I'm your data assistant. Ask me anything about your tables — summaries, comparisons, relationships, insights, or filters. I can analyze the data you've loaded." }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef();

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const buildDataContext = () => {
    const parts = Object.entries(tables).map(([name, data]) => {
      const colSummary = data.headers.map(h => {
        const idx = data.headers.indexOf(h);
        const types = data.rows.slice(0, 100).map(r => r[idx]?.type);
        const numCount = types.filter(t => t === "number").length;
        const type = numCount > types.length * 0.5 ? "numeric" : "text";
        return `${h} (${type})`;
      }).join(", ");
      const sample = data.rows.slice(0, 3).map(row =>
        Object.fromEntries(data.headers.map((h, i) => [h, row[i]?.display]))
      );
      return `TABLE: ${name}\nColumns: ${colSummary}\nRows: ${data.rows.length}\nSample rows: ${JSON.stringify(sample, null, 2)}`;
    });
    const rels = detectRelationships(tables);
    const relText = rels.length > 0 ? `\nRELATIONSHIPS:\n${rels.map(r => `${r.from} ↔ ${r.to} via column "${r.column}" (${r.overlap} matching values, type: ${r.type})`).join("\n")}` : "";
    return parts.join("\n\n") + relText;
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const dataCtx = Object.keys(tables).length > 0
        ? `\n\nDATA CONTEXT:\n${buildDataContext()}`
        : "\n\nNo data loaded yet.";

      const systemPrompt = `You are a smart data analyst assistant. The user has loaded CSV tables into a data viewer app. Help them understand their data, find relationships, get insights, and answer questions.${dataCtx}\n\nBe concise and helpful. Use markdown-style formatting when showing data. When asked for a query or filter, explain what to look for.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: `${systemPrompt}\n\nUser question: ${userMsg}` }]
        })
      });

      const data = await response.json();
      const text = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";
      setMessages(prev => [...prev, { role: "bot", content: text }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "bot", content: `Error: ${e.message || "Could not connect."}` }]);
    }
    setLoading(false);
  };

  const suggestions = Object.keys(tables).length > 0 ? [
    `Summarize all ${Object.keys(tables).length} tables`,
    "What relationships exist between tables?",
    "Which table has the most columns?",
  ] : ["What can you help me with?", "How do I detect relationships?"];

  return (
    <div className="ftv-card" style={{ display: "flex", flexDirection: "column", height: 600 }}>
      <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid #ece5fb", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg,#5b21b6,#a855f7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Bot size={16} color="#fff" />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1e1a2e" }}>Data AI Assistant</div>
          <div style={{ fontSize: 11, color: "#9d8ec4" }}>Powered by Claude · {Object.keys(tables).length} table{Object.keys(tables).length !== 1 ? "s" : ""} in context</div>
        </div>
        <button className="ftv-btn-ghost" style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 11, borderRadius: 7 }} onClick={() => setMessages([{ role: "bot", content: "Hi! I'm your data assistant. Ask me anything about your tables." }])}>
          <RefreshCw size={11} /> Clear
        </button>
      </div>
      <div className="ftv-scroll" style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexDirection: msg.role === "user" ? "row-reverse" : "row" }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: msg.role === "user" ? "linear-gradient(135deg,#7c3aed,#a855f7)" : "#f3e8ff", border: "1px solid", borderColor: msg.role === "user" ? "transparent" : "#ddd0f9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {msg.role === "user" ? <User size={12} color="#fff" /> : <Bot size={12} color="#a855f7" />}
            </div>
            <div className={`chat-bubble ${msg.role}`} style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: "#f3e8ff", border: "1px solid #ddd0f9", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Bot size={12} color="#a855f7" />
            </div>
            <div className="chat-bubble bot" style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {messages.length <= 2 && (
        <div style={{ padding: "0 1.25rem 0.75rem", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {suggestions.map(s => (
            <button key={s} className="ftv-btn-ghost" style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7 }} onClick={() => setInput(s)}>{s}</button>
          ))}
        </div>
      )}
      <div style={{ padding: "0.75rem 1.25rem 1rem", borderTop: "1px solid #ece5fb", display: "flex", gap: 8 }}>
        <input className="ftv-input" placeholder="Ask about your data…" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()} />
        <button className="ftv-btn-primary" onClick={sendMessage} disabled={loading || !input.trim()} style={{ flexShrink: 0 }}>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   API GENERATOR HELPERS (condensed)
───────────────────────────────────────────── */
function generateJSONServerDB(tables) {
  const db = {};
  Object.entries(tables).forEach(([name, data]) => {
    db[name] = data.rows.map((row, idx) => {
      const obj = { id: idx + 1 };
      data.headers.forEach((h, i) => { obj[h] = row[i]?.raw ?? null; });
      return obj;
    });
  });
  return JSON.stringify(db, null, 2);
}

function inferPrimaryKey(headers, rows) {
  const candidates = headers.filter(h => {
    const lower = h.toLowerCase();
    return lower === "id" || lower.startsWith("code_") || lower.startsWith("id_") || lower.endsWith("_id");
  });
  for (const col of candidates) {
    const vals = rows.map(r => r[headers.indexOf(col)]?.raw).filter(v => v !== null && v !== undefined);
    if (vals.length > 0 && new Set(vals).size === vals.length) return col;
  }
  return null;
}

function inferPostgresType(header, rows, colIdx) {
  const nonNull = rows.map(r => r[colIdx]).filter(c => c?.type !== "null" && c?.raw !== null && c?.raw !== undefined);
  if (nonNull.length === 0) return "TEXT";
  const allNumber = nonNull.every(c => c.type === "number");
  const allDate = nonNull.every(c => c.type === "date");
  if (allNumber) {
    const allInt = nonNull.every(c => Number.isInteger(c.raw));
    return allInt ? "INTEGER" : "NUMERIC(12,2)";
  }
  if (allDate) return "DATE";
  const strVals = nonNull.map(c => String(c.raw).toLowerCase());
  const boolSet = ["oui", "non", "yes", "no", "true", "false", "1", "0"];
  if (strVals.every(v => boolSet.includes(v))) return "BOOLEAN";
  return "TEXT";
}

function escapeSQL(val) {
  if (val === null || val === undefined) return "NULL";
  const str = String(val);
  const lower = str.toLowerCase();
  if (["oui", "yes", "true", "1"].includes(lower)) return "TRUE";
  if (["non", "no", "false", "0"].includes(lower)) return "FALSE";
  return "'" + str.replace(/'/g, "''") + "'";
}

function generatePostgreSQL(tables, relationships) {
  const lines = [];
  lines.push(`-- Auto-generated PostgreSQL Schema`);
  lines.push(`-- Tables: ${Object.keys(tables).join(", ")}\n`);
  const tablePKs = {};
  Object.entries(tables).forEach(([name, data]) => {
    tablePKs[name] = inferPrimaryKey(data.headers, data.rows);
  });
  Object.entries(tables).forEach(([name, data]) => {
    const pk = tablePKs[name];
    lines.push(`DROP TABLE IF EXISTS "${name}" CASCADE;`);
    lines.push(`CREATE TABLE "${name}" (`);
    const defs = [];
    if (!pk) defs.push(`  "id" SERIAL PRIMARY KEY`);
    data.headers.forEach((h, i) => {
      const type = inferPostgresType(h, data.rows, i);
      defs.push(`  "${h}" ${type}${h === pk ? " PRIMARY KEY" : ""}`);
    });
    lines.push(defs.join(",\n"));
    lines.push(`);\n`);
    const batchSize = 100;
    if (data.rows.length > 0) {
      const cols = data.headers.map(h => `"${h}"`).join(", ");
      for (let i = 0; i < data.rows.length; i += batchSize) {
        const batch = data.rows.slice(i, i + batchSize);
        lines.push(`INSERT INTO "${name}" (${cols}) VALUES`);
        lines.push(batch.map(row => `  (${row.map(c => escapeSQL(c?.raw)).join(", ")})`).join(",\n") + ";\n");
      }
    }
  });
  return lines.join("\n");
}

function downloadText(text, filename, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function APIExporter({ tables, activeTable }) {
  const [activeGen, setActiveGen] = useState("jsonserver");
  const [copied, setCopied] = useState(false);
  const relationships = useMemo(() => detectRelationships(tables), [tables]);

  const generators = [
    { id: "jsonserver", label: "JSON Server", icon: "🗄️", desc: "Instant mock REST API", ext: "json" },
    { id: "postgresql", label: "PostgreSQL", icon: "🐘", desc: "Full SQL schema + data dump", ext: "sql" },
  ];

  const generate = (id) => {
    switch (id) {
      case "jsonserver": return generateJSONServerDB(tables);
      case "postgresql": return generatePostgreSQL(tables, relationships);
      default: return "";
    }
  };

  const currentCode = generate(activeGen);
  const currentGen = generators.find(g => g.id === activeGen);

  const handleCopy = () => {
    navigator.clipboard.writeText(currentCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "1.25rem", alignItems: "start" }}>
      <div className="ftv-card" style={{ padding: "1rem" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#9d8ec4", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Generator</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {generators.map(g => (
            <div key={g.id} className={`analytics-col-card${activeGen === g.id ? " active" : ""}`} onClick={() => setActiveGen(g.id)} style={{ padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 14 }}>{g.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: activeGen === g.id ? "#7c3aed" : "#3d3557" }}>{g.label}</span>
              </div>
              <div style={{ fontSize: 10.5, color: "#9d8ec4", paddingLeft: 22 }}>{g.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div className="ftv-card" style={{ padding: "1rem 1.25rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#1e1a2e" }}>{currentGen.label}</div>
            <div style={{ fontSize: 11, color: "#9d8ec4", marginTop: 2 }}>{currentGen.desc} · {currentCode.split("\n").length} lines</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ftv-btn-ghost" onClick={handleCopy} style={{ fontSize: 12 }}>
              {copied ? <Check size={13} color="#16a34a" /> : <FileText size={13} />} {copied ? "Copied" : "Copy"}
            </button>
            <button className="ftv-btn-primary" onClick={() => downloadText(currentCode, `api-${activeGen}.${currentGen.ext}`)} style={{ fontSize: 12 }}>
              <Download size={13} /> Download .{currentGen.ext}
            </button>
          </div>
        </div>
        <div className="ftv-card" style={{ padding: 0, overflow: "hidden" }}>
          <pre className="ftv-scroll" style={{ margin: 0, padding: "14px 16px", fontFamily: "'DM Mono', monospace", fontSize: 11.5, lineHeight: 1.6, color: "#1e1a2e", background: "#fff", maxHeight: 520, overflow: "auto", whiteSpace: "pre" }}>
            {currentCode}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   DEMO DATA
───────────────────────────────────────────── */
function mkRow(vals) { return vals.map(v => parseValue(String(v))); }

const DEMO_FOURNISSEURS = (() => {
  const headers = ["CODE_FOURNISSEUR", "NOM", "VILLE", "PAYS", "TELEPHONE", "EMAIL", "CATEGORIE", "NOTE_QUALITE", "ACTIF"];
  const data = [
    ["F001", "Al-Waha Trading", "Tunis", "Tunisie", "71 234 567", "contact@alwaha.tn", "Matières premières", "@F4.5", "Oui"],
    ["F002", "Société Méditex", "Sfax", "Tunisie", "74 112 233", "info@meditex.tn", "Textile", "@F3.8", "Oui"],
    ["F003", "Euro Supply SARL", "Paris", "France", "01 44 55 66 77", "supply@eurosupply.fr", "Equipement", "@F4.9", "Oui"],
    ["F004", "Maghreb Acier", "Sousse", "Tunisie", "73 400 100", "vente@maghrebacier.tn", "Métaux", "@F4.1", "Oui"],
    ["F005", "Orion Tech", "Barcelone", "Espagne", "+34 93 555 0101", "orders@oriontech.es", "Electronique", "@F3.5", "Non"],
    ["F006", "BTP Maroc", "Casablanca", "Maroc", "+212 522 334455", "btp@btpmaroc.ma", "Construction", "@F4.2", "Oui"],
    ["F007", "Global Plastic", "Monastir", "Tunisie", "73 801 022", "info@globalplastic.tn", "Plastique", "@F3.9", "Oui"],
    ["F008", "Delta Chimie", "Lyon", "France", "04 72 00 11 22", "delta@chimie.fr", "Chimie", "@F4.7", "Oui"],
    ["F009", "Agrostar", "Gabès", "Tunisie", "75 600 300", "agrostar@gmail.com", "Agriculture", "@F3.2", "Oui"],
    ["F010", "TechMed Supplies", "Tunis", "Tunisie", "71 900 400", "info@techmed.tn", "Médical", "@F4.6", "Oui"],
    ["F011", "SudGlass", "Médenine", "Tunisie", "75 443 220", "sudglass@tn.net", "Verre", "@F3.7", "Non"],
    ["F012", "Atlas Import", "Nabeul", "Tunisie", "72 285 193", "atlas@import.tn", "Divers", "@F4.0", "Oui"],
  ];
  return { headers, rows: data.map(mkRow) };
})();

const DEMO_BUDGET = (() => {
  const headers = ["CODE_BUDGETAIRE", "LIBELLE", "MONTANT_BUDGET", "DEVISE", "ANNEE", "TYPE", "RESPONSABLE"];
  const data = [
    ["B001", "Fournitures et matières premières", "@F60000.00", "TND", "2024", "Opérationnel", "Rima Jaziri"],
    ["B002", "Équipements et services industriels", "@F90000.00", "TND", "2024", "Investissement", "Karim Msallem"],
    ["B003", "Services externes et consulting", "@F50000.00", "EUR", "2024", "Opérationnel", "Sonia Trabelsi"],
    ["B004", "Travaux et construction", "@F40000.00", "MAD", "2024", "Investissement", "Ali Ben Salem"],
    ["B005", "Maintenance et réparations", "@F25000.00", "TND", "2024", "Opérationnel", "Rima Jaziri"],
  ];
  return { headers, rows: data.map(mkRow) };
})();

const DEMO_COMMANDES = (() => {
  const headers = ["CODE_COMMANDE", "CODE_FOURNISSEUR", "CODE_BUDGETAIRE", "DATE_COMMANDE", "DATE_LIVRAISON", "STATUT", "MONTANT_HT", "TVA", "MONTANT_TTC", "DEVISE", "RESPONSABLE"];
  const data = [
    ["CMD001", "F001", "B001", "@D20240115", "@D20240210", "Livré", "@F12500.00", "@F2375.00", "@F14875.00", "TND", "Ali Ben Salem"],
    ["CMD002", "F002", "B001", "@D20240118", "@D20240225", "Livré", "@F8200.00", "@F1558.00", "@F9758.00", "TND", "Sonia Trabelsi"],
    ["CMD003", "F003", "B002", "@D20240201", "@D20240315", "En cours", "@F45000.00", "@F8550.00", "@F53550.00", "EUR", "Karim Msallem"],
    ["CMD004", "F004", "B001", "@D20240205", "@D20240228", "Livré", "@F31000.00", "@F5890.00", "@F36890.00", "TND", "Ali Ben Salem"],
    ["CMD005", "F001", "B001", "@D20240210", "@D20240310", "Annulé", "@F7800.00", "@F1482.00", "@F9282.00", "TND", "Rima Jaziri"],
    ["CMD006", "F006", "B004", "@D20240214", "@D20240320", "En cours", "@F22000.00", "@F4180.00", "@F26180.00", "MAD", "Karim Msallem"],
    ["CMD007", "F008", "B002", "@D20240220", "@D20240405", "Livré", "@F18500.00", "@F3515.00", "@F22015.00", "EUR", "Sonia Trabelsi"],
    ["CMD008", "F003", "B002", "@D20240225", "@D20240410", "En attente", "@F67000.00", "@F12730.00", "@F79730.00", "EUR", "Ali Ben Salem"],
    ["CMD009", "F007", "B001", "@D20240301", "@D20240325", "Livré", "@F5400.00", "@F1026.00", "@F6426.00", "TND", "Rima Jaziri"],
    ["CMD010", "F010", "B005", "@D20240305", "@D20240420", "En cours", "@F29000.00", "@F5510.00", "@F34510.00", "TND", "Karim Msallem"],
  ];
  return { headers, rows: data.map(mkRow) };
})();

const DEMO_FACTURES = (() => {
  const headers = ["CODE_FACTURE", "CODE_COMMANDE", "CODE_FOURNISSEUR", "DATE_FACTURE", "DATE_ECHEANCE", "MONTANT_HT", "MONTANT_TTC", "STATUT_PAIEMENT", "MODE_PAIEMENT", "REFERENCE_BANQUE"];
  const data = [
    ["FAC001", "CMD001", "F001", "@D20240215", "@D20240315", "@F12500.00", "@F14875.00", "Payé", "Virement", "BNA-2024-0012"],
    ["FAC002", "CMD002", "F002", "@D20240228", "@D20240330", "@F8200.00", "@F9758.00", "Payé", "Chèque", "STB-2024-0045"],
    ["FAC003", "CMD004", "F004", "@D20240302", "@D20240402", "@F31000.00", "@F36890.00", "Payé", "Virement", "BH-2024-0088"],
    ["FAC004", "CMD007", "F008", "@D20240408", "@D20240508", "@F18500.00", "@F22015.00", "Payé", "Virement", "BNA-2024-0133"],
    ["FAC005", "CMD009", "F007", "@D20240328", "@D20240428", "@F5400.00", "@F6426.00", "Payé", "Espèces", "@NULL"],
    ["FAC006", "CMD001", "F002", "@D20240404", "@D20240504", "@F11000.00", "@F13090.00", "En attente", "Virement", "STB-2024-0201"],
    ["FAC007", "CMD003", "F009", "@D20240412", "@D20240512", "@F4200.00", "@F4998.00", "Payé", "Chèque", "AB-2024-0055"],
    ["FAC008", "CMD004", "F002", "@D20240418", "@D20240518", "@F9750.00", "@F11602.50", "En retard", "Virement", "BNA-2024-0178"],
  ];
  return { headers, rows: data.map(mkRow) };
})();

const INITIAL_TABLES = {
  Fournisseurs: DEMO_FOURNISSEURS,
  Budget: DEMO_BUDGET,
  Commandes: DEMO_COMMANDES,
  Factures: DEMO_FACTURES,
};

/* ─────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────── */
export default function App() {
  const [tables, setTables] = useState(INITIAL_TABLES);
  const [fileSizes, setFileSizes] = useState({ Fournisseurs: 2048, Budget: 1800, Commandes: 4096, Factures: 3500 });
  const [activeTable, setActiveTable] = useState("Fournisseurs");
  const [activeTab, setActiveTab] = useState("data");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadFiles, setUploadFiles] = useState([]); // [{name, progress, done, sizeLabel}]
  const fileRef = useRef();

  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

  const handleFiles = useCallback((files) => {
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    // Init progress state
    const initProgress = fileList.map(f => ({
      name: f.name,
      progress: 0,
      done: false,
      sizeLabel: fmtSize(f.size),
    }));
    setUploadFiles(initProgress);

    fileList.forEach((file, idx) => {
      const reader = new FileReader();

      // Simulate progress with periodic updates
      let simulatedProgress = 0;
      const progressInterval = setInterval(() => {
        simulatedProgress = Math.min(simulatedProgress + Math.random() * 18 + 5, 90);
        setUploadFiles(prev => prev.map((f, i) =>
          i === idx && !f.done ? { ...f, progress: Math.round(simulatedProgress) } : f
        ));
      }, 80);

      reader.onload = (e) => {
        clearInterval(progressInterval);
        const parsed = parseCSV(e.target.result);
        const name = file.name.replace(/\.[^.]+$/, "");
        setTables(prev => ({ ...prev, [name]: parsed }));
        setFileSizes(prev => ({ ...prev, [name]: file.size }));
        setActiveTable(name);

        // Mark done
        setUploadFiles(prev => prev.map((f, i) =>
          i === idx ? { ...f, progress: 100, done: true } : f
        ));

        // Check if all done
        setUploadFiles(prev => {
          const allDone = prev.every(f => f.done || (i === idx));
          if (allDone) {
            setTimeout(() => setUploadFiles([]), 1200);
          }
          return prev;
        });
      };

      reader.readAsText(file);
    });
  }, []);

  // Dismiss upload overlay when all done
  useEffect(() => {
    if (uploadFiles.length > 0 && uploadFiles.every(f => f.done)) {
      const t = setTimeout(() => setUploadFiles([]), 1400);
      return () => clearTimeout(t);
    }
  }, [uploadFiles]);

  const removeTable = name => {
    setTables(prev => { const n = { ...prev }; delete n[name]; return n; });
    setFileSizes(prev => { const n = { ...prev }; delete n[name]; return n; });
    if (activeTable === name) setActiveTable(Object.keys(tables).filter(k => k !== name)[0] || null);
  };

  const onDrop = e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); };
  const tableNames = Object.keys(tables);
  const currentData = activeTable ? tables[activeTable] : null;

  const tabs = [
    { id: "data", icon: <Table size={14} />, label: "Data" },
    { id: "analytics", icon: <BarChart2 size={14} />, label: "Analytics" },
    { id: "relations", icon: <GitBranch size={14} />, label: "Relations" },
    { id: "api", icon: <Zap size={14} />, label: "API" },
    { id: "chat", icon: <MessageSquare size={14} />, label: "AI Chat" },
  ];

  return (
    <>
      <style>{css}</style>
      {uploadFiles.length > 0 && <UploadProgressOverlay files={uploadFiles} />}
      <div className="ftv-root">
        <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="logo-box"><Database size={18} /></div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 600, color: "#1e1a2e", letterSpacing: "-0.03em" }}>DataStudio</div>
              <div style={{ fontSize: 11.5, color: "#9d8ec4", marginTop: 1 }}>Multi-table · Analytics · Relations · AI Chat</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            {[".csv", ".unl", ".psv", ".txt"].map(ext => <span key={ext} className="ext-tag">{ext}</span>)}
          </div>
        </div>

        {tableNames.length === 0 ? (
          <div className={`drop-zone${isDragging ? " dragging" : ""}`}
            onClick={() => fileRef.current.click()}
            onDrop={onDrop} onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)}>
            <input ref={fileRef} type="file" multiple accept=".csv,.txt,.unl,.psv,.dat" style={{ display: "none" }} onChange={e => handleFiles(e.target.files)} />
            <div className="drop-icon"><CloudUpload size={22} /></div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#3d3557" }}>Drop CSV files here, or click to browse</div>
            <div style={{ fontSize: 12, color: "#b8aad6", marginTop: 6 }}>Load multiple files at once · Relationships auto-detected</div>
          </div>
        ) : (
          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: "1rem" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
                {tableNames.map(name => (
                  <div key={name} className={`table-pill${activeTable === name ? " active" : ""}`} onClick={() => setActiveTable(name)}>
                    <div style={{ width: 24, height: 24, borderRadius: 7, background: activeTable === name ? "linear-gradient(135deg,#7c3aed,#a855f7)" : "#f3e8ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Table size={11} color={activeTable === name ? "#fff" : "#a855f7"} />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: activeTable === name ? "#5b21b6" : "#3d3557", fontFamily: "'DM Mono', monospace" }}>{name}</div>
                      <div style={{ fontSize: 10, color: "#9d8ec4" }}>{tables[name].rows.length.toLocaleString()} rows</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); removeTable(name); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#c4b5fd", padding: 0, marginLeft: 2 }}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="ftv-btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => fileRef.current.click()}>
                <Plus size={13} /> Add files
              </button>
              <input ref={fileRef} type="file" multiple accept=".csv,.txt,.unl,.psv,.dat" style={{ display: "none" }} onChange={e => handleFiles(e.target.files)} />
            </div>
            <div className="nav-tabs" style={{ width: "fit-content" }}>
              {tabs.map(t => (
                <button key={t.id} className={`nav-tab${activeTab === t.id ? " active" : ""}`} onClick={() => setActiveTab(t.id)}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {tableNames.length > 0 && (
          <>
            {activeTab === "data" && currentData && (
              <TableViewer key={activeTable} data={currentData} fileName={activeTable} fileSize={fileSizes[activeTable] || 0} />
            )}
            {activeTab === "analytics" && (
              <Analytics key={activeTable} data={currentData} tableName={activeTable} />
            )}
            {activeTab === "relations" && (
              <RelationshipView tables={tables} />
            )}
            {activeTab === "api" && (
              <APIExporter tables={tables} activeTable={activeTable} />
            )}
            {activeTab === "chat" && (
              <ChatBot tables={tables} />
            )}
          </>
        )}
      </div>
    </>
  );
}