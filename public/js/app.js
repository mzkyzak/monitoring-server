// ═══════════════════════════════════════════════════════════════
//  Dashboard App.js — Laptop Server Watchdog
// ═══════════════════════════════════════════════════════════════
'use strict';

let ws;
let realtimeChart;
const MAX_CHART_POINTS = 20;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initChart();
  connectWebSocket();
  fetchProcesses();
  fetchBotInstances();
  loadDbStack();
});

// ─── TABS ────────────────────────────────────────────────────────
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(target).classList.add('active');

      if (target === 'tab-processes') fetchProcesses();
      if (target === 'tab-deployer')  fetchBotInstances();
      if (target === 'tab-database')  loadDbStack();

      // Re-init icons for dynamically rendered content
      setTimeout(() => lucide.createIcons(), 100);
    });
  });
}

// ─── CHART ───────────────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('realtimeChart').getContext('2d');
  const cpuGrad = ctx.createLinearGradient(0, 0, 0, 280);
  cpuGrad.addColorStop(0, 'rgba(0,242,254,0.35)');
  cpuGrad.addColorStop(1, 'rgba(0,242,254,0)');
  const ramGrad = ctx.createLinearGradient(0, 0, 0, 280);
  ramGrad.addColorStop(0, 'rgba(127,0,255,0.35)');
  ramGrad.addColorStop(1, 'rgba(127,0,255,0)');

  realtimeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'CPU %', data: [], borderColor: '#00f2fe', backgroundColor: cpuGrad, borderWidth: 2, fill: true, tension: 0.4, pointRadius: 2 },
        { label: 'RAM %', data: [], borderColor: '#e040fb', backgroundColor: ramGrad, borderWidth: 2, fill: true, tension: 0.4, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#7a8a9a', font: { family: 'JetBrains Mono', size: 10 } } },
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#7a8a9a', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '%' } }
      },
      plugins: { legend: { labels: { color: '#eef2f7', font: { family: 'Outfit', size: 12 } } } }
    }
  });
}

function pushChart(cpu, ram) {
  const t = new Date().toLocaleTimeString('id-ID', { hour12: false });
  if (realtimeChart.data.labels.length >= MAX_CHART_POINTS) {
    realtimeChart.data.labels.shift();
    realtimeChart.data.datasets[0].data.shift();
    realtimeChart.data.datasets[1].data.shift();
  }
  realtimeChart.data.labels.push(t);
  realtimeChart.data.datasets[0].data.push(cpu);
  realtimeChart.data.datasets[1].data.push(ram);
  realtimeChart.update('none');
}

// ─── WEBSOCKET ───────────────────────────────────────────────────
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => appendConsoleLog('info', 'WebSocket terhubung ke server monitoring.', 'SYSTEM');

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'TELEMETRY')    updateMetrics(msg.data);
      if (msg.type === 'LOG')          appendConsoleLog(msg.log.level, msg.log.message, msg.log.source);
      if (msg.type === 'LOGS_INIT')    msg.logs.forEach(l => appendConsoleLog(l.level, l.message, l.source));
      if (msg.type === 'BOTS_UPDATE')  renderBotInstances(msg.bots);
    } catch (_) {}
  };

  ws.onclose = () => {
    appendConsoleLog('warn', 'WebSocket terputus. Reconnect dalam 3 detik...', 'SYSTEM');
    setTimeout(connectWebSocket, 3000);
  };
}

