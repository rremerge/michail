#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const DEFAULT_FIXTURE_PATH = path.join(APP_DIR, "fixtures", "advisor-workspace-preview.json");
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, "tmp", "advisor-workspace-preview.html");
const DEFAULT_LOGO_SRC = "../app/assets/letsconnect-logo.png";

function parseArgs(argv) {
  const args = {
    fixturePath: DEFAULT_FIXTURE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    scenarioId: "",
    openInBrowser: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--fixture" && argv[index + 1]) {
      args.fixturePath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item === "--output" && argv[index + 1]) {
      args.outputPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item === "--scenario" && argv[index + 1]) {
      args.scenarioId = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (item === "--open") {
      args.openInBrowser = true;
    }
  }

  return args;
}

function openFileInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  let command;
  let commandArgs;
  let useShell = false;

  if (process.platform === "darwin") {
    command = "open";
    commandArgs = [absolutePath];
  } else if (process.platform === "win32") {
    command = "start";
    commandArgs = [absolutePath];
    useShell = true;
  } else {
    command = "xdg-open";
    commandArgs = [absolutePath];
  }

  const child = spawn(command, commandArgs, {
    stdio: "ignore",
    detached: true,
    shell: useShell
  });
  child.unref();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return "0";
  }
  return new Intl.NumberFormat("en-US").format(parsed);
}

function formatUsd(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return "$0.00";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(parsed);
}

