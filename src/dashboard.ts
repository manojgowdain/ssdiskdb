import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { SSDiskDBClient, connect } from "./index.ts";
import { validateApiKey } from "./core/auth.ts";

// Track client heartbeats globally/module level
const activeHeartbeats = new Map<string, number>();

interface SessionData {
  username: string;
  userRole: string;
  expiresAt: number;
  connectionUri?: string;
}
const sessions = new Map<string, SessionData>();
const remoteClients = new Map<string, SSDiskDBClient>();

async function getClientForSession(sessionData: SessionData, localClient: SSDiskDBClient): Promise<SSDiskDBClient> {
  if (sessionData.connectionUri) {
    let rClient = remoteClients.get(sessionData.connectionUri);
    if (!rClient) {
      rClient = await connect(sessionData.connectionUri);
      remoteClients.set(sessionData.connectionUri, rClient);
    }
    return rClient;
  }
  return localClient;
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    const name = parts.shift()?.trim();
    if (name) {
      list[name] = decodeURIComponent(parts.join("="));
    }
  });
  return list;
}

export interface DashboardServer {
  close(): Promise<void>;
}

// Parse raw leveldb key
function parseKey(rawKey: string): { type: string; server: string; key: string; name?: string } {
  const parts = rawKey.split(":");
  const typeChar = parts[0]; // 's', 'h', 'z'
  let type = "string";
  if (typeChar === "h") type = "hash";
  if (typeChar === "z") type = "zset";

  if (parts[1] === "client") {
    const server = parts[2];
    if (typeChar === "s") {
      const key = parts.slice(3).join(":");
      return { type, server, key };
    } else {
      const name = parts[3];
      const key = parts.slice(4).join(":");
      return { type, server, key, name };
    }
  } else {
    const server = "Local";
    if (typeChar === "s") {
      const key = parts.slice(1).join(":");
      return { type, server, key };
    } else {
      const name = parts[1];
      const key = parts.slice(2).join(":");
      return { type, server, key, name };
    }
  }
}