// ─── UPDATE METRIC CARDS ─────────────────────────────────────────
function updateMetrics(d) {
  // Hostname
  document.getElementById('hostname-subtitle').textContent = `${d.os.hostname} — ${d.os.distro}`;
  document.getElementById('uptime-counter').textContent = d.os.uptimeFormatted;

  // CPU
  document.getElementById('cpu-name').textContent = d.cpu.brand;
  document.getElementById('cpu-cores-badge').textContent = d.cpu.cores + ' Cores';
  document.getElementById('cpu-usage-val').textContent = d.cpu.usage;
  document.getElementById('cpu-bar').style.width = d.cpu.usage + '%';
  document.getElementById('cpu-speed-text').textContent = `Speed: ${d.cpu.speed} GHz`;
  const cpuStatus = document.getElementById('cpu-status-indicator');
  if (d.cpu.usage >= 85) {
    cpuStatus.textContent = 'HIGH LOAD ⚠️';
    cpuStatus.className = 'status-indicator-red';
    document.getElementById('cpu-bar').style.background = 'linear-gradient(90deg,#ff5252,#ff1744)';
  } else if (d.cpu.usage >= 65) {
    cpuStatus.textContent = 'Medium';
    cpuStatus.className = 'status-indicator-warn';
    document.getElementById('cpu-bar').style.background = 'linear-gradient(90deg,#ffb300,#ff8f00)';
  } else {
    cpuStatus.textContent = 'Normal ✓';
    cpuStatus.className = 'status-indicator-green';
    document.getElementById('cpu-bar').style.background = 'linear-gradient(90deg,#00f2fe,#4facfe)';
  }

  // RAM
  document.getElementById('ram-breakdown').textContent = `${d.ram.usedGB} / ${d.ram.totalGB} GB`;
  document.getElementById('ram-free-badge').textContent = `${d.ram.freeGB} GB Free`;
  document.getElementById('ram-usage-val').textContent = d.ram.usagePercent;
  document.getElementById('ram-bar').style.width = d.ram.usagePercent + '%';
  document.getElementById('ram-used-text').textContent = `Used: ${d.ram.usedGB} GB`;
  const ramStatus = document.getElementById('ram-status-indicator');
  ramStatus.textContent = d.ram.usagePercent >= 90 ? 'KRITIS ⚠️' : d.ram.usagePercent >= 75 ? 'Tinggi' : 'Normal ✓';
  ramStatus.className = d.ram.usagePercent >= 90 ? 'status-indicator-red' : d.ram.usagePercent >= 75 ? 'status-indicator-warn' : 'status-indicator-green';

  // Disk
  document.getElementById('disk-mount-text').textContent = d.disk.mount;
  document.getElementById('disk-total-badge').textContent = d.disk.totalGB + ' GB';
  document.getElementById('disk-usage-val').textContent = d.disk.usagePercent;
  document.getElementById('disk-bar').style.width = d.disk.usagePercent + '%';
  document.getElementById('disk-used-text').textContent = `Used: ${d.disk.usedGB} GB`;
  const diskStatus = document.getElementById('disk-status-indicator');
  diskStatus.textContent = d.disk.usagePercent >= 90 ? 'PENUH ⚠️' : 'Aman ✓';
  diskStatus.className = d.disk.usagePercent >= 90 ? 'status-indicator-red' : 'status-indicator-green';

  // Battery
  const batt = d.battery;
  document.getElementById('power-source-text').textContent = batt.isCharging ? 'PLN 24/7 (AC)' : 'Baterai Saja!';
  document.getElementById('battery-percent-val').textContent = batt.hasBattery ? batt.percent : '100';
  document.getElementById('battery-bar').style.width = (batt.hasBattery ? batt.percent : 100) + '%';
  const plugBadge = document.getElementById('power-plugged-badge');
  if (batt.isCharging) {
    plugBadge.textContent = '⚡ Plugged In 24/7';
    plugBadge.style.cssText = 'background:rgba(0,230,118,.12); color:#00e676;';
  } else {
    plugBadge.textContent = '🔋 UNPLUGGED!';
    plugBadge.style.cssText = 'background:rgba(255,82,82,.15); color:#ff5252;';
  }

  // Network
  document.getElementById('net-down-val').textContent = d.network.downKbps;
  document.getElementById('net-up-val').textContent = d.network.upKbps;
  document.getElementById('info-os').textContent = `${d.os.distro} ${d.os.release}`;
  document.getElementById('info-net-iface').textContent = d.network.interface;
  document.getElementById('info-local-ip').textContent = d.network.localIp;
  document.getElementById('info-mac').textContent = d.network.mac;
  document.getElementById('info-arch').textContent = d.os.arch;
  const tunnelEl = document.getElementById('info-tunnel-status');
  if (d.tunnel) {
    tunnelEl.textContent = d.tunnel.status === 'ONLINE' ? '🟢 ONLINE' : '🔴 PAUSED';
    tunnelEl.style.color = d.tunnel.status === 'ONLINE' ? 'var(--status-green)' : 'var(--status-red)';
    document.getElementById('remote-domain-text').textContent = `https://${d.tunnel.domain}`;
  }

  pushChart(d.cpu.usage, d.ram.usagePercent);
}