function buildPreviewHtml({ scenarios, selectedScenarioId }) {
  const scenarioOptions = scenarios
    .map((scenario) => {
      const selected = scenario.id === selectedScenarioId ? " selected" : "";
      return `<option value="${escapeHtml(scenario.id)}"${selected}>${escapeHtml(scenario.label)}</option>`;
    })
    .join("");
  const defaultLogoSrc = escapeHtml(DEFAULT_LOGO_SRC);

  const encodedScenarios = JSON.stringify(scenarios);
  const safeJson = encodedScenarios.replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Portal Workspace Preview</title>
    <style>
      :root {
        --bg-top: #ecf4ff;
        --bg-bottom: #f6f8fc;
        --ink-900: #0f172a;
        --ink-700: #334155;
        --ink-600: #475569;
        --ink-500: #64748b;
        --ink-400: #94a3b8;
        --line: #d8e1ec;
        --surface: #ffffff;
        --surface-soft: #f8fbff;
        --brand: #0b6bbf;
        --brand-strong: #0a4f8e;
        --success: #0f9d58;
        --warn: #c77b1e;
        --danger: #be2f3f;
        --shadow: 0 12px 40px rgba(15, 23, 42, 0.09);
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        min-height: 100%;
        background: linear-gradient(180deg, var(--bg-top), var(--bg-bottom));
        color: var(--ink-900);
        font-family: "Avenir Next", "Segoe UI Variable", "Gill Sans", "Trebuchet MS", sans-serif;
      }

      .shell {
        display: grid;
        grid-template-columns: 258px 1fr;
        min-height: 100vh;
      }

      .sidebar {
        border-right: 1px solid var(--line);
        background: linear-gradient(180deg, #ffffff, #f3f7fd);
        padding: 18px 14px;
      }

      .brand {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px;
        background: #fff;
      }

      .brand-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .brand h1 {
        font-size: 20px;
        letter-spacing: 0.02em;
        margin: 2px 0 4px;
      }

      .brand p {
        margin: 0;
        color: var(--ink-600);
        font-size: 12px;
      }

      .portal-logo {
        width: 54px;
        height: 54px;
        object-fit: contain;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #fff;
        padding: 6px;
      }

      .scenario-card {
        margin-top: 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 10px 12px;
        background: #fff;
      }

      .scenario-card label {
        display: block;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-500);
        margin-bottom: 6px;
        font-weight: 700;
      }

      .scenario-card select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 8px;
        font-weight: 700;
        color: var(--ink-700);
        background: #fff;
      }

      .nav {
        margin-top: 14px;
        display: grid;
        gap: 6px;
      }

      .nav button {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink-700);
        text-align: left;
        border-radius: 10px;
        padding: 10px 12px;
        font-weight: 700;
        cursor: pointer;
      }

      .nav button.active {
        background: #e7f2ff;
        border-color: #a9c9eb;
        color: var(--brand-strong);
      }

      .main {
        padding: 18px;
      }

      .header {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 16px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      .header h2 {
        margin: 0;
        font-size: 28px;
        letter-spacing: 0.01em;
      }

      .header p {
        margin: 4px 0 0;
        color: var(--ink-600);
      }

      .header-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .button {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink-700);
        border-radius: 10px;
        padding: 9px 12px;
        font-weight: 700;
        font-size: 13px;
      }

      .button.primary {
        background: var(--brand);
        color: #fff;
        border-color: transparent;
      }

      .workspace {
        margin-top: 14px;
        display: grid;
        gap: 12px;
      }

      .area-grid {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(3, minmax(240px, 1fr));
        gap: 10px;
      }

      .area-card {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--surface-soft);
        padding: 12px;
        display: grid;
        gap: 8px;
      }

      .area-title {
        margin: 0;
        font-size: 15px;
      }

      .area-summary {
        margin: 0;
        color: var(--ink-600);
        font-size: 13px;
      }

      .area-actions {
        margin-top: 2px;
      }

      .section {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--surface);
        padding: 14px;
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .section h3 {
        margin: 0;
        font-size: 18px;
      }

      .section .hint {
        margin: 4px 0 0;
        color: var(--ink-500);
        font-size: 13px;
      }

      .identity-grid {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(2, minmax(260px, 1fr));
        gap: 10px;
      }

      .identity-card {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--surface-soft);
        padding: 12px;
      }

      .identity-card h4 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      .identity-label {
        display: block;
        margin-top: 9px;
        font-size: 11px;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--ink-500);
        font-weight: 700;
      }

      .identity-value {
        margin-top: 4px;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 9px 10px;
        background: #fff;
        font-size: 14px;
        color: var(--ink-700);
      }

      .identity-help {
        margin-top: 8px;
        font-size: 12px;
        color: var(--ink-600);
      }

      .logo-stack {
        margin-top: 10px;
        display: grid;
        gap: 8px;
      }

      .logo-item {
        display: grid;
        grid-template-columns: 68px 1fr;
        gap: 10px;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        padding: 8px;
      }

      .logo-item img {
        width: 60px;
        height: 44px;
        object-fit: contain;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
      }

      .logo-name {
        margin: 0;
        font-weight: 700;
        font-size: 13px;
        color: var(--ink-700);
      }

      .logo-meta {
        margin: 3px 0 0;
        color: var(--ink-500);
        font-size: 12px;
      }

      .identity-actions {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .panel-content {
        border: 0;
        background: transparent;
        padding: 0;
      }

      .panel-content table {
        margin-top: 8px;
      }

      .modal {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.48);
        display: grid;
        place-items: center;
        padding: 16px;
        z-index: 1200;
      }

      .modal-dialog {
        width: min(1100px, 96vw);
        max-height: 92vh;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: var(--shadow);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto 1fr;
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        background: #f6f9ff;
      }

      .modal-header h3 {
        margin: 0;
        font-size: 19px;
      }

      .modal-body {
        overflow: auto;
        padding: 14px;
      }

      .is-hidden {
        display: none !important;
      }

      .kpi-grid {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(6, minmax(120px, 1fr));
        gap: 8px;
      }

      .kpi-card {
        background: var(--surface-soft);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
      }

      .kpi-label {
        font-size: 11px;
        color: var(--ink-500);
        text-transform: uppercase;
        letter-spacing: 0.07em;
        font-weight: 700;
      }

      .kpi-value {
        margin-top: 6px;
        font-size: 24px;
        font-weight: 800;
      }

      .alerts {
        margin-top: 10px;
        display: grid;
        gap: 8px;
      }

      .alert {
        border-radius: 10px;
        border: 1px solid var(--line);
        padding: 10px;
        background: #fff;
      }

      .alert-title {
        font-weight: 800;
        margin-bottom: 4px;
      }

      .alert.ok { border-left: 4px solid var(--success); }
      .alert.warn { border-left: 4px solid var(--warn); }
      .alert.error { border-left: 4px solid var(--danger); }
      .alert.info { border-left: 4px solid var(--brand); }

      .split-grid {
        display: grid;
        grid-template-columns: 1.2fr 1fr;
        gap: 12px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
      }

      th, td {
        border-bottom: 1px solid #e6ecf4;
        text-align: left;
        padding: 9px 8px;
        font-size: 13px;
      }

      th {
        color: var(--ink-600);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .tag {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid;
        font-size: 11px;
        font-weight: 800;
      }

      .tag.active { color: #0c6f3f; border-color: #76c69f; background: #e8f8ef; }
      .tag.blocked { color: #8f5208; border-color: #f0c78a; background: #fff4e3; }
      .tag.deleted { color: #98303f; border-color: #f2afb8; background: #fff0f3; }
      .tag.connected { color: #0c6f3f; border-color: #76c69f; background: #e8f8ef; }
      .tag.error { color: #98303f; border-color: #f2afb8; background: #fff0f3; }

      .search-row {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .search-row input {
        flex: 1;
        min-width: 200px;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        font-size: 14px;
      }

      .search-summary {
        color: var(--ink-600);
        font-size: 12px;
        margin-top: 8px;
      }

      .usage-bars {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 8px;
      }

      .bar-card {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 8px;
        background: #fff;
      }

      .bar {
        width: 100%;
        height: 80px;
        border-radius: 8px;
        background: linear-gradient(180deg, #dceafd 0%, #b0d0f1 100%);
        position: relative;
        overflow: hidden;
      }

      .bar-fill {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(180deg, #1a7fd4 0%, #0b5fa6 100%);
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
      }

      .bar-meta {
        margin-top: 6px;
        font-size: 12px;
      }

      .copyright {
        margin-top: 14px;
        text-align: center;
        color: var(--ink-500);
        font-size: 12px;
      }

      @media (max-width: 1200px) {
        .kpi-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
        .split-grid { grid-template-columns: 1fr; }
        .identity-grid { grid-template-columns: 1fr; }
        .area-grid { grid-template-columns: repeat(2, minmax(240px, 1fr)); }
      }

      @media (max-width: 920px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
        .nav { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
        .header { grid-template-columns: 1fr; }
        .header-actions { justify-content: flex-start; }
        .area-grid { grid-template-columns: 1fr; }
        .modal-dialog { width: min(860px, 98vw); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-header">
            <div>
              <h1>Advisor Portal</h1>
              <p>Workspace prototype, local-only preview</p>
            </div>
            <img class="portal-logo" src="${defaultLogoSrc}" alt="LetsConnect logo" />
          </div>
        </div>
        <div class="scenario-card">
          <label for="scenarioSelect">Scenario</label>
          <select id="scenarioSelect">${scenarioOptions}</select>
        </div>
        <nav class="nav" id="sectionNav">
          <button data-panel="overview" class="active">Overview</button>
          <button data-panel="identity">Branding & Identity</button>
          <button data-panel="connections">Connections</button>
          <button data-panel="clients">Clients</button>
          <button data-panel="policies">Policies</button>
          <button data-panel="usage">Usage</button>
          <button data-panel="diagnostics">Diagnostics</button>
        </nav>
      </aside>

      <main class="main">
        <header class="header">
          <div>
            <h2 id="advisorName">Advisor</h2>
            <p id="advisorMeta">Email, timezone, and agent alias</p>
          </div>
          <div class="header-actions">
            <button class="button primary">Connect Google</button>
            <button class="button">Connect Microsoft</button>
            <button class="button">Import Clients</button>
            <button class="button">Logout</button>
          </div>
        </header>

        <div class="workspace">
          <section id="overview" class="section">
            <div class="section-header">
              <h3>Overview</h3>
              <span id="scenarioSubtitle" class="hint"></span>
            </div>
            <div class="kpi-grid">
              <div class="kpi-card"><div class="kpi-label">Connected Calendars</div><div id="kpiConnected" class="kpi-value">0</div></div>
              <div class="kpi-card"><div class="kpi-label">Active Clients</div><div id="kpiClients" class="kpi-value">0</div></div>
              <div class="kpi-card"><div class="kpi-label">Bookings This Week</div><div id="kpiBookings" class="kpi-value">0</div></div>
              <div class="kpi-card"><div class="kpi-label">Inbound Today</div><div id="kpiInbound" class="kpi-value">0</div></div>
              <div class="kpi-card"><div class="kpi-label">Response p95</div><div id="kpiLatency" class="kpi-value">0s</div></div>
              <div class="kpi-card"><div class="kpi-label">Est. Month Cost</div><div id="kpiCost" class="kpi-value">$0.00</div></div>
            </div>
            <div id="alerts" class="alerts"></div>
          </section>

          <section id="workareas" class="section">
            <div class="section-header">
              <h3>Workspace</h3>
              <span class="hint">Click an area to open details, edit controls, and inspection tools.</span>
            </div>
            <div class="area-grid">
              <article class="area-card">
                <h4 class="area-title">Branding & Identity</h4>
                <p id="areaIdentitySummary" class="area-summary">Agent alias and branding mode.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="identity">Open</button></div>
              </article>
              <article class="area-card">
                <h4 class="area-title">Connections</h4>
                <p id="areaConnectionsSummary" class="area-summary">Connected providers and health.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="connections">Open</button></div>
              </article>
              <article class="area-card">
                <h4 class="area-title">Clients</h4>
                <p id="areaClientsSummary" class="area-summary">Directory search and access states.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="clients">Open</button></div>
              </article>
              <article class="area-card">
                <h4 class="area-title">Policies</h4>
                <p id="areaPoliciesSummary" class="area-summary">Availability profiles and assignments.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="policies">Open</button></div>
              </article>
              <article class="area-card">
                <h4 class="area-title">Usage</h4>
                <p id="areaUsageSummary" class="area-summary">Daily requests, tokens, and model mix.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="usage">Open</button></div>
              </article>
              <article class="area-card">
                <h4 class="area-title">Diagnostics</h4>
                <p id="areaDiagnosticsSummary" class="area-summary">Recent incidents and trace triage.</p>
                <div class="area-actions"><button class="button primary" data-open-panel="diagnostics">Open</button></div>
              </article>
            </div>
          </section>

          <div id="detailPanelStore" class="is-hidden">
            <section class="section panel-content" data-panel-id="identity" data-panel-title="Branding & Agent Identity">
              <div class="identity-grid">
                <div class="identity-card">
                  <h4>Agent Email Routing</h4>
                  <label class="identity-label" for="agentEmailInput">Agent Email</label>
                  <div id="agentEmailInput" class="identity-value"></div>
                  <p class="identity-help">This address receives inbound client email and maps requests to this advisor profile.</p>
                  <div class="identity-actions">
                    <button class="button primary">Edit Agent Email</button>
                    <button class="button">Check Alias Availability</button>
                  </div>
                </div>
                <div class="identity-card">
                  <h4>Advisor Profile Defaults</h4>
                  <label class="identity-label" for="preferredNameInput">Preferred Name</label>
                  <div id="preferredNameInput" class="identity-value"></div>
                  <label class="identity-label" for="timezoneInput">Timezone</label>
                  <div id="timezoneInput" class="identity-value"></div>
                  <p class="identity-help">Used in agent sign-off, email tone, and suggested time formatting.</p>
                </div>
                <div class="identity-card">
                  <h4>Branding</h4>
                  <label class="identity-label">Brand Mode</label>
                  <div id="brandingMode" class="identity-value"></div>
                  <div class="logo-stack">
                    <div class="logo-item">
                      <img src="${defaultLogoSrc}" alt="LetsConnect logo" />
                      <div>
                        <p class="logo-name">LetsConnect.ai (default)</p>
                        <p class="logo-meta">Displayed when no advisor logo is configured.</p>
                      </div>
                    </div>
                    <div id="advisorLogoRow" class="logo-item">
                      <img id="advisorLogoPreview" src="${defaultLogoSrc}" alt="Advisor logo preview" />
                      <div>
                        <p id="advisorLogoName" class="logo-name">Advisor logo</p>
                        <p id="advisorLogoMeta" class="logo-meta">Upload from the portal for co-branding.</p>
                      </div>
                    </div>
                  </div>
                  <div class="identity-actions">
                    <button class="button primary">Upload Advisor Logo</button>
                    <button class="button">Use Default Logo</button>
                  </div>
                </div>
              </div>
            </section>

            <section class="section panel-content" data-panel-id="connections" data-panel-title="Connections">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Primary</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody id="connectionsBody"></tbody>
              </table>
            </section>

            <section class="section panel-content" data-panel-id="clients" data-panel-title="Clients">
              <div class="search-row">
                <input id="clientSearch" type="search" placeholder="Search clients..." />
                <button class="button">Bulk Import</button>
              </div>
              <div id="clientSummary" class="search-summary"></div>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>State</th>
                    <th>Policy</th>
                    <th>First Seen</th>
                    <th>Last Seen</th>
                    <th>Email</th>
                    <th>Web</th>
                  </tr>
                </thead>
                <tbody id="clientsBody"></tbody>
              </table>
            </section>

            <section class="section panel-content" data-panel-id="policies" data-panel-title="Policies">
              <table>
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Allowed Days</th>
                    <th>Source</th>
                    <th>Clients</th>
                  </tr>
                </thead>
                <tbody id="policiesBody"></tbody>
              </table>
            </section>

            <section class="section panel-content" data-panel-id="usage" data-panel-title="Usage">
              <div id="usageBars" class="usage-bars"></div>
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody id="usageModelBody"></tbody>
              </table>
            </section>

            <section class="section panel-content" data-panel-id="diagnostics" data-panel-title="Diagnostics">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Request ID</th>
                    <th>Issue</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody id="diagnosticsBody"></tbody>
              </table>
            </section>
          </div>
        </div>

        <div id="panelModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="panelModalTitle">
          <div class="modal-dialog">
            <div class="modal-header">
              <h3 id="panelModalTitle">Details</h3>
              <button id="panelModalClose" class="button">Close</button>
            </div>
            <div id="panelModalBody" class="modal-body"></div>
          </div>
        </div>

        <p class="copyright">Copyright (C) 2026. RR Emerge LLC</p>
      </main>
    </div>

    <script>
      const SCENARIOS = ${safeJson};
      let activeScenarioId = ${JSON.stringify(selectedScenarioId)};
      let activeClients = [];
      let activePanelNode = null;

      function findScenarioById(id) {
        return SCENARIOS.find((scenario) => scenario.id === id) || SCENARIOS[0];
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function formatNumber(value) {
        const parsed = Number(value ?? 0);
        if (!Number.isFinite(parsed)) {
          return "0";
        }
        return new Intl.NumberFormat("en-US").format(parsed);
      }

      function formatUsd(value) {
        const parsed = Number(value ?? 0);
        if (!Number.isFinite(parsed)) {
          return "$0.00";
        }
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(parsed);
      }

      function renderAlerts(alerts) {
        const node = document.getElementById("alerts");
        if (!Array.isArray(alerts) || alerts.length === 0) {
          node.innerHTML = '<div class="alert info"><div class="alert-title">No active alerts</div><div>Everything looks stable.</div></div>';
          return;
        }
        node.innerHTML = alerts
          .map((alert) => {
            const level = String(alert.level || "info");
            return '<div class="alert ' + escapeHtml(level) + '">' +
              '<div class="alert-title">' + escapeHtml(alert.title) + '</div>' +
              '<div>' + escapeHtml(alert.detail) + '</div>' +
              '</div>';
          })
          .join("");
      }

      function statusTag(status) {
        const normalized = String(status || "").toLowerCase();
        if (normalized === "active") {
          return '<span class="tag active">active</span>';
        }
        if (normalized === "blocked") {
          return '<span class="tag blocked">blocked</span>';
        }
        if (normalized === "deleted") {
          return '<span class="tag deleted">deleted</span>';
        }
        if (normalized === "connected") {
          return '<span class="tag connected">connected</span>';
        }
        if (normalized === "error") {
          return '<span class="tag error">error</span>';
        }
        return escapeHtml(normalized || "-");
      }

      function renderConnections(connections) {
        const node = document.getElementById("connectionsBody");
        if (!Array.isArray(connections) || connections.length === 0) {
          node.innerHTML = '<tr><td colspan="5">No calendar connections configured.</td></tr>';
          return;
        }
        node.innerHTML = connections
          .map((item) => '<tr>' +
            '<td><code>' + escapeHtml(item.provider) + '</code></td>' +
            '<td>' + escapeHtml(item.account) + '</td>' +
            '<td>' + statusTag(item.status) + '</td>' +
            '<td>' + (item.primary ? "Yes" : "No") + '</td>' +
            '<td>' + escapeHtml(item.updatedAt) + '</td>' +
            '</tr>')
          .join("");
      }

      function renderPolicies(policies) {
        const node = document.getElementById("policiesBody");
        if (!Array.isArray(policies) || policies.length === 0) {
          node.innerHTML = '<tr><td colspan="4">No policies configured.</td></tr>';
          return;
        }
        node.innerHTML = policies
          .map((item) => '<tr>' +
            '<td><code>' + escapeHtml(item.id) + '</code></td>' +
            '<td>' + escapeHtml(item.days) + '</td>' +
            '<td>' + escapeHtml(item.source) + '</td>' +
            '<td>' + formatNumber(item.clients) + '</td>' +
            '</tr>')
          .join("");
      }

      function renderClientsRows(searchQuery) {
        const normalized = String(searchQuery || "").trim().toLowerCase();
        const node = document.getElementById("clientsBody");
        const summary = document.getElementById("clientSummary");
        const filtered = activeClients.filter((client) => {
          if (!normalized) {
            return true;
          }
          return (
            String(client.name || "").toLowerCase().includes(normalized) ||
            String(client.email || "").toLowerCase().includes(normalized)
          );
        });

        if (filtered.length === 0) {
          node.innerHTML = '<tr><td colspan="8">No clients match this search.</td></tr>';
        } else {
          node.innerHTML = filtered
            .map((item) => '<tr>' +
              '<td>' + escapeHtml(item.name) + '</td>' +
              '<td><code>' + escapeHtml(item.email) + '</code></td>' +
              '<td>' + statusTag(item.state) + '</td>' +
              '<td><code>' + escapeHtml(item.policyId) + '</code></td>' +
              '<td>' + escapeHtml(item.firstSeen) + '</td>' +
              '<td>' + escapeHtml(item.lastSeen) + '</td>' +
              '<td>' + formatNumber(item.emailCount) + '</td>' +
              '<td>' + formatNumber(item.webCount) + '</td>' +
              '</tr>')
            .join("");
        }

        summary.textContent = "Showing " + formatNumber(filtered.length) + " of " + formatNumber(activeClients.length) + " listed clients.";
      }

      function renderUsageTrend(usageTrend) {
        const node = document.getElementById("usageBars");
        if (!Array.isArray(usageTrend) || usageTrend.length === 0) {
          node.innerHTML = "<div>No usage data.</div>";
          return;
        }

        const maxRequests = usageTrend.reduce((max, row) => Math.max(max, Number(row.requests || 0)), 1);
        node.innerHTML = usageTrend.map((row) => {
          const requests = Number(row.requests || 0);
          const fillPct = Math.max(4, Math.round((requests / maxRequests) * 100));
          return '<div class="bar-card">' +
            '<div class="bar"><div class="bar-fill" style="height:' + String(fillPct) + '%;"></div></div>' +
            '<div class="bar-meta"><strong>' + escapeHtml(row.label) + '</strong><br />' +
            formatNumber(row.requests) + ' req<br />' +
            formatUsd(row.costUsd) + '</div>' +
            '</div>';
        }).join("");
      }

      function renderUsageByModel(rows) {
        const node = document.getElementById("usageModelBody");
        if (!Array.isArray(rows) || rows.length === 0) {
          node.innerHTML = '<tr><td colspan="6">No LLM usage yet.</td></tr>';
          return;
        }
        node.innerHTML = rows.map((row) =>
          '<tr>' +
          '<td>' + escapeHtml(row.provider) + '</td>' +
          '<td><code>' + escapeHtml(row.model) + '</code></td>' +
          '<td>' + formatNumber(row.requests) + '</td>' +
          '<td>' + formatNumber(row.inputTokens) + '</td>' +
          '<td>' + formatNumber(row.outputTokens) + '</td>' +
          '<td>' + formatUsd(row.costUsd) + '</td>' +
          '</tr>'
        ).join("");
      }

      function renderDiagnostics(rows) {
        const node = document.getElementById("diagnosticsBody");
        if (!Array.isArray(rows) || rows.length === 0) {
          node.innerHTML = '<tr><td colspan="4">No diagnostics entries.</td></tr>';
          return;
        }
        node.innerHTML = rows.map((row) =>
          '<tr>' +
          '<td>' + escapeHtml(row.status) + '</td>' +
          '<td><code>' + escapeHtml(row.requestId) + '</code></td>' +
          '<td>' + escapeHtml(row.issue) + '</td>' +
          '<td>' + escapeHtml(row.updatedAt) + '</td>' +
          '</tr>'
        ).join("");
      }

      function updateWorkspaceSummaries(scenario) {
        const connections = Array.isArray(scenario.connections) ? scenario.connections : [];
        const policies = Array.isArray(scenario.policies) ? scenario.policies : [];
        const diagnostics = Array.isArray(scenario.diagnostics) ? scenario.diagnostics : [];
        const usageByModel = Array.isArray(scenario.usageByModel) ? scenario.usageByModel : [];
        const connectedCount = connections.filter((item) => String(item.status || "").toLowerCase() === "connected").length;
        const erroredConnections = connections.filter((item) => String(item.status || "").toLowerCase() === "error").length;
        const openDiagnostics = diagnostics.filter((item) => String(item.status || "").toLowerCase() === "open").length;
        const usageRequests = usageByModel.reduce((sum, row) => sum + Number(row.requests || 0), 0);
        const identitySummary = String(scenario.advisor.agentEmail || "No alias configured") +
          " | " +
          String(scenario.advisor.brandingMode || "default");

        document.getElementById("areaIdentitySummary").textContent = identitySummary;
        document.getElementById("areaConnectionsSummary").textContent =
          String(connectedCount) + " connected" + (erroredConnections > 0 ? " | " + String(erroredConnections) + " error" : "");
        document.getElementById("areaClientsSummary").textContent =
          formatNumber(activeClients.length) + " clients in directory";
        document.getElementById("areaPoliciesSummary").textContent =
          formatNumber(policies.length) + " policy profiles configured";
        document.getElementById("areaUsageSummary").textContent =
          formatNumber(usageRequests) + " model requests tracked this period";
        document.getElementById("areaDiagnosticsSummary").textContent =
          formatNumber(openDiagnostics) + " open diagnostics items";
      }

      function applyScenario(scenario) {
        const preferredName = String(scenario.advisor.preferredName || scenario.advisor.name || "").trim();
        const agentEmail = String(scenario.advisor.agentEmail || "").trim();
        const timezone = String(scenario.advisor.timezone || "America/Los_Angeles").trim();
        const brandingMode = String(scenario.advisor.brandingMode || "default").toLowerCase();
        const isCoBranded = brandingMode === "co-branded" || brandingMode === "cobranded";
        const advisorLogoName = String(scenario.advisor.advisorLogoName || "").trim();
        const advisorLogoSrc = String(scenario.advisor.advisorLogoSrc || "${defaultLogoSrc}").trim();

        document.getElementById("advisorName").textContent = scenario.advisor.name;
        document.getElementById("advisorMeta").textContent =
          scenario.advisor.email + " | " + scenario.advisor.timezone + " | " + scenario.advisor.agentEmail + " | " + scenario.advisor.plan;
        document.getElementById("scenarioSubtitle").textContent = scenario.subtitle;
        document.getElementById("agentEmailInput").textContent = agentEmail || "Not configured";
        document.getElementById("preferredNameInput").textContent = preferredName || "Not configured";
        document.getElementById("timezoneInput").textContent = timezone || "Not configured";
        document.getElementById("brandingMode").textContent = isCoBranded ? "Co-branded (advisor + LetsConnect)" : "Default LetsConnect branding";

        const advisorLogoRow = document.getElementById("advisorLogoRow");
        const advisorLogoNameNode = document.getElementById("advisorLogoName");
        const advisorLogoMetaNode = document.getElementById("advisorLogoMeta");
        const advisorLogoPreviewNode = document.getElementById("advisorLogoPreview");
        if (isCoBranded && advisorLogoName) {
          advisorLogoRow.classList.remove("is-hidden");
          advisorLogoNameNode.textContent = advisorLogoName;
          advisorLogoMetaNode.textContent = "Advisor custom logo (co-brand active).";
          advisorLogoPreviewNode.setAttribute("src", advisorLogoSrc);
        } else {
          advisorLogoRow.classList.remove("is-hidden");
          advisorLogoNameNode.textContent = "No advisor logo uploaded";
          advisorLogoMetaNode.textContent = "Upload from the portal to enable co-branding.";
          advisorLogoPreviewNode.setAttribute("src", "${defaultLogoSrc}");
        }

        document.getElementById("kpiConnected").textContent = formatNumber(scenario.overview.connectedCalendars);
        document.getElementById("kpiClients").textContent = formatNumber(scenario.overview.activeClients);
        document.getElementById("kpiBookings").textContent = formatNumber(scenario.overview.bookingsThisWeek);
        document.getElementById("kpiInbound").textContent = formatNumber(scenario.overview.inboundToday);
        document.getElementById("kpiLatency").textContent = formatNumber(scenario.overview.responseP95Seconds) + "s";
        document.getElementById("kpiCost").textContent = formatUsd(scenario.overview.estimatedMonthCostUsd);

        renderAlerts(scenario.alerts);
        renderConnections(scenario.connections);
        renderPolicies(scenario.policies);

        activeClients = Array.isArray(scenario.clients) ? scenario.clients : [];
        renderClientsRows(document.getElementById("clientSearch").value);
        renderUsageTrend(scenario.usageTrend);
        renderUsageByModel(scenario.usageByModel);
        renderDiagnostics(scenario.diagnostics);
        updateWorkspaceSummaries(scenario);
      }

      function setActiveNavButton(panelId) {
        const buttons = Array.from(document.querySelectorAll("#sectionNav button"));
        for (const button of buttons) {
          const isActive = button.getAttribute("data-panel") === panelId;
          button.classList.toggle("active", isActive);
        }
      }

      function closePanelModal() {
        const modal = document.getElementById("panelModal");
        const panelStore = document.getElementById("detailPanelStore");
        const modalBody = document.getElementById("panelModalBody");
        if (activePanelNode) {
          panelStore.appendChild(activePanelNode);
          activePanelNode = null;
        }
        modal.classList.add("is-hidden");
        modalBody.innerHTML = "";
        setActiveNavButton("overview");
      }

      function openPanel(panelId) {
        if (!panelId || panelId === "overview") {
          closePanelModal();
          document.getElementById("overview").scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }

        const modal = document.getElementById("panelModal");
        const panelStore = document.getElementById("detailPanelStore");
        const modalBody = document.getElementById("panelModalBody");
        const panelNode = panelStore.querySelector('[data-panel-id="' + panelId + '"]');
        if (!panelNode) {
          return;
        }

        if (activePanelNode && activePanelNode !== panelNode) {
          panelStore.appendChild(activePanelNode);
          activePanelNode = null;
        }

        const panelTitle = panelNode.getAttribute("data-panel-title") || "Details";
        document.getElementById("panelModalTitle").textContent = panelTitle;
        modalBody.innerHTML = "";
        modalBody.appendChild(panelNode);
        activePanelNode = panelNode;
        modal.classList.remove("is-hidden");
        setActiveNavButton(panelId);
      }

      function initialize() {
        const scenarioSelect = document.getElementById("scenarioSelect");
        const selectedScenario = findScenarioById(activeScenarioId);
        if (selectedScenario) {
          scenarioSelect.value = selectedScenario.id;
          applyScenario(selectedScenario);
        }

        scenarioSelect.addEventListener("change", (event) => {
          activeScenarioId = String(event.target.value || "").trim();
          const scenario = findScenarioById(activeScenarioId);
          if (!scenario) {
            return;
          }
          applyScenario(scenario);
        });

        document.getElementById("clientSearch").addEventListener("input", (event) => {
          renderClientsRows(event.target.value);
        });

        const navButtons = Array.from(document.querySelectorAll("#sectionNav button"));
        for (const button of navButtons) {
          button.addEventListener("click", () => {
            openPanel(button.getAttribute("data-panel"));
          });
        }

        const cardButtons = Array.from(document.querySelectorAll("[data-open-panel]"));
        for (const button of cardButtons) {
          button.addEventListener("click", () => {
            openPanel(button.getAttribute("data-open-panel"));
          });
        }

        const modal = document.getElementById("panelModal");
        document.getElementById("panelModalClose").addEventListener("click", closePanelModal);
        modal.addEventListener("click", (event) => {
          if (event.target === modal) {
            closePanelModal();
          }
        });
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            closePanelModal();
          }
        });
      }

      initialize();
    </script>
  </body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureRaw = await fs.readFile(args.fixturePath, "utf8");
  const fixture = JSON.parse(fixtureRaw);
  const scenarios = Array.isArray(fixture.scenarios) ? fixture.scenarios : [];

  if (scenarios.length === 0) {
    throw new Error("Fixture has no scenarios.");
  }

  const selectedScenarioId =
    scenarios.find((scenario) => scenario.id === args.scenarioId)?.id ?? scenarios[0].id;
  const html = buildPreviewHtml({
    scenarios,
    selectedScenarioId
  });

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, html, "utf8");
  console.log(`Advisor workspace preview generated: ${args.outputPath}`);

  if (args.openInBrowser) {
    openFileInBrowser(args.outputPath);
    console.log("Opened preview in your default browser.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