// Function to generate the HTML for the dashboard
function getDashboardHtml(username: string, role: string, mode: string = "local", remoteInfo?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SSDiskDB Insights Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0f172a;
      --card-bg: #1e293b;
      --border-color: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-blue: #3b82f6;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --accent-yellow: #f59e0b;
      --font-family: 'Inter', -apple-system, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: var(--font-family);
      line-height: 1.5;
      padding: 2rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 1.5rem;
    }

    h1 {
      font-size: 1.8rem;
      font-weight: 700;
      background: linear-gradient(to right, #60a5fa, #34d399);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    .btn {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-weight: 500;
      font-size: 0.875rem;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-primary {
      background-color: var(--accent-blue);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background-color: #2563eb;
    }

    .btn-success {
      background-color: var(--accent-green);
      color: white;
    }

    .btn-success:hover:not(:disabled) {
      background-color: #059669;
    }

    .btn-danger {
      background-color: var(--accent-red);
      color: white;
    }

    .btn-danger:hover:not(:disabled) {
      background-color: #dc2626;
    }

    .btn-secondary {
      background-color: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-main);
    }

    .btn-secondary:hover:not(:disabled) {
      background-color: var(--card-bg);
    }

    .stats-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      padding: 1.5rem;
      position: relative;
      overflow: hidden;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--accent-blue);
    }

    .stat-card.green::before {
      background: var(--accent-green);
    }

    .stat-card.red::before {
      background: var(--accent-red);
    }

    .stat-title {
      font-size: 0.875rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.8rem;
      font-weight: 700;
    }

    .main-content {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      padding: 1.5rem;
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .search-input {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      border: 1px solid var(--border-color);
      background-color: var(--bg-color);
      color: var(--text-main);
      font-size: 0.875rem;
      width: 100%;
      max-width: 300px;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.9rem;
    }

    th {
      background-color: var(--bg-color);
      color: var(--text-muted);
      font-weight: 600;
      padding: 1rem;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 1rem;
      border-bottom: 1px solid var(--border-color);
      vertical-align: middle;
    }

    tr:hover td {
      background-color: rgba(255, 255, 255, 0.02);
    }

    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      border-radius: 0.25rem;
      text-transform: uppercase;
    }

    .badge-string { background-color: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .badge-hash { background-color: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-zset { background-color: rgba(245, 158, 11, 0.2); color: #fbbf24; }

    .key-name {
      font-family: monospace;
      font-weight: 600;
      word-break: break-all;
    }

    .key-value {
      font-family: monospace;
      color: var(--text-muted);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
    }

    /* Modal styles */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background-color: rgba(15, 23, 42, 0.8);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      backdrop-filter: blur(4px);
    }

    .modal {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      width: 100%;
      max-width: 500px;
      padding: 1.5rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
      animation: slideDown 0.2s ease-out;
    }

    @keyframes slideDown {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem;
    }

    .form-group {
      margin-bottom: 1rem;
    }

    .form-group label {
      display: block;
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }

    .form-control {
      width: 100%;
      padding: 0.5rem;
      border-radius: 0.375rem;
      border: 1px solid var(--border-color);
      background-color: var(--bg-color);
      color: var(--text-main);
      font-size: 0.875rem;
    }

    .form-control:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }

    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      background-color: var(--card-bg);
      border-left: 4px solid var(--accent-green);
      border-radius: 0.25rem;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
      display: none;
      z-index: 2000;
      font-size: 0.875rem;
    }

    .toast.error {
      border-left-color: var(--accent-red);
    }

    .spinner {
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-left-color: currentColor;
      border-radius: 50%;
      width: 1rem;
      height: 1rem;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .tabs-container {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem;
    }

    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background-color: rgba(255, 255, 255, 0.05);
    }

    .tab-btn.active {
      color: white;
      background-color: var(--accent-blue);
    }

    .badge-online {
      background-color: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }

    .badge-offline {
      background-color: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>SSDiskDB Insights</h1>
      <p style="font-size: 0.875rem; color: var(--text-muted);">${mode === 'remote' ? 'Remote Cache Client Console' : 'Local Embedded Cache Console'}</p>
    </div>
    <div class="user-info">
      <span>User: <strong>${username}</strong> (${role})</span>
      <button class="btn btn-secondary" onclick="logout(this)">Logout</button>
    </div>
  </header>

  <div class="stats-container">
    <div class="stat-card">
      <div class="stat-title">Total Keys</div>
      <div class="stat-value" id="stat-total-keys">0</div>
    </div>
    <div class="stat-card green">
      <div class="stat-title">Database Mode</div>
      <div class="stat-value" id="db-mode-title">${mode === 'remote' ? 'Remote Cache' : 'LevelDB (Local)'}</div>
      <div id="db-mode-subtitle" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${mode === 'remote' ? remoteInfo : 'Active Local Instance'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Server Status</div>
      <div class="stat-value" style="color: var(--accent-green)">Online</div>
    </div>
  </div>

  <div class="main-content">
    <div class="tabs-container">
      <button class="tab-btn active" id="tab-btn-keys" onclick="switchTab('keys')">Cache Keys</button>
      <button class="tab-btn" id="tab-btn-servers" onclick="switchTab('servers')" style="display: ${mode === 'remote' ? 'none' : 'block'};">Allowed Servers</button>
      <button class="tab-btn" id="tab-btn-subaccounts" onclick="switchTab('subaccounts')" style="display: ${(role === 'admin' && mode !== 'remote') ? 'block' : 'none'};">Sub-accounts</button>
      <button class="tab-btn" id="tab-btn-docs" onclick="switchTab('docs')">Documentation Docs</button>
    </div>

    <div id="cache-keys-section">
      <div class="toolbar">
        <input type="text" class="search-input" id="search-bar" placeholder="Search keys..." oninput="filterKeys()">
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <select class="form-control" id="server-filter" onchange="filterKeys()" style="width: auto; min-width: 130px; margin-right: 0.5rem;">
            <option value="all">All Servers</option>
            <option value="Local">Local</option>
          </select>
          <button class="btn btn-secondary" id="btn-refresh" onclick="loadKeys(true)">
            Refresh
          </button>
          <button class="btn btn-success" onclick="openAddModal()">
            Add Key
          </button>
          <button class="btn btn-danger" onclick="openFlushModal()">
            Flush Cache
          </button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Type</th>
              <th>Key Name</th>
              <th>Value / Details</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="keys-table-body">
            <!-- Dynamically filled -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- Allowed Servers Section -->
    <div id="allowed-servers-section" style="display: none;">
      <div class="toolbar">
        <div style="display: flex; gap: 0.5rem; width: 100%; max-width: 600px; flex-wrap: wrap;">
          <input type="text" class="form-control" id="new-server-address" placeholder="Server IP or ID (e.g. server-a)" style="flex: 1; min-width: 180px;">
          <input type="text" class="form-control" id="new-server-apikey" placeholder="API Key (optional, auto-generated if blank)" style="flex: 1; min-width: 220px;">
          <button class="btn btn-success" id="btn-add-server" onclick="addAllowedServer()" style="white-space: nowrap;">
            Allow Server
          </button>
        </div>
        <button class="btn btn-secondary" id="btn-refresh-servers" onclick="loadServers()">
          Refresh Servers
        </button>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Server IP / Hostname</th>
              <th>Status</th>
              <th>API Key</th>
              <th>Last Heartbeat</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="servers-table-body">
            <!-- Dynamically filled -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sub-accounts Section -->
    <div id="subaccounts-section" style="display: none;">
      <div class="toolbar">
        <button class="btn btn-success" onclick="openCreateSubaccountForm()">Create Sub-account</button>
        <button class="btn btn-secondary" onclick="loadSubaccounts()">Refresh</button>
      </div>

      <!-- Create Sub-account Form (Inline Card) -->
      <div id="subaccount-form-container" style="display: none; background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; max-width: 500px; margin-bottom: 2rem; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3); animation: slideDown 0.2s ease-out;">
        <h3 style="margin-top: 0; margin-bottom: 1.25rem; font-size: 1.1rem; font-weight: 600; color: white;">Create Sub-account</h3>
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Username</label>
          <input type="text" class="form-control" id="sub-new-username" placeholder="e.g. junior_dev" style="width: 100%;">
        </div>
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Password</label>
          <input type="password" class="form-control" id="sub-new-password" placeholder="••••••••" style="width: 100%;">
        </div>
        <div style="margin-bottom: 1.25rem;">
          <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Role</label>
          <select class="form-control" id="sub-new-role" style="width: 100%; background-color: var(--bg-color); color: white; border: 1px solid var(--border-color); border-radius: 0.375rem; padding: 0.5rem;">
            <option value="junior">Junior Dev (Read-only)</option>
            <option value="senior">Senior Dev (Read/Write)</option>
          </select>
        </div>
        <div style="margin-bottom: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
          <label style="display: block; font-size: 0.85rem; color: #fca5a5; margin-bottom: 0.5rem; font-weight: 600;">Confirm with Admin Credentials</label>
          <input type="password" class="form-control" id="sub-admin-password" placeholder="Enter Admin Password" style="width: 100%;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
          <button class="btn btn-secondary" onclick="closeCreateSubaccountForm()">Cancel</button>
          <button class="btn btn-success" id="btn-save-subaccount" onclick="createSubaccount()">Create Account</button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="subaccounts-table-body">
            <!-- Dynamically filled -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- Documentation Section -->
    <div id="documentation-section" style="display: none; padding-top: 1rem; max-width: 900px; margin: 0 auto;">
      <h2 style="font-size: 1.4rem; font-weight: 600; margin-bottom: 1.5rem; color: white; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
        SSDiskDB Integration &amp; Usage Guide
      </h2>

      <!-- Card 1: Local Mode & Encryption -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: #60a5fa; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
          <span style="background-color: rgba(59, 130, 246, 0.15); padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; font-family: monospace;">Local</span>
          Local Storage &amp; Self-Encryption
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          In Local Mode, SSDiskDB runs embedded directly inside your Node.js process using <strong>LevelDB</strong>. New encrypted values use AES-256-GCM; older AES-256-CBC records remain readable.
        </p>
        <pre style="background-color: rgba(0, 0, 0, 0.3); padding: 1rem; border-radius: 0.375rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.85rem; color: #34d399; overflow-x: auto; margin-bottom: 0;">
const { connect } = require("@manojgowdain/ssdiskdb");

(async () => {
  const db = await connect({
    storagePath: "./secure-local-cache",
    encryptionKey: "your-secret-aes-key", // Enables authenticated AES-256-GCM encryption
    startDashboard: true,               // Launches this dashboard UI console
    dashboardPort: 8971
  });

  // Data is encrypted transparently on disk
  await db.set("secure_key", { sensitiveData: "secret-value" });
  console.log(await db.get("secure_key")); // Auto-decrypted object

  await db.close();
})();</pre>
      </div>

      <!-- Card 2: Remote VPC Mode -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: #34d399; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
          <span style="background-color: rgba(52, 211, 153, 0.15); padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; font-family: monospace;">VPC Remote</span>
          Cross-Server Remote Cache
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          When whitelisted, remote client servers can establish connection to this central cache. Connection performs a handshake check immediately at startup. Keys are isolated in a server-specific namespace (e.g. <code>s:client:server-a:key</code>).
        </p>
        <pre style="background-color: rgba(0, 0, 0, 0.3); padding: 1rem; border-radius: 0.375rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.85rem; color: #34d399; overflow-x: auto; margin-bottom: 1rem;">
const { connect } = require("@manojgowdain/ssdiskdb");

(async () => {
  // Remote client connection
  const db = await connect({
    remoteUrl: "http://&lt;central-server-ip&gt;:8971",
    apiKey: "ssdb_c4dee067d4a23dd35da3270ddd5b2cc5", // Copy from Allowed Servers tab
    serverId: "server-a"                          // Whitelisted Server ID
  });

  await db.set("cache_key", "value");
  console.log(await db.get("cache_key"));

  await db.close();
})();</pre>
        <div style="background-color: rgba(251, 191, 36, 0.08); border-left: 4px solid var(--accent-yellow); padding: 1rem; border-radius: 0.375rem; font-size: 0.875rem;">
          <strong style="color: var(--accent-yellow); display: block; margin-bottom: 0.5rem;">💡 Where to find/configure connection parameters:</strong>
          <ul style="list-style-type: none; padding-left: 0; display: flex; flex-direction: column; gap: 0.5rem;">
            <li>🔗 <strong style="color: white;">remoteUrl:</strong> The address of this central cache dashboard server (e.g. <code>http://10.0.0.2:8971</code> or <code>http://localhost:8971</code>).</li>
            <li>🔑 <strong style="color: white;">apiKey:</strong> The generated <code>ssdb_...</code> API key shown in the <strong>API Key</strong> column under the <strong>Allowed Servers</strong> tab.</li>
            <li>🖥️ <strong style="color: white;">serverId:</strong> The exact whitelisted identifier registered in the <strong>Server IP / Hostname</strong> column under the <strong>Allowed Servers</strong> tab (e.g., <code>127.0.0.1</code>, <code>server-a</code>, or any label you whitelisted).</li>
          </ul>
        </div>
      </div>

      <!-- Card 2.5: Connection URI Mode -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: #60a5fa; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
          <span style="background-color: rgba(59, 130, 246, 0.15); padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; font-family: monospace;">URI Scheme</span>
          Connection URI (Single String Configuration)
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          You can connect using a single URI containing the API key, host, server ID, and optional encryption key.
        </p>
        <pre style="background-color: rgba(0, 0, 0, 0.3); padding: 1rem; border-radius: 0.375rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.85rem; color: #34d399; overflow-x: auto; margin-bottom: 1rem;">
// Remote connection (no encryption)
const db = await connect("ssdiskdb://ssdb_c4dee067d4a23dd35da3270ddd5b2cc5@&lt;central-server-ip&gt;:8971/server-a");

// Remote connection (with encryption)
const db2 = await connect("ssdiskdb+encry://ssdb_c4dee067d4a23dd35da3270ddd5b2cc5@&lt;central-server-ip&gt;:8971/server-a?key=anfjsdnafnanfajidjf");</pre>
      </div>

      <!-- Card 3: CLI commands -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: #fbbf24; margin-bottom: 0.75rem;">
          Command-Line Interface (CLI)
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          Manage admin credentials, whitelist connections, and start servers directly using NPX:
        </p>
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <div>
            <strong style="font-size: 0.85rem; color: white; display: block; margin-bottom: 0.25rem;">Start Server:</strong>
            <code style="background-color: rgba(0, 0, 0, 0.2); padding: 0.3rem 0.6rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #fbbf24;">npx ssdiskdb start --port 8971 --path ./ssdb-local-db</code>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: white; display: block; margin-bottom: 0.25rem;">Change Admin Credentials:</strong>
            <code style="background-color: rgba(0, 0, 0, 0.2); padding: 0.3rem 0.6rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #fbbf24;">npx ssdiskdb credentials --username myuser --password mysecurepass --path ./ssdb-local-db</code>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: white; display: block; margin-bottom: 0.25rem;">Add Whitelisted Remote Client:</strong>
            <code style="background-color: rgba(0, 0, 0, 0.2); padding: 0.3rem 0.6rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #fbbf24;">npx ssdiskdb server add server-a --path ./ssdb-local-db</code>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: white; display: block; margin-bottom: 0.25rem;">List Remote Servers &amp; Keys:</strong>
            <code style="background-color: rgba(0, 0, 0, 0.2); padding: 0.3rem 0.6rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #fbbf24;">npx ssdiskdb server list --path ./ssdb-local-db</code>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: white; display: block; margin-bottom: 0.25rem;">Remove Client Server:</strong>
            <code style="background-color: rgba(0, 0, 0, 0.2); padding: 0.3rem 0.6rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #fbbf24;">npx ssdiskdb server remove server-a --path ./ssdb-local-db</code>
          </div>
        </div>
      </div>

      <!-- Card 4: Operations API -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: white; margin-bottom: 0.75rem;">
          Supported Data Types
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          SSDiskDB handles serialization and typing natively. All methods return standard Promises.
        </p>
        <div style="display: flex; flex-direction: column; gap: 1rem;">
          <div>
            <strong style="font-size: 0.85rem; color: #60a5fa; display: block; margin-bottom: 0.25rem;">Strings &amp; JSON:</strong>
            <pre style="background-color: rgba(0, 0, 0, 0.2); padding: 0.75rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #f8fafc; margin: 0;">
await db.set("key", { name: "Alice" });
await db.get("key"); // returns { name: "Alice" }
await db.exists("key"); // returns true
await db.incr("counter", 5); // increments by 5
await db.del("key");</pre>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: #34d399; display: block; margin-bottom: 0.25rem;">Hashes (Maps):</strong>
            <pre style="background-color: rgba(0, 0, 0, 0.2); padding: 0.75rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #f8fafc; margin: 0;">
await db.hset("user:1", "name", "Manoj");
await db.hget("user:1", "name"); // "Manoj"
await db.hdel("user:1", "name");</pre>
          </div>
          <div>
            <strong style="font-size: 0.85rem; color: #fbbf24; display: block; margin-bottom: 0.25rem;">Sorted Sets (ZSets):</strong>
            <pre style="background-color: rgba(0, 0, 0, 0.2); padding: 0.75rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-family: monospace; font-size: 0.8rem; color: #f8fafc; margin: 0;">
await db.zset("leaderboard", "player1", 99.5);
await db.zget("leaderboard", "player1"); // 99.5
await db.zdel("leaderboard", "player1");</pre>
          </div>
        </div>
      </div>

      <!-- Card 5: Whitelisting Guide -->
      <div style="background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 1.5rem; margin-top: 1.5rem;">
        <h3 style="font-size: 1.1rem; font-weight: 600; color: #fbbf24; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
          📋 How to use the Allowed Servers Section
        </h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
          Whitelisting registers a client server on this central cache. The whitelist input is a simple string identifier, <strong>NOT a URL</strong>. It must match either the client's network IP address or the <code>serverId</code> label configured in the client connection.
        </p>

        <div style="display: grid; grid-template-columns: 1fr; md:grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.25rem;">
          <div style="background-color: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.15); padding: 1rem; border-radius: 0.375rem;">
            <strong style="color: #f87171; display: block; margin-bottom: 0.5rem; font-size: 0.85rem;">❌ INCORRECT Whitelist Inputs (Do NOT use):</strong>
            <ul style="padding-left: 1.25rem; font-size: 0.8rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.4rem; list-style-type: disc;">
              <li><code>http://localhost:5000</code> (No protocol, port numbers, or slash paths)</li>
              <li><code>https://my-server.com/api</code> (No HTTPS schemes or sub-directories)</li>
              <li><code>localhost:5000</code> (Do not append ports to hostnames/domains)</li>
            </ul>
          </div>
          <div style="background-color: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.15); padding: 1rem; border-radius: 0.375rem;">
            <strong style="color: #34d399; display: block; margin-bottom: 0.5rem; font-size: 0.85rem;">✅ CORRECT Whitelist Inputs (Use these):</strong>
            <ul style="padding-left: 1.25rem; font-size: 0.8rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.4rem; list-style-type: disc;">
              <li><code>127.0.0.1</code> or <code>10.0.0.5</code> (Raw IP addresses)</li>
              <li><code>my-web-server.com</code> or <code>localhost</code> (Raw hostnames/domain names)</li>
              <li><code>server-a</code> or <code>subserver-1</code> (Custom Server ID labels)</li>
            </ul>
          </div>
        </div>

        <div style="background-color: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-color); padding: 1rem; border-radius: 0.375rem; font-size: 0.85rem; line-height: 1.5;">
          <strong style="color: white; display: block; margin-bottom: 0.5rem;">🔒 How HTTPS &amp; Ports are handled:</strong>
          <span style="color: var(--text-muted); display: block; margin-bottom: 0.5rem;">
            - <strong>Secure Proxy (HTTPS)</strong>: If this central server is behind an HTTPS reverse proxy (e.g. Nginx, Caddy), client servers connect using <code>remoteUrl: "https://your-central-cache.com"</code>. However, the whitelisted key you register on the dashboard remains just the client's raw IP or <code>serverId</code> label (e.g., <code>server-a</code>) — never register proxy protocols or URLs.
          </span>
          <span style="color: var(--text-muted); display: block;">
            - <strong>Subserver Ports</strong>: If you have a local subserver running on <code>localhost:5000</code> and want to connect it, whitelist <code>localhost</code> or a custom string like <code>subserver-5000</code> in this dashboard. On the subserver's connection code, pass <code>serverId: "localhost"</code> or <code>serverId: "subserver-5000"</code> (do not pass port numbers or URLs in <code>serverId</code>).
          </span>
        </div>
      </div>
    </div>
  </div>

  <!-- Add Modal -->
  <div class="modal-backdrop" id="add-modal">
    <div class="modal">
      <div class="modal-title">Add / Edit Cache Entry</div>
      <div class="form-group">
        <label for="new-key-type">Entry Type</label>
        <select class="form-control" id="new-key-type" onchange="toggleFormInputs()">
          <option value="string">String (Key-Value)</option>
          <option value="hash">Hash (Map)</option>
          <option value="zset">Sorted Set (Zset)</option>
        </select>
      </div>
      <div class="form-group" id="group-hash-name" style="display: none;">
        <label for="new-hash-name">Hash Name</label>
        <input type="text" class="form-control" id="new-hash-name" placeholder="e.g. user:100">
      </div>
      <div class="form-group" id="group-zset-name" style="display: none;">
        <label for="new-zset-name">Set Name</label>
        <input type="text" class="form-control" id="new-zset-name" placeholder="e.g. user_scores">
      </div>
      <div class="form-group">
        <label for="new-key-name" id="label-key-name">Key / Member Name</label>
        <input type="text" class="form-control" id="new-key-name" placeholder="e.g. session_id">
      </div>
      <div class="form-group" id="group-key-val">
        <label for="new-key-value">Value (JSON/String)</label>
        <textarea class="form-control" id="new-key-value" rows="3" placeholder='e.g. "my-val" or {"active": true}'></textarea>
      </div>
      <div class="form-group" id="group-zset-score" style="display: none;">
        <label for="new-zset-score">Score (Number)</label>
        <input type="number" class="form-control" id="new-zset-score" placeholder="e.g. 100">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeAddModal()">Cancel</button>
        <button class="btn btn-success" id="btn-save" onclick="saveKey()">Save Entry</button>
      </div>
    </div>
  </div>

  <!-- Detail Modal -->
  <div class="modal-backdrop" id="detail-modal">
    <div class="modal">
      <div class="modal-title">Cache Entry Details</div>
      <div class="form-group">
        <label>Full Prefixed Key</label>
        <input type="text" class="form-control" id="detail-full-key" readonly>
      </div>
      <div class="form-group">
        <label>Decrypted & Deserialized Value</label>
        <pre id="detail-value" style="background-color: var(--bg-color); padding: 1rem; border-radius: 0.375rem; overflow-x: auto; font-family: monospace; font-size: 0.85rem; border: 1px solid var(--border-color); max-height: 250px; overflow-y: auto;"></pre>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeDetailModal()">Close</button>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation Modal -->
  <div class="modal-backdrop" id="delete-modal">
    <div class="modal">
      <div class="modal-title" style="color: var(--accent-red);">Delete Cache Entry?</div>
      <p id="delete-modal-text" style="margin-bottom: 1.5rem; font-size: 0.9rem; color: var(--text-muted);"></p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
        <button class="btn btn-danger" id="btn-delete-confirm" onclick="confirmDeleteKey()">Delete Entry</button>
      </div>
    </div>
  </div>

  <!-- Flush Confirmation Modal -->
  <div class="modal-backdrop" id="flush-modal">
    <div class="modal">
      <div class="modal-title" style="color: var(--accent-red);">Flush Cache Database?</div>
      <p style="margin-bottom: 1.5rem; font-size: 0.9rem; color: var(--text-muted);">This action will permanently delete all keys in the database. Credentials and configuration will be preserved.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeFlushModal()">Cancel</button>
        <button class="btn btn-danger" id="btn-flush" onclick="flushDatabase()">Flush Everything</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">Database updated successfully</div>

  <script>
    const userRole = '${role}';
    const currentUsername = '${username}';
    let allKeys = [];

    async function loadKeys(isManual = false) {
      const btn = document.getElementById('btn-refresh');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Refreshing...';
      }
      try {
        const res = await fetch('/api/keys');
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        allKeys = await res.json();
        updateServerFilterDropdown(allKeys);
        filterKeys();
        if (isManual) {
          showToast('Database keys refreshed successfully');
        }
      } catch (err) {
        showToast('Failed to load keys', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function renderKeysTable(keys) {
      const tbody = document.getElementById('keys-table-body');
      tbody.innerHTML = '';

      document.getElementById('stat-total-keys').innerText = keys.length;

      if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">No cache keys found.</td></tr>';
        return;
      }

      keys.forEach(item => {
        const tr = document.createElement('tr');
        
        let typeBadge = '';
        if (item.type === 'string') {
          typeBadge = '<span class="badge badge-string">String</span>';
        } else if (item.type === 'hash') {
          typeBadge = '<span class="badge badge-hash">Hash</span>';
        } else if (item.type === 'zset') {
          typeBadge = '<span class="badge badge-zset">Sorted Set</span>';
        }

        let displayKey = item.key;
        if (item.type === 'hash' || item.type === 'zset') {
          displayKey = item.name + ' > ' + item.key;
        }

        const displayVal = JSON.stringify(item.value);
        const serverBadge = item.server === 'Local' 
          ? '<span class="badge badge-string" style="background-color: rgba(255,255,255,0.05); color: var(--text-muted);">Local</span>'
          : '<span class="badge badge-hash" style="background-color: rgba(59, 130, 246, 0.1); color: #60a5fa;">' + escapeHtml(item.server) + '</span>';

        tr.innerHTML = \`
          <td>\${serverBadge}</td>
          <td>\${typeBadge}</td>
          <td class="key-name">\${escapeHtml(displayKey)}</td>
          <td><div class="key-value">\${escapeHtml(displayVal)}</div></td>
          <td class="actions">
            <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem;" onclick="viewDetail('\${item.rawKey}')">View</button>
            \${userRole === 'junior' ? '' : \`<button class="btn btn-danger" style="padding: 0.25rem 0.5rem;" onclick="openDeleteModal('\${item.rawKey}')">Delete</button>\`}
          </td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function escapeHtml(text) {
      if (text === null || text === undefined) return '';
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function filterKeys() {
      const query = document.getElementById('search-bar').value.toLowerCase();
      const serverFilter = document.getElementById('server-filter').value;

      const filtered = allKeys.filter(item => {
        const matchesQuery = item.key.toLowerCase().includes(query) || (item.name && item.name.toLowerCase().includes(query));
        const matchesServer = serverFilter === 'all' || item.server === serverFilter;
        return matchesQuery && matchesServer;
      });

      renderKeysTable(filtered);
    }

    function updateServerFilterDropdown(keys) {
      const select = document.getElementById('server-filter');
      if (!select) return;
      const currentValue = select.value;
      
      const servers = new Set();
      servers.add('Local');
      keys.forEach(k => {
        if (k.server && k.server !== 'Local') {
          servers.add(k.server);
        }
      });

      select.innerHTML = '<option value="all">All Servers</option>';
      servers.forEach(srv => {
        const opt = document.createElement('option');
        opt.value = srv;
        opt.innerText = srv;
        select.appendChild(opt);
      });

      if (servers.has(currentValue) || currentValue === 'all') {
        select.value = currentValue;
      }
    }

    function switchTab(tabName) {
      const keysSection = document.getElementById('cache-keys-section');
      const serversSection = document.getElementById('allowed-servers-section');
      const docsSection = document.getElementById('documentation-section');
      const subaccountsSection = document.getElementById('subaccounts-section');
      const btnKeys = document.getElementById('tab-btn-keys');
      const btnServers = document.getElementById('tab-btn-servers');
      const btnDocs = document.getElementById('tab-btn-docs');
      const btnSubaccounts = document.getElementById('tab-btn-subaccounts');

      keysSection.style.display = 'none';
      serversSection.style.display = 'none';
      docsSection.style.display = 'none';
      if (subaccountsSection) subaccountsSection.style.display = 'none';
      btnKeys.classList.remove('active');
      btnServers.classList.remove('active');
      btnDocs.classList.remove('active');
      if (btnSubaccounts) btnSubaccounts.classList.remove('active');

      if (tabName === 'keys') {
        keysSection.style.display = 'block';
        btnKeys.classList.add('active');
        loadKeys();
      } else if (tabName === 'servers') {
        serversSection.style.display = 'block';
        btnServers.classList.add('active');
        loadServers();
      } else if (tabName === 'docs') {
        docsSection.style.display = 'block';
        btnDocs.classList.add('active');
      } else if (tabName === 'subaccounts') {
        if (subaccountsSection) subaccountsSection.style.display = 'block';
        if (btnSubaccounts) btnSubaccounts.classList.add('active');
        loadSubaccounts();
      }
    }

    async function loadServers() {
      const btn = document.getElementById('btn-refresh-servers');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Refreshing...';
      }
      try {
        const res = await fetch('/api/servers');
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        const servers = await res.json();
        renderServersTable(servers);
      } catch (err) {
        showToast('Failed to load servers', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function renderServersTable(servers) {
      const tbody = document.getElementById('servers-table-body');
      tbody.innerHTML = '';

      if (servers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">No allowed servers registered.</td></tr>';
        return;
      }

      servers.forEach(srv => {
        const tr = document.createElement('tr');
        let statusBadge = '';
        if (srv.status === 'Online') {
          statusBadge = '<span class="badge badge-online">Online</span>';
        } else if (srv.status === 'Offline') {
          statusBadge = '<span class="badge badge-offline">Offline</span>';
        } else if (srv.status === 'Blocked') {
          statusBadge = '<span class="badge badge-offline" style="background-color: rgba(239, 68, 68, 0.3); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.5);">Blocked</span>';
        }

        const blockBtnText = srv.blocked ? 'Allow Access' : 'Block';
        const blockBtnClass = srv.blocked ? 'btn-success' : 'btn-secondary';
        const blockBtnStyle = srv.blocked ? '' : 'border-color: var(--accent-red); color: #f87171;';

        tr.innerHTML = \`
          <td class="key-name">\${escapeHtml(srv.address)}</td>
          <td>\${statusBadge}</td>
          <td>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <code style="background-color: var(--bg-color); padding: 0.2rem 0.4rem; border-radius: 0.25rem; border: 1px solid var(--border-color); font-size: 0.8rem; font-family: monospace;">\${escapeHtml(srv.apiKey)}</code>
              \${userRole === 'admin' ? \`<button class="btn btn-secondary" style="padding: 0.1rem 0.3rem; font-size: 0.75rem;" onclick="copyToClipboard('\${srv.apiKey}')">Copy Key</button>\` : ''}
              \${userRole === 'admin' ? \`<button class="btn btn-secondary" style="padding: 0.1rem 0.3rem; font-size: 0.75rem;" onclick="copyConnectionUrl('\${srv.apiKey}', '\${srv.address}')">Copy URI</button>\` : ''}
            </div>
          </td>
          <td>\${escapeHtml(srv.lastHeartbeat)}</td>
          <td class="actions">
            \${userRole === 'junior'
              ? '<span>No actions allowed</span>'
              : \`<button class="btn \${blockBtnClass}" style="padding: 0.25rem 0.5rem; \${blockBtnStyle}" onclick="toggleBlockServer('\${srv.address}', this)">\${blockBtnText}</button>
                 \${userRole === 'admin' ? \`<button class="btn btn-secondary" style="padding: 0.25rem 0.5rem;" onclick="reissueServerKey('\${srv.address}', this)">Reissue Key</button>\` : ''}
                 <button class="btn btn-danger" style="padding: 0.25rem 0.5rem;" onclick="deleteAllowedServer('\${srv.address}', this)">Remove</button>\`
            }
          </td>
        \`;
        tbody.appendChild(tr);
      });
    }

    async function toggleBlockServer(address, btn) {
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width: 0.75rem; height: 0.75rem; border-width: 1.5px;"></span>';
      }
      try {
        const res = await fetch('/api/servers/toggle-block', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        if (res.ok) {
          showToast('Server access updated');
          loadServers();
        } else {
          showToast('Failed to update server access', true);
        }
      } catch (err) {
        showToast('Server error', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    async function reissueServerKey(address, btn) {
      if (!confirm('Are you sure you want to reissue the API Key for ' + address + '? The old key will immediately stop working.')) return;
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width: 0.75rem; height: 0.75rem; border-width: 1.5px;"></span>';
      }
      try {
        const res = await fetch('/api/servers/reissue-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        if (res.ok) {
          showToast('API Key reissued successfully');
          loadServers();
        } else {
          showToast('Failed to reissue key', true);
        }
      } catch (err) {
        showToast('Server error', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('API Key copied to clipboard');
      }).catch(err => {
        showToast('Failed to copy API Key', true);
      });
    }

    function copyConnectionUrl(apiKey, serverId) {
      const url = 'ssdiskdb://' + apiKey + '@' + window.location.host + '/' + serverId;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Connection URI copied to clipboard');
      }).catch(err => {
        showToast('Failed to copy Connection URI', true);
      });
    }

    async function addAllowedServer() {
      const inputAddr = document.getElementById('new-server-address');
      const inputKey = document.getElementById('new-server-apikey');
      const address = inputAddr.value.trim();
      const apiKey = inputKey.value.trim();
      if (!address) {
        showToast('Please enter a server IP or Hostname', true);
        return;
      }

      const btn = document.getElementById('btn-add-server');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Adding...';
      }

      try {
        const res = await fetch('/api/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, apiKey })
        });
        if (res.ok) {
          showToast('Server allowed successfully');
          inputAddr.value = '';
          if (inputKey) inputKey.value = '';
          loadServers();
        } else {
          showToast('Failed to allow server', true);
        }
      } catch (err) {
        showToast('Server error during add', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    async function deleteAllowedServer(address, btn) {
      if (!confirm('Are you sure you want to remove ' + address + ' from allowed servers?')) return;

      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width: 0.75rem; height: 0.75rem; border-width: 1.5px;"></span> Removing...';
      }

      try {
        const res = await fetch('/api/servers', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        if (res.ok) {
          showToast('Server access removed');
          loadServers();
        } else {
          showToast('Failed to remove server', true);
        }
      } catch (err) {
        showToast('Server error during remove', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = message;
      toast.style.display = 'block';
      if (isError) {
        toast.classList.add('error');
      } else {
        toast.classList.remove('error');
      }
      setTimeout(() => {
        toast.style.display = 'none';
      }, 3000);
    }

    // Modal helpers
    function openAddModal() {
      document.getElementById('add-modal').style.display = 'flex';
      toggleFormInputs();
    }
    function closeAddModal() {
      document.getElementById('add-modal').style.display = 'none';
      document.getElementById('new-key-name').value = '';
      document.getElementById('new-key-value').value = '';
      document.getElementById('new-hash-name').value = '';
      document.getElementById('new-zset-name').value = '';
      document.getElementById('new-zset-score').value = '';
    }

    function toggleFormInputs() {
      const type = document.getElementById('new-key-type').value;
      const groupHash = document.getElementById('group-hash-name');
      const groupZset = document.getElementById('group-zset-name');
      const groupVal = document.getElementById('group-key-val');
      const groupScore = document.getElementById('group-zset-score');
      const labelKey = document.getElementById('label-key-name');

      if (type === 'string') {
        groupHash.style.display = 'none';
        groupZset.style.display = 'none';
        groupVal.style.display = 'block';
        groupScore.style.display = 'none';
        labelKey.innerText = 'Key Name';
      } else if (type === 'hash') {
        groupHash.style.display = 'block';
        groupZset.style.display = 'none';
        groupVal.style.display = 'block';
        groupScore.style.display = 'none';
        labelKey.innerText = 'Field Name';
      } else if (type === 'zset') {
        groupHash.style.display = 'none';
        groupZset.style.display = 'block';
        groupVal.style.display = 'none';
        groupScore.style.display = 'block';
        labelKey.innerText = 'Member Name';
      }
    }

    async function saveKey() {
      const type = document.getElementById('new-key-type').value;
      const keyName = document.getElementById('new-key-name').value.trim();
      const rawVal = document.getElementById('new-key-value').value.trim();
      const hashName = document.getElementById('new-hash-name').value.trim();
      const zsetName = document.getElementById('new-zset-name').value.trim();
      const score = document.getElementById('new-zset-score').value;

      if (!keyName) {
        showToast('Please enter a key or member name', true);
        return;
      }

      let payload = {};

      if (type === 'string') {
        let value = rawVal;
        try {
          value = JSON.parse(rawVal);
        } catch (e) {
          // If not valid JSON, treat as raw string
        }
        payload = { type, key: keyName, value };
      } else if (type === 'hash') {
        if (!hashName) {
          showToast('Please enter a hash name', true);
          return;
        }
        let value = rawVal;
        try {
          value = JSON.parse(rawVal);
        } catch (e) {
          // Treat as raw string
        }
        payload = { type, name: hashName, key: keyName, value };
      } else if (type === 'zset') {
        if (!zsetName) {
          showToast('Please enter a sorted set name', true);
          return;
        }
        if (score === '') {
          showToast('Please enter a score', true);
          return;
        }
        payload = { type, name: zsetName, key: keyName, score: parseFloat(score) };
      }

      const btn = document.getElementById('btn-save');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Saving...';
      }

      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast('Key saved successfully');
          closeAddModal();
          loadKeys();
        } else {
          const text = await res.text();
          showToast('Failed to save key: ' + text, true);
        }
      } catch (err) {
        showToast('Server error during save', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    let keyToDelete = null;

    function openDeleteModal(prefixedKey) {
      keyToDelete = prefixedKey;
      document.getElementById('delete-modal-text').innerText = 'Are you sure you want to delete "' + prefixedKey + '"? This action cannot be undone.';
      document.getElementById('delete-modal').style.display = 'flex';
    }

    function closeDeleteModal() {
      document.getElementById('delete-modal').style.display = 'none';
      keyToDelete = null;
    }

    async function confirmDeleteKey() {
      if (!keyToDelete) return;

      const btn = document.getElementById('btn-delete-confirm');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Deleting...';
      }

      try {
        const res = await fetch('/api/keys', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyToDelete })
        });
        if (res.ok) {
          showToast('Key deleted');
          closeDeleteModal();
          loadKeys();
        } else {
          showToast('Failed to delete key', true);
        }
      } catch (err) {
        showToast('Server error during delete', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function viewDetail(prefixedKey) {
      const item = allKeys.find(k => k.rawKey === prefixedKey);
      if (!item) return;

      document.getElementById('detail-full-key').value = item.rawKey;
      document.getElementById('detail-value').innerText = JSON.stringify(item.value, null, 2);
      document.getElementById('detail-modal').style.display = 'flex';
    }

    function closeDetailModal() {
      document.getElementById('detail-modal').style.display = 'none';
    }

    function openFlushModal() {
      document.getElementById('flush-modal').style.display = 'flex';
    }
    function closeFlushModal() {
      document.getElementById('flush-modal').style.display = 'none';
    }

    async function flushDatabase() {
      const btn = document.getElementById('btn-flush');
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Flushing...';
      }

      try {
        const res = await fetch('/api/flush', { method: 'POST' });
        if (res.ok) {
          showToast('Database flushed successfully');
          closeFlushModal();
          loadKeys();
        } else {
          showToast('Failed to flush database', true);
        }
      } catch (err) {
        showToast('Server error during flush', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    }

    function logout(btn) {
      let originalHtml = '';
      if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width: 0.75rem; height: 0.75rem; border-width: 1.5px;"></span> Logging out...';
      }
      var xmlhttp = new XMLHttpRequest();
      xmlhttp.open("POST", "/api/logout", true);
      xmlhttp.send();
      xmlhttp.onreadystatechange = function() {
        if (xmlhttp.readyState === 4) {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
          }
          window.location.reload();
        }
      }
    }

    function openCreateSubaccountForm() {
      document.getElementById('sub-new-username').value = '';
      document.getElementById('sub-new-password').value = '';
      document.getElementById('sub-new-role').value = 'junior';
      document.getElementById('sub-admin-password').value = '';
      document.getElementById('subaccount-form-container').style.display = 'block';
    }

    function closeCreateSubaccountForm() {
      document.getElementById('subaccount-form-container').style.display = 'none';
    }

    async function createSubaccount() {
      const username = document.getElementById('sub-new-username').value.trim();
      const password = document.getElementById('sub-new-password').value;
      const role = document.getElementById('sub-new-role').value;
      const adminPassword = document.getElementById('sub-admin-password').value;

      if (!username || !password || !adminPassword) {
        showToast('All fields are required', true);
        return;
      }

      const btn = document.getElementById('btn-save-subaccount');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Creating...';

      try {
        const res = await fetch('/api/subaccounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, role, adminPassword })
        });
        if (res.ok) {
          showToast('Sub-account created successfully');
          closeCreateSubaccountForm();
          loadSubaccounts();
        } else {
          const text = await res.text();
          showToast(text || 'Failed to create sub-account', true);
        }
      } catch (err) {
        showToast('Server error during creation', true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Create Account';
      }
    }

    async function loadSubaccounts() {
      const tbody = document.getElementById('subaccounts-table-body');
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><span class="spinner"></span> Loading sub-accounts...</td></tr>';

      try {
        const res = await fetch('/api/subaccounts');
        if (res.status === 403) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #f87171; padding: 2rem;">Access Denied (Only Admins can view/manage sub-accounts)</td></tr>';
          return;
        }
        if (res.ok) {
          const list = await res.json();
          if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">No sub-accounts registered.</td></tr>';
            return;
          }
          tbody.innerHTML = '';
          list.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`
              <td style="color: white; font-weight: 500;">\${escapeHtml(item.username)}</td>
              <td><span style="background-color: \${item.role === 'senior' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(234, 179, 8, 0.1)'}; color: \${item.role === 'senior' ? '#60a5fa' : '#facc15'}; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; font-weight: 500;">\${item.role}</span></td>
              <td style="color: var(--text-muted); font-size: 0.85rem;">\${item.createdAt}</td>
              <td>
                <button class="btn btn-secondary" onclick="deleteSubaccount('\${item.username}', this)" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; background-color: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">
                  Delete
                </button>
              </td>
            \`;
            tbody.appendChild(tr);
          });
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Failed to load sub-accounts.</td></tr>';
        }
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Server error loading sub-accounts.</td></tr>';
      }
    }

    async function deleteSubaccount(subUsername, btn) {
      const adminPassword = prompt(\`Enter Admin Password to delete sub-account "\${subUsername}":\`);
      if (adminPassword === null) return;
      if (!adminPassword) {
        showToast('Admin password is required to verify', true);
        return;
      }

      btn.disabled = true;
      btn.innerHTML = 'Deleting...';

      try {
        const res = await fetch('/api/subaccounts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: subUsername, adminPassword })
        });
        if (res.ok) {
          showToast('Sub-account deleted');
          loadSubaccounts();
        } else {
          const text = await res.text();
          showToast(text || 'Failed to delete sub-account', true);
        }
      } catch (err) {
        showToast('Server error during deletion', true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Delete';
      }
    }

    // Load keys on start
    window.onload = function() {
      loadKeys();
      if (userRole === 'junior') {
        const addBtn = document.querySelector('button[onclick="openAddModal()"]');
        if (addBtn) addBtn.style.display = 'none';
        
        const flushBtn = document.querySelector('button[onclick="openFlushModal()"]');
        if (flushBtn) flushBtn.style.display = 'none';

        const serverAddSection = document.querySelector('#allowed-servers-section .toolbar div');
        if (serverAddSection) serverAddSection.style.display = 'none';
      } else if (userRole === 'senior') {
        const flushBtn = document.querySelector('button[onclick="openFlushModal()"]');
        if (flushBtn) flushBtn.style.display = 'none';
      }
    };
  </script>
</body>
</html>`;
}
function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - SSDiskDB Insights</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0f172a;
      --card-bg: rgba(30, 41, 59, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-blue: #3b82f6;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --font-family: 'Inter', -apple-system, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: var(--font-family);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      position: relative;
    }

    /* Glow Orbs in Background */
    .glow-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(100px);
      opacity: 0.15;
      pointer-events: none;
      z-index: 0;
    }
    .orb-1 {
      width: 350px;
      height: 350px;
      background: var(--accent-blue);
      top: 15%;
      left: 15%;
      animation: float1 15s infinite alternate ease-in-out;
    }
    .orb-2 {
      width: 400px;
      height: 400px;
      background: var(--accent-green);
      bottom: 15%;
      right: 15%;
      animation: float2 18s infinite alternate ease-in-out;
    }

    @keyframes float1 {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(50px, -30px) scale(1.15); }
    }
    @keyframes float2 {
      0% { transform: translate(0, 0) scale(1.1); }
      100% { transform: translate(-60px, 40px) scale(0.9); }
    }

    /* Login Card Container */
    .login-container {
      width: 100%;
      max-width: 440px;
      padding: 1.5rem;
      z-index: 10;
    }

    .login-card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 1.25rem;
      padding: 2.5rem;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes slideUp {
      from {
        transform: translateY(40px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .header {
      text-align: center;
      margin-bottom: 2rem;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 3.5rem;
      height: 3.5rem;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(16, 185, 129, 0.2));
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 1rem;
      margin-bottom: 1rem;
    }

    .logo svg {
      width: 1.75rem;
      height: 1.75rem;
      fill: none;
      stroke: url(#logo-grad);
      stroke-width: 2;
    }

    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      background: linear-gradient(to right, #60a5fa, #34d399);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    .subtitle {
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    /* Form Fields */
    .form-group {
      margin-bottom: 1.5rem;
      position: relative;
    }

    .form-label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      transition: color 0.2s ease;
    }

    .input-wrapper {
      position: relative;
    }

    .form-input {
      width: 100%;
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.75rem;
      color: var(--text-main);
      padding: 0.8rem 1rem;
      font-size: 0.95rem;
      font-family: inherit;
      outline: none;
      transition: all 0.2s ease;
    }

    .form-input:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      background: rgba(15, 23, 42, 0.8);
    }

    .form-group:focus-within .form-label {
      color: var(--accent-blue);
    }

    /* Error Message Alert */
    .error-box {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #fca5a5;
      padding: 0.8rem 1rem;
      border-radius: 0.75rem;
      font-size: 0.85rem;
      margin-bottom: 1.5rem;
      display: none;
      align-items: center;
      gap: 0.5rem;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Button */
    .btn-submit {
      width: 100%;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
      color: white;
      font-weight: 600;
      padding: 0.85rem;
      border-radius: 0.75rem;
      border: none;
      cursor: pointer;
      font-size: 0.95rem;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .btn-submit:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(59, 130, 246, 0.3);
      filter: brightness(1.05);
    }

    .btn-submit:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 1.25rem;
      height: 1.25rem;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Footer branding */
    .footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.8rem;
      color: rgba(255, 255, 255, 0.3);
    }

    .tabs-container {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 0.5rem;
    }

    .tab-btn {
      flex: 1;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      padding: 0.5rem;
      border-radius: 0.375rem;
      transition: all 0.2s ease;
      text-align: center;
    }

    .tab-btn.active {
      color: white;
      background-color: var(--accent-blue);
    }
  </style>
</head>
<body>
  <!-- Glow effects -->
  <div class="glow-orb orb-1"></div>
  <div class="glow-orb orb-2"></div>

  <svg style="position: absolute; width: 0; height: 0;" width="0" height="0">
    <defs>
      <linearGradient id="logo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#60a5fa" />
        <stop offset="100%" stop-color="#34d399" />
      </linearGradient>
    </defs>
  </svg>

  <div class="login-container">
    <div class="login-card">
      <div class="header">
        <div class="logo">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0v3.75" />
          </svg>
        </div>
        <h1>SSDiskDB Insights</h1>
        <p class="subtitle">Enter credentials to manage your database</p>
      </div>

      <div class="tabs-container">
        <button type="button" class="tab-btn active" id="tab-btn-local" onclick="switchLoginTab('local')">Local Database</button>
        <button type="button" class="tab-btn" id="tab-btn-remote" onclick="switchLoginTab('remote')">Remote Connection</button>
      </div>

      <div class="error-box" id="error-box">
        <svg style="width: 1.25rem; height: 1.25rem; flex-shrink: 0;" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
        </svg>
        <span id="error-message"></span>
      </div>

      <form id="login-form" onsubmit="handleLogin(event)">
        <!-- Local Fields -->
        <div id="local-fields">
          <div class="form-group">
            <label class="form-label" for="username">Username</label>
            <div class="input-wrapper">
              <input class="form-input" type="text" id="username" required autocomplete="username" placeholder="e.g. admin">
            </div>
          </div>

          <div class="form-group" style="margin-bottom: 2rem;">
            <label class="form-label" for="password">Password</label>
            <div class="input-wrapper">
              <input class="form-input" type="password" id="password" required autocomplete="current-password" placeholder="••••••••">
            </div>
          </div>
        </div>

        <!-- Remote Fields -->
        <div id="remote-fields" style="display: none;">
          <div class="form-group" style="margin-bottom: 2rem;">
            <label class="form-label" for="connection-uri">Connection URI</label>
            <div class="input-wrapper">
              <input class="form-input" type="text" id="connection-uri" placeholder="ssdiskdb://apiKey@host:port/serverId">
            </div>
          </div>
        </div>

        <button class="btn-submit" type="submit" id="btn-submit">
          <span>Sign In</span>
        </button>
      </form>
    </div>
    <div class="footer">
      SSDiskDB &copy; 2026. Inspired by SSDB & LevelDB.
    </div>
  </div>

  <script>
    let loginMode = 'local';

    function switchLoginTab(mode) {
      loginMode = mode;
      const btnLocal = document.getElementById('tab-btn-local');
      const btnRemote = document.getElementById('tab-btn-remote');
      const localFields = document.getElementById('local-fields');
      const remoteFields = document.getElementById('remote-fields');
      const errorBox = document.getElementById('error-box');

      errorBox.style.display = 'none';

      if (mode === 'local') {
        btnLocal.classList.add('active');
        btnRemote.classList.remove('active');
        localFields.style.display = 'block';
        remoteFields.style.display = 'none';
        document.getElementById('username').required = true;
        document.getElementById('password').required = true;
        document.getElementById('connection-uri').required = false;
      } else {
        btnLocal.classList.remove('active');
        btnRemote.classList.add('active');
        localFields.style.display = 'none';
        remoteFields.style.display = 'block';
        document.getElementById('username').required = false;
        document.getElementById('password').required = false;
        document.getElementById('connection-uri').required = true;
      }
    }

    async function handleLogin(event) {
      event.preventDefault();
      const userEl = document.getElementById('username');
      const passEl = document.getElementById('password');
      const uriEl = document.getElementById('connection-uri');
      const submitBtn = document.getElementById('btn-submit');
      const errorBox = document.getElementById('error-box');
      const errorMsg = document.getElementById('error-message');

      errorBox.style.display = 'none';

      const payload = { type: loginMode };
      if (loginMode === 'local') {
        const username = userEl.value.trim();
        const password = passEl.value;
        if (!username || !password) return;
        payload.username = username;
        payload.password = password;
      } else {
        const connectionUri = uriEl.value.trim();
        if (!connectionUri) return;
        payload.connectionUri = connectionUri;
      }

      submitBtn.disabled = true;
      const originalText = submitBtn.innerHTML;
      submitBtn.innerHTML = '<span class="spinner"></span>';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          window.location.href = '/';
        } else {
          let errorText = 'Invalid username or password';
          try {
            const data = await response.json();
            if (data && data.error) errorText = data.error;
          } catch(e) {}
          
          errorMsg.textContent = errorText;
          errorBox.style.display = 'flex';
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalText;
        }
      } catch (err) {
        errorMsg.textContent = 'Server connection failed';
        errorBox.style.display = 'flex';
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
      }
    }
  </script>
</body>
</html>`;
}

export function startDashboardServer(
  client: SSDiskDBClient,
  port: number,
  getCredentials: () => Promise<{ username: string; passwordHash: string }>
): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Response compression interception using native Node.js zlib
      const originalWriteHead = res.writeHead;
      const originalEnd = res.end;
      const chunks: Buffer[] = [];
      let capturedStatusCode = 200;
      let capturedHeaders: any = {};

      res.writeHead = function (statusCode: any, reasonOrHeaders?: any, objHeaders?: any) {
        capturedStatusCode = statusCode;
        const headers = objHeaders || reasonOrHeaders;
        if (headers) {
          capturedHeaders = { ...capturedHeaders, ...headers };
        }
        return res;
      } as any;

      res.end = function (chunk?: any, encodingOrCb?: any, cb?: any) {
        let callback = cb;
        if (typeof encodingOrCb === "function") {
          callback = encodingOrCb;
        }

        if (chunk) {
          const buf = typeof chunk === "string" 
            ? Buffer.from(chunk, (typeof encodingOrCb === "string" ? encodingOrCb : "utf8") as any) 
            : chunk;
          chunks.push(buf);
        }

        const bodyBuffer = Buffer.concat(chunks);
        const acceptEncoding = req.headers["accept-encoding"] as string | undefined || "";
        const allHeaders = { ...res.getHeaders(), ...capturedHeaders };
        
        // Normalize headers to check compressibility
        const normalizedHeaders: Record<string, string> = {};
        for (const k of Object.keys(allHeaders)) {
          normalizedHeaders[k.toLowerCase()] = String(allHeaders[k]);
        }

        const contentType = normalizedHeaders["content-type"] || "";
        const isCompressible = contentType.includes("json") || 
                              contentType.includes("html") || 
                              contentType.includes("text") || 
                              contentType.includes("javascript") || 
                              contentType.includes("css");

        if (bodyBuffer.length < 1024 || !isCompressible || normalizedHeaders["content-encoding"]) {
          originalWriteHead.call(res, capturedStatusCode, allHeaders);
          return originalEnd.call(res, bodyBuffer, callback);
        }

        // Apply compression: Brotli > Gzip > Deflate
        if (acceptEncoding.includes("br") && typeof zlib.brotliCompress === "function") {
          zlib.brotliCompress(bodyBuffer, (err, compressed) => {
            if (err) {
              originalWriteHead.call(res, capturedStatusCode, allHeaders);
              return originalEnd.call(res, bodyBuffer, callback);
            }
            delete allHeaders["content-length"];
            delete allHeaders["Content-Length"];
            allHeaders["Content-Encoding"] = "br";
            allHeaders["Content-Length"] = String(compressed.length);
            originalWriteHead.call(res, capturedStatusCode, allHeaders);
            return originalEnd.call(res, compressed, callback);
          });
        } else if (acceptEncoding.includes("gzip")) {
          zlib.gzip(bodyBuffer, (err, compressed) => {
            if (err) {
              originalWriteHead.call(res, capturedStatusCode, allHeaders);
              return originalEnd.call(res, bodyBuffer, callback);
            }
            delete allHeaders["content-length"];
            delete allHeaders["Content-Length"];
            allHeaders["Content-Encoding"] = "gzip";
            allHeaders["Content-Length"] = String(compressed.length);
            originalWriteHead.call(res, capturedStatusCode, allHeaders);
            return originalEnd.call(res, compressed, callback);
          });
        } else if (acceptEncoding.includes("deflate")) {
          zlib.deflate(bodyBuffer, (err, compressed) => {
            if (err) {
              originalWriteHead.call(res, capturedStatusCode, allHeaders);
              return originalEnd.call(res, bodyBuffer, callback);
            }
            delete allHeaders["content-length"];
            delete allHeaders["Content-Length"];
            allHeaders["Content-Encoding"] = "deflate";
            allHeaders["Content-Length"] = String(compressed.length);
            originalWriteHead.call(res, capturedStatusCode, allHeaders);
            return originalEnd.call(res, compressed, callback);
          });
        } else {
          originalWriteHead.call(res, capturedStatusCode, allHeaders);
          return originalEnd.call(res, bodyBuffer, callback);
        }
        return res;
      } as any;

      const url = req.url || "/";
      const method = req.method || "GET";

      // 1. Check if it's a remote client API request
      const isClientApi = ["/api/handshake", "/api/heartbeat", "/api/rpc"].includes(url);

      let authenticated = false;
      let userRole = "";
      let reqUsername = "";

      if (!isClientApi) {
        // If it's a dedicated remote client console, auto-authenticate
        const isDedicatedRemote = (client as any).remoteUrl !== undefined;
        if (isDedicatedRemote) {
          authenticated = true;
          userRole = "admin";
          reqUsername = "admin";
        } else {
          // 1. Extract and check session cookie
          const cookies = parseCookies(req.headers.cookie);
          const sessionToken = cookies.session;
          if (sessionToken && sessions.has(sessionToken)) {
            const sessionData = sessions.get(sessionToken)!;
            if (Date.now() < sessionData.expiresAt) {
              authenticated = true;
              userRole = sessionData.userRole;
              reqUsername = sessionData.username;
            } else {
              sessions.delete(sessionToken);
            }
          }

          // 2. Fallback: Check Basic Auth proactively (helpful for programmatic scripts / retrocompatibility)
          if (!authenticated && req.headers.authorization && req.headers.authorization.startsWith("Basic ")) {
            try {
              const token = req.headers.authorization.substring(6);
              const decoded = Buffer.from(token, "base64").toString("utf8");
              const parts = decoded.split(":");
              const basicUser = parts[0];
              const basicPass = parts[1] || "";
              const storedCreds = await getCredentials();
              const inputHash = crypto.createHash("sha256").update(basicPass).digest("hex");

              if (basicUser === storedCreds.username && inputHash === storedCreds.passwordHash) {
                authenticated = true;
                userRole = "admin";
                reqUsername = basicUser;
              } else {
                const db = (client as any).db;
                const subRaw = await db.get("config:subaccount:" + basicUser);
                if (subRaw) {
                  const subData = JSON.parse(subRaw);
                  if (inputHash === subData.passwordHash) {
                    authenticated = true;
                    userRole = subData.role || "junior";
                    reqUsername = basicUser;
                  }
                }
              }
            } catch (e) {}
          }
        }

        // Handle unauthenticated requests
        if (!authenticated) {
          if (url === "/api/login" && method === "POST") {
            // Allow login endpoint to proceed
          } else if (url === "/api/logout") {
            // Allow logout endpoint to proceed
          } else if (url.startsWith("/api/")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          } else {
            res.writeHead(401, { "Content-Type": "text/html" });
            res.end(getLoginHtml());
            return;
          }
        }

        // Store user details on request
        if (authenticated) {
          (req as any).userRole = userRole;
          (req as any).username = reqUsername;
        }
      }

      // Serve UI
      if (url === "/" || url === "/index.html") {
        const isDedicatedRemote = (client as any).remoteUrl !== undefined;
        if (isDedicatedRemote) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(getDashboardHtml("admin", "admin", "remote", `${(client as any).serverId} @ ${(client as any).remoteUrl}`));
          return;
        }

        // If it's a session-based remote connection
        const cookies = parseCookies(req.headers.cookie);
        const sessionData = cookies.session ? sessions.get(cookies.session) : null;
        if (sessionData && sessionData.connectionUri) {
          let remoteDisplay = sessionData.connectionUri;
          try {
            const parsedUri = new URL(sessionData.connectionUri);
            remoteDisplay = `${parsedUri.pathname.substring(1)} @ ${parsedUri.host}`;
          } catch(e){}
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(getDashboardHtml(sessionData.username, "admin", "remote", remoteDisplay));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getDashboardHtml((req as any).username, (req as any).userRole, "local"));
        return;
      }

      // API: Login
      if (url === "/api/login" && method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const loginType = payload.type || "local";

            if (loginType === "remote") {
              const connectionUri = payload.connectionUri;
              if (!connectionUri) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Connection URI is required" }));
                return;
              }
              // Verify connection
              try {
                const testClient = await connect(connectionUri);
                await testClient.close();
              } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Connection failed: ${err.message}` }));
                return;
              }

              // Extract serverId/host for display user
              let displayUser = "remote-server";
              try {
                const parsedUri = new URL(connectionUri);
                displayUser = parsedUri.pathname.substring(1) || "remote-server";
              } catch(e){}

              const sessionId = crypto.randomBytes(32).toString("hex");
              sessions.set(sessionId, {
                username: displayUser,
                userRole: "admin",
                expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
                connectionUri: connectionUri
              });
              res.writeHead(200, {
                "Set-Cookie": `session=${sessionId}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
                "Content-Type": "application/json"
              });
              res.end(JSON.stringify({ status: "ok", role: "admin", username: displayUser }));
              return;
            }

            const loginUsername = payload.username;
            const loginPassword = payload.password;
            if (!loginUsername || !loginPassword) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Username and password are required" }));
              return;
            }

            const storedCreds = await getCredentials();
            const inputHash = crypto.createHash("sha256").update(loginPassword).digest("hex");

            let targetRole = "admin";
            let isAuth = false;

            if (loginUsername === storedCreds.username && inputHash === storedCreds.passwordHash) {
              isAuth = true;
              targetRole = "admin";
            } else {
              // Check sub-accounts
              try {
                const db = (client as any).db;
                const subRaw = await db.get("config:subaccount:" + loginUsername);
                if (subRaw) {
                  const subData = JSON.parse(subRaw);
                  if (inputHash === subData.passwordHash) {
                    isAuth = true;
                    targetRole = subData.role || "junior";
                  }
                }
              } catch (e) {}
            }

            if (isAuth) {
              const sessionId = crypto.randomBytes(32).toString("hex");
              sessions.set(sessionId, {
                username: loginUsername,
                userRole: targetRole,
                expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
              });
              res.writeHead(200, {
                "Set-Cookie": `session=${sessionId}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
                "Content-Type": "application/json"
              });
              res.end(JSON.stringify({ status: "ok", role: targetRole, username: loginUsername }));
            } else {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid username or password" }));
            }
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad Request: " + e.message }));
          }
        });
        return;
      }

      // Health check endpoint (used by Docker HEALTHCHECK and load balancers).
      // Bypasses authentication: it only reports whether the server is alive.
      if (url === "/health" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "ssdiskdb" }));
        return;
      }

      // API: Logout
      if (url === "/api/logout") {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies.session;
        if (token) {
          const sessionData = sessions.get(token);
          if (sessionData && sessionData.connectionUri) {
            const rClient = remoteClients.get(sessionData.connectionUri);
            if (rClient) {
              rClient.close().catch(() => {});
              remoteClients.delete(sessionData.connectionUri);
            }
          }
          sessions.delete(token);
        }
        if (method === "GET") {
          res.writeHead(302, {
            "Set-Cookie": "session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0",
            "Location": "/"
          });
          res.end();
        } else {
          res.writeHead(200, {
            "Set-Cookie": "session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0",
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({ status: "ok" }));
        }
        return;
      }

      // API: Get all keys
      if (url === "/api/keys" && method === "GET") {
        try {
          const cookies = parseCookies(req.headers.cookie);
          const sessionData = sessions.get(cookies.session);
          let currentClient: SSDiskDBClient = client;
          if (sessionData && sessionData.connectionUri) {
            currentClient = await getClientForSession(sessionData, client);
          }

          if (typeof (currentClient as any).getAllKeys === "function") {
            const list = await (currentClient as any).getAllKeys();
            const parsedList = list.map((item: any) => {
              const parsed = parseKey(item.key);
              const displayServer = (currentClient as any).serverId && (currentClient as any).serverId !== "Local"
                ? (currentClient as any).serverId
                : parsed.server;
              return {
                type: parsed.type,
                server: displayServer,
                key: parsed.key,
                name: parsed.name || "",
                fullName: parsed.name ? `${parsed.name}:${parsed.key}` : parsed.key,
                rawKey: item.key,
                value: item.value
              };
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(parsedList));
          } else {
            res.writeHead(501, { "Content-Type": "text/plain" });
            res.end("Not implemented for this connection type");
          }
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error fetching keys: " + e.message);
        }
        return;
      }

      // API: Client Handshake
      if (url === "/api/handshake" && method === "GET") {
        const apiKey = req.headers["x-api-key"] as string | undefined;
        const serverId = req.headers["x-server-id"] as string | undefined;
        const clientIp = req.socket.remoteAddress || "";

        const allowed = await validateApiKey(client, clientIp, serverId, apiKey);
        if (!allowed) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid API Key or Server ID");
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", message: "Handshake successful" }));
        return;
      }

      // API: Client Heartbeat
      if (url === "/api/heartbeat" && method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const serverId = payload.serverId;
            const apiKey = req.headers["x-api-key"] as string | undefined;
            const clientIp = req.socket.remoteAddress || "";

            const allowed = await validateApiKey(client, clientIp, serverId, apiKey);
            if (!allowed) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end("Forbidden: Client server not allowed");
              return;
            }

            activeHeartbeats.set(serverId, Date.now());
            if (clientIp) {
              activeHeartbeats.set(clientIp.startsWith("::ffff:") ? clientIp.substring(7) : clientIp, Date.now());
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Client RPC Endpoint
      if (url === "/api/rpc" && method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const { action, args } = payload;
            const serverId = req.headers["x-server-id"] as string | undefined;
            const apiKey = req.headers["x-api-key"] as string | undefined;
            const clientIp = req.socket.remoteAddress || "";

            const allowed = await validateApiKey(client, clientIp, serverId, apiKey);
            if (!allowed) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end("Forbidden: Client server not allowed");
              return;
            }

            // Apply prefix namespacing if serverId is present and is not 'Local'
            if (serverId && serverId !== "Local") {
              if (["set", "get", "del", "exists", "incr", "expire", "ttl", "persist"].includes(action)) {
                args[0] = `client:${serverId}:${args[0]}`;
              } else if (action === "mget" || action === "mdelete") {
                args[0] = args[0].map((key: string) => `client:${serverId}:${key}`);
              } else if (action === "mset") {
                args[0] = args[0].map((entry: any) => Array.isArray(entry)
                  ? [`client:${serverId}:${entry[0]}`, ...entry.slice(1)]
                  : { ...entry, key: `client:${serverId}:${entry.key}` });
              } else if (action === "batch") {
                args[0] = args[0].map((operation: any) => ({
                  ...operation,
                  key: `client:${serverId}:${operation.key}`
                }));
              } else if (action === "scan") {
                const options = args[0] || {};
                options.prefix = `client:${serverId}:${options.prefix || ""}`;
                options.cursor = options.cursor || undefined;
                args[0] = options;
              } else if (["hset", "hget", "hdel"].includes(action)) {
                args[0] = `client:${serverId}:${args[0]}`;
              } else if (["zset", "zget", "zdel"].includes(action)) {
                args[0] = `client:${serverId}:${args[0]}`;
              } else if (action === "flush") {
                const batch = (client as any).db.batch();
                for await (const key of (client as any).db.keys()) {
                  if (
                    key.startsWith(`s:client:${serverId}:`) ||
                    key.startsWith(`h:client:${serverId}:`) ||
                    key.startsWith(`z:client:${serverId}:`)
                  ) {
                    batch.del(key);
                  }
                }
                await batch.write();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ result: true }));
                return;
              } else if (action === "getAllKeys") {
                const list = await client.getAllKeys();
                const filtered = list
                  .filter(item => {
                    return (
                      item.key.startsWith(`s:client:${serverId}:`) ||
                      item.key.startsWith(`h:client:${serverId}:`) ||
                      item.key.startsWith(`z:client:${serverId}:`)
                    );
                  })
                  .map(item => {
                    let cleanKey = item.key;
                    if (item.key.startsWith(`s:client:${serverId}:`)) {
                      cleanKey = "s:" + item.key.substring(`s:client:${serverId}:`.length);
                    } else if (item.key.startsWith(`h:client:${serverId}:`)) {
                      cleanKey = "h:" + item.key.substring(`h:client:${serverId}:`.length);
                    } else if (item.key.startsWith(`z:client:${serverId}:`)) {
                      cleanKey = "z:" + item.key.substring(`z:client:${serverId}:`.length);
                    }
                    return { key: cleanKey, value: item.value };
                  });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ result: filtered }));
                return;
              }
            }

            if (typeof (client as any)[action] === "function") {
              let result = await (client as any)[action](...args);
              if (serverId && serverId !== "Local" && action === "scan") {
                const namespacePrefix = `client:${serverId}:`;
                result = {
                  ...result,
                  entries: result.entries.map((entry: any) => ({
                    ...entry,
                    key: entry.key.startsWith(namespacePrefix) ? entry.key.substring(namespacePrefix.length) : entry.key
                  }))
                };
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ result }));
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end(`Unknown action: ${action}`);
            }
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("RPC Error: " + e.message);
          }
        });
        return;
      }

      // Block remote session connections from accessing or modifying local server configs / sub-accounts
      if (url.startsWith("/api/servers") || url.startsWith("/api/subaccounts")) {
        const cookies = parseCookies(req.headers.cookie);
        const sessionData = cookies.session ? sessions.get(cookies.session) : null;
        if (sessionData && sessionData.connectionUri) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Action not supported on remote server connections");
          return;
        }
      }

      // API: Get Allowed Servers List
      if (url === "/api/servers" && method === "GET") {
        try {
          const db = (client as any).db;
          const allowed: { address: string; status: "Online" | "Offline" | "Blocked"; blocked: boolean; apiKey: string; lastHeartbeat: string }[] = [];
          for await (const [key, val] of db.iterator({ gte: "config:server:", lte: "config:server:\xff" })) {
            const addr = key.substring("config:server:".length);
            const data = JSON.parse(val);
            const lastHb = activeHeartbeats.get(addr);
            const isOnline = lastHb && (Date.now() - lastHb < 30000);
            const isBlocked = data.status === "blocked";

            let status: "Online" | "Offline" | "Blocked" = isOnline ? "Online" : "Offline";
            if (isBlocked) {
              status = "Blocked";
            }

            allowed.push({
              address: addr,
              status,
              blocked: isBlocked,
              apiKey: (req as any).userRole === "admin" ? (data.apiKey || "") : "••••••••",
              lastHeartbeat: lastHb ? new Date(lastHb).toISOString() : "Never"
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(allowed));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error: " + e.message);
        }
        return;
      }

      // API: Add Allowed Server
      if (url === "/api/servers" && method === "POST") {
        if ((req as any).userRole === "junior") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Junior Developers have read-only access");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const address = payload.address;
            if (!address) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Address is required");
              return;
            }
            const db = (client as any).db;
            const apiKey = payload.apiKey || ("ssdb_" + crypto.randomBytes(16).toString("hex"));
            await db.put("config:server:" + address, JSON.stringify({ registeredAt: Date.now(), apiKey, status: "allowed" }));
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Remove Allowed Server
      if (url === "/api/servers" && method === "DELETE") {
        if ((req as any).userRole === "junior") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Junior Developers have read-only access");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const address = payload.address;
            if (!address) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Address is required");
              return;
            }
            const db = (client as any).db;
            await db.del("config:server:" + address);
            activeHeartbeats.delete(address);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Toggle Block/Restrict Server
      if (url === "/api/servers/toggle-block" && method === "POST") {
        if ((req as any).userRole === "junior") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Junior Developers have read-only access");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const address = payload.address;
            if (!address) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Address is required");
              return;
            }
            const db = (client as any).db;
            const raw = await db.get("config:server:" + address);
            if (!raw) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("Server not found");
              return;
            }
            const data = JSON.parse(raw);
            data.status = (data.status === "blocked") ? "allowed" : "blocked";
            await db.put("config:server:" + address, JSON.stringify(data));
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Reissue API Key
      if (url === "/api/servers/reissue-key" && method === "POST") {
        if ((req as any).userRole !== "admin") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Only Administrators can reissue API keys");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const address = payload.address;
            if (!address) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Address is required");
              return;
            }
            const db = (client as any).db;
            const raw = await db.get("config:server:" + address);
            if (!raw) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("Server not found");
              return;
            }
            const data = JSON.parse(raw);
            const newKey = "ssdb_" + crypto.randomBytes(16).toString("hex");
            data.apiKey = newKey;
            await db.put("config:server:" + address, JSON.stringify(data));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ apiKey: newKey }));
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Get Sub-accounts
      if (url === "/api/subaccounts" && method === "GET") {
        if ((req as any).userRole !== "admin") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Admin access only");
          return;
        }
        try {
          const db = (client as any).db;
          const list: { username: string; role: string; createdAt: string }[] = [];
          for await (const [key, val] of db.iterator({ gte: "config:subaccount:", lte: "config:subaccount:\xff" })) {
            const username = key.substring("config:subaccount:".length);
            try {
              const data = JSON.parse(val);
              list.push({
                username,
                role: data.role,
                createdAt: data.createdAt ? new Date(data.createdAt).toISOString() : "Unknown"
              });
            } catch (e) {}
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(list));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error fetching sub-accounts: " + e.message);
        }
        return;
      }

      // API: Create Sub-account
      if (url === "/api/subaccounts" && method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const { username, password, role, adminPassword } = payload;
            if (!username || !password || !role || !adminPassword) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("All fields are required");
              return;
            }

            // Verify admin password
            const storedCreds = await getCredentials();
            const adminHash = crypto.createHash("sha256").update(adminPassword).digest("hex");
            if (adminHash !== storedCreds.passwordHash) {
              res.writeHead(401, { "Content-Type": "text/plain" });
              res.end("Invalid Admin Password. Access Denied.");
              return;
            }

            const db = (client as any).db;
            const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
            await db.put("config:subaccount:" + username, JSON.stringify({
              passwordHash,
              role,
              createdAt: Date.now()
            }));

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Delete Sub-account
      if (url === "/api/subaccounts" && method === "DELETE") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body);
            const { username, adminPassword } = payload;
            if (!username || !adminPassword) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Username and adminPassword are required");
              return;
            }

            // Verify admin password
            const storedCreds = await getCredentials();
            const adminHash = crypto.createHash("sha256").update(adminPassword).digest("hex");
            if (adminHash !== storedCreds.passwordHash) {
              res.writeHead(401, { "Content-Type": "text/plain" });
              res.end("Invalid Admin Password. Access Denied.");
              return;
            }

            const db = (client as any).db;
            await db.del("config:subaccount:" + username);

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error: " + e.message);
          }
        });
        return;
      }

      // API: Save key-value
      if (url === "/api/keys" && method === "POST") {
        if ((req as any).userRole === "junior") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Junior Developers have read-only access");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const cookies = parseCookies(req.headers.cookie);
            const sessionData = cookies.session ? sessions.get(cookies.session) : null;
            let currentClient = client;
            if (sessionData && sessionData.connectionUri) {
              currentClient = await getClientForSession(sessionData, client);
            }

            const payload = JSON.parse(body);
            if (payload.type === "string") {
              await currentClient.set(payload.key, payload.value);
            } else if (payload.type === "hash") {
              await currentClient.hset(payload.name, payload.key, payload.value);
            } else if (payload.type === "zset") {
              await currentClient.zset(payload.name, payload.key, payload.score);
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid type");
              return;
            }
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error saving key: " + e.message);
          }
        });
        return;
      }

      // API: Delete key
      if (url === "/api/keys" && method === "DELETE") {
        if ((req as any).userRole === "junior") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Junior Developers have read-only access");
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const cookies = parseCookies(req.headers.cookie);
            const sessionData = cookies.session ? sessions.get(cookies.session) : null;
            let currentClient = client;
            if (sessionData && sessionData.connectionUri) {
              currentClient = await getClientForSession(sessionData, client);
            }

            const payload = JSON.parse(body);
            const prefixedKey = payload.key as string; // e.g. "s:mykey" or "h:myhash:field"
            if (prefixedKey.startsWith("s:")) {
              await currentClient.del(prefixedKey.substring(2));
            } else if (prefixedKey.startsWith("h:")) {
              const parts = prefixedKey.substring(2).split(":");
              const name = parts[0];
              const key = parts.slice(1).join(":");
              await currentClient.hdel(name, key);
            } else if (prefixedKey.startsWith("z:")) {
              const parts = prefixedKey.substring(2).split(":");
              const name = parts[0];
              const key = parts.slice(1).join(":");
              await currentClient.zdel(name, key);
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid key prefix");
              return;
            }
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error deleting key: " + e.message);
          }
        });
        return;
      }

      // API: Flush database
      if (url === "/api/flush" && method === "POST") {
        if ((req as any).userRole !== "admin") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Only Administrators can flush the database");
          return;
        }
        try {
          const cookies = parseCookies(req.headers.cookie);
          const sessionData = cookies.session ? sessions.get(cookies.session) : null;
          let currentClient = client;
          if (sessionData && sessionData.connectionUri) {
            currentClient = await getClientForSession(sessionData, client);
          }

          if (typeof (currentClient as any).flush === "function") {
            await (currentClient as any).flush();
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } else {
            res.writeHead(501, { "Content-Type": "text/plain" });
            res.end("Not implemented for this connection type");
          }
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error flushing db: " + e.message);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    server.listen(port, () => {
      resolve({
        close: () => {
          return new Promise<void>((res, rej) => {
            server.close(err => {
              if (err) rej(err);
              else res();
            });
          });
        }
      });
    });

    server.on("error", reject);
  });
}
import { Buffer } from "node:buffer";