// ─── BOT DEPLOYER ────────────────────────────────────────────────
function updateFileLabel(input) {
  const label = document.getElementById('file-label');
  if (input.files && input.files[0]) {
    label.textContent = `📂 File dipilih: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
    label.style.display = 'block';
  }
}

async function handleBotDeploy(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-deploy');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader"></i> Deploying...';
  lucide.createIcons();

  const form = new FormData();
  form.append('botName',    document.getElementById('deploy-name').value);
  form.append('entryScript',document.getElementById('deploy-entry').value);
  form.append('subdomain',  document.getElementById('deploy-subdomain').value);
  const file = document.getElementById('deploy-file').files[0];
  if (file) form.append('scriptFile', file);

  try {
    const res  = await fetch('/api/bots/deploy', { method: 'POST', body: form });
    const data = await res.json();
    if (data.success) {
      appendConsoleLog('success', `Bot "${data.bot.name}" terdaftar → ${data.bot.cloudflareUrl}`, 'WA_BOT');
      fetchBotInstances();
      document.getElementById('deployBotForm').reset();
      document.getElementById('file-label').style.display = 'none';
      // Switch to deployer tab to show list
      document.querySelector('[data-tab="tab-deployer"]').click();
    } else {
      alert('Gagal deploy: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="rocket"></i> Deploy Bot & Generate Tunnel Link';
    lucide.createIcons();
  }
}

async function fetchBotInstances() {
  try {
    const res  = await fetch('/api/bots');
    const bots = await res.json();
    renderBotInstances(bots);
  } catch (_) {}
}

function renderBotInstances(bots) {
  const container = document.getElementById('bot-instances-list');
  if (!container) return;
  if (!bots || bots.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <i data-lucide="package-open"></i>
      <p>Belum ada bot terdaftar.<br>Upload script bot WA Anda!</p>
    </div>`;
    lucide.createIcons();
    return;
  }
  container.innerHTML = bots.map(bot => `
    <div class="bot-instance-card" id="bot-card-${bot.id}">
      <div class="bot-card-header">
        <div>
          <div class="bot-card-name">${escHtml(bot.name)}</div>
          <div class="bot-port-badge">Port ${bot.port} | PID: ${bot.pid || '—'} | Script: ${escHtml(bot.entryScript)}</div>
        </div>
        <span class="bot-status-badge status-${bot.status}">${bot.status}</span>
      </div>
      <div class="bot-tunnel-link">🌐 <a href="${escHtml(bot.cloudflareUrl)}" target="_blank">${escHtml(bot.cloudflareUrl)}</a></div>
      <div class="bot-mini-log">${(bot.logs && bot.logs[0]) ? escHtml(bot.logs[0]) : '—'}</div>
      <div class="bot-actions">
        ${bot.status === 'RUNNING'
          ? `<button class="btn-stop" onclick="botAction('${bot.id}','stop')">🛑 Stop</button>`
          : `<button class="btn-run"  onclick="botAction('${bot.id}','start')">▶ npm start</button>`}
        <button class="btn-install" onclick="botAction('${bot.id}','npm_install')">📦 npm install</button>
        <button class="btn-del" onclick="botAction('${bot.id}','delete')">🗑 Hapus</button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

async function botAction(id, action) {
  try {
    const res  = await fetch(`/api/bots/${id}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (data.success) fetchBotInstances();
    else alert('Gagal: ' + (data.error || action));
  } catch (err) { alert('Error: ' + err.message); }
}

// ─── PROCESS MANAGER ─────────────────────────────────────────────
async function fetchProcesses() {
  try {
    const res  = await fetch('/api/processes');
    const list = await res.json();
    const tbody = document.getElementById('process-table-body');
    if (!tbody) return;
    tbody.innerHTML = list.map(p => `
      <tr>
        <td>${p.pid}</td>
        <td><strong>${escHtml(p.name)}</strong></td>
        <td style="color: ${parseFloat(p.cpu) > 20 ? 'var(--status-red)' : 'var(--primary-cyan)'}; font-weight:700;">${p.cpu}%</td>
        <td style="color: var(--accent-magenta); font-weight:700;">${p.mem}%</td>
        <td>${escHtml(p.user)}</td>
      </tr>
    `).join('');
  } catch (_) {}
}

// ─── DB STACK GUIDE ───────────────────────────────────────────────
async function loadDbStack() {
  const el = document.getElementById('db-stack-cards');
  const pgEl = document.getElementById('pg-install-cmds');
  if (!el || el.children.length > 0) return;
  try {
    const res  = await fetch('/api/db/stack');
    const data = await res.json();
    el.innerHTML = data.recommended.map(s => `
      <div class="db-stack-card">
        <div class="db-stack-card-header">
          <h4>${escHtml(s.name)}</h4>
          <span class="db-stack-badge" style="background: ${s.color}22; color: ${s.color}; border: 1px solid ${s.color}44;">${s.badge}</span>
        </div>
        <p>${escHtml(s.description)}</p>
        <div class="db-stack-install"><code>${escHtml(s.install).replace(/\n/g,'<br>')}</code></div>
        <div style="margin-top:0.55rem; font-size:0.72rem; color: var(--text-muted);">
          Connection: <span style="font-family:var(--font-mono); color: var(--primary-cyan);">${escHtml(s.connectionString)}</span>
        </div>
      </div>
    `).join('');

    pgEl.innerHTML = `
      <div class="db-install-tab">
        <h5>Windows:</h5>
        <div class="code-box-sm">${escHtml(data.postgresInstall.windows)}</div>
      </div>
      <div class="db-install-tab">
        <h5>Ubuntu Server:</h5>
        <div class="code-box-sm">${escHtml(data.postgresInstall.ubuntu).replace(/\n/g,'<br>')}</div>
      </div>
      <div class="db-install-tab">
        <h5>Docker (paling mudah, isolated):</h5>
        <div class="code-box-sm">${escHtml(data.postgresInstall.docker)}</div>
      </div>
    `;
  } catch (_) {}
}

// ─── CONSOLE LOGS ─────────────────────────────────────────────────
function appendConsoleLog(level, message, source = 'SYSTEM') {
  const box = document.getElementById('console-stream');
  if (!box) return;
  const t = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `<span class="log-time">[${t}]</span><span class="log-source src-${source}">${source}</span><span class="log-msg ${level}">${escHtml(message)}</span>`;
  box.prepend(row);
  if (box.children.length > 80) box.removeChild(box.lastChild);
}

function clearLogs() {
  document.getElementById('console-stream').innerHTML = '';
}

// ─── ALERTS ───────────────────────────────────────────────────────
async function triggerWaAlert() {
  try {
    const res  = await fetch('/api/alerts/test-wa', { method: 'POST' });
    const data = await res.json();
    appendConsoleLog('success', data.message, 'WA_BOT');
    alert('✅ ' + data.message);
  } catch (_) {}
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    const res = await fetch('/api/alerts/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cpuLimit:     document.getElementById('input-cpu-limit').value,
        ramLimit:     document.getElementById('input-ram-limit').value,
        batteryLimit: document.getElementById('input-battery-limit').value,
        alertPhone:   document.getElementById('input-phone').value
      })
    });
    const data = await res.json();
    if (data.success) alert('✅ Pengaturan disimpan!');
  } catch (_) { alert('Gagal menyimpan pengaturan'); }
}

// ─── COPY DOMAIN ──────────────────────────────────────────────────
function copyDomain() {
  const text = document.getElementById('remote-domain-text').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy-domain');
    btn.innerHTML = '<i data-lucide="check"></i>';
    lucide.createIcons();
    setTimeout(() => { btn.innerHTML = '<i data-lucide="copy"></i>'; lucide.createIcons(); }, 1800);
  });
}

// ─── UTILITY ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
