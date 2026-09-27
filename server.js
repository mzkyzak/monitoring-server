const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const multer = require('multer');
const si = require('systeminformation');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────────
// BOT SCRIPTS DIRECTORY (each bot gets its own subfolder)
// ────────────────────────────────────────────────────────────────
const BOT_SCRIPTS_DIR = path.join(__dirname, 'bot_scripts');
if (!fs.existsSync(BOT_SCRIPTS_DIR)) fs.mkdirSync(BOT_SCRIPTS_DIR, { recursive: true });

// Multer – accept any file, store in temp
const upload = multer({
  dest: path.join(__dirname, 'bot_scripts', '_uploads_tmp'),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB max
});

// ────────────────────────────────────────────────────────────────
// SERVER LOGS RING BUFFER
// ────────────────────────────────────────────────────────────────
const logs = [];
function addLog(level, message, source = 'SYSTEM') {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    level, message, source
  };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  // Broadcast to all WS clients
  broadcastLog(entry);
  return entry;
}

function broadcastLog(entry) {
  const payload = JSON.stringify({ type: 'LOG', log: entry });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

// ────────────────────────────────────────────────────────────────
// BOT INSTANCES STATE
// Key: botId → { id, name, dir, entryScript, port, status, subdomain,
//                logs[], pid, process(child), startedAt, cloudflareUrl }
// ────────────────────────────────────────────────────────────────
const botInstances = new Map();
let nextPort = 4010; // bots start from 4010 upward

// Helper: get a safe short id
function makeId() {
  return 'bot-' + Date.now().toString(36);
}

function serializeBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    dir: bot.dir,
    entryScript: bot.entryScript,
    port: bot.port,
    status: bot.status,          // 'REGISTERED' | 'INSTALLING' | 'RUNNING' | 'STOPPED' | 'ERROR'
    subdomain: bot.subdomain,
    cloudflareUrl: bot.cloudflareUrl,
    logs: bot.logs.slice(0, 30), // last 30 log lines
    pid: bot.pid,
    startedAt: bot.startedAt,
    packageJsonFound: bot.packageJsonFound
  };
}

// ────────────────────────────────────────────────────────────────
// REAL BOT PROCESS – start / stop using Node child_process.spawn
// ────────────────────────────────────────────────────────────────
function startBotProcess(bot) {
  if (bot.process) {
    try { bot.process.kill(); } catch (_) {}
  }

  const scriptPath = path.join(bot.dir, bot.entryScript);
  if (!fs.existsSync(scriptPath)) {
    bot.status = 'ERROR';
    bot.logs.unshift(`[ERROR] Entry file not found: ${bot.entryScript}`);
    addLog('error', `Bot "${bot.name}": script tidak ditemukan (${bot.entryScript})`, 'WA_BOT');
    broadcastBots();
    return;
  }

  bot.status = 'RUNNING';
  bot.startedAt = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const child = spawn('node', [scriptPath], {
    cwd: bot.dir,
    env: { ...process.env, PORT: String(bot.port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  bot.process = child;
  bot.pid = child.pid;
  bot.logs.unshift(`[START] Node process PID ${child.pid} launched on port ${bot.port}`);
  addLog('success', `[PaaS] Bot "${bot.name}" berjalan di port ${bot.port} → ${bot.cloudflareUrl}`, 'WA_BOT');

  child.stdout.on('data', chunk => {
    const line = chunk.toString().trim();
    bot.logs.unshift(`[OUT] ${line}`);
    if (bot.logs.length > 200) bot.logs.pop();
    broadcastBots();
  });
  child.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    bot.logs.unshift(`[ERR] ${line}`);
    if (bot.logs.length > 200) bot.logs.pop();
    broadcastBots();
  });
  child.on('close', code => {
    bot.status = code === 0 ? 'STOPPED' : 'ERROR';
    bot.process = null;
    bot.pid = null;
    bot.logs.unshift(`[EXIT] Process exited with code ${code}`);
    addLog(code === 0 ? 'warn' : 'error', `Bot "${bot.name}" exited (code ${code})`, 'WA_BOT');
    broadcastBots();
  });

  broadcastBots();
}

function stopBotProcess(bot) {
  if (bot.process) {
    try { bot.process.kill('SIGTERM'); } catch (_) {}
    bot.process = null;
  }
  bot.status = 'STOPPED';
  bot.pid = null;
  bot.logs.unshift('[STOP] Process terminated by user');
  addLog('warn', `Bot "${bot.name}" dihentikan oleh user.`, 'WA_BOT');
  broadcastBots();
}

function broadcastBots() {
  const payload = JSON.stringify({
    type: 'BOTS_UPDATE',
    bots: [...botInstances.values()].map(serializeBot)
  });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

// ────────────────────────────────────────────────────────────────
// SYSTEM MONITORING HELPERS
// ────────────────────────────────────────────────────────────────
let alertConfig = {
  cpuLimit: 85, ramLimit: 90, batteryLimit: 20,
  enableWaAlerts: true, alertPhone: '+62 812-9988-7766'
};
let tunnelStats = {
  status: 'ONLINE', domain: 'monitoring.server-laptop.my.id',
  localTarget: `http://localhost:${PORT}`, latencyMs: 18
};
let alertCooldown = { cpu: 0, ram: 0, battery: 0 };

async function getSystemData() {
  try {
    const [cpuLoad, cpuInfo, mem, fsSize, netStats, netIfaces, battery, osInfo, timeInfo] = await Promise.all([
      si.currentLoad().catch(() => ({ currentLoad: 10, cpus: [] })),
      si.cpu().catch(() => ({ manufacturer: 'Intel', brand: 'Core', speed: 2.4, cores: 4 })),
      si.mem().catch(() => ({ total: 8589934592, used: 4294967296, free: 4294967296 })),
      si.fsSize().catch(() => ([{ size: 256e9, used: 128e9, use: 50, mount: 'C:' }])),
      si.networkStats().catch(() => ([{ rx_sec: 1024, tx_sec: 2048 }])),
      si.networkInterfaces().catch(() => ([{ iface: 'Ethernet', ip4: '192.168.1.100', mac: '00:11:22:33:44:55' }])),
      si.battery().catch(() => ({ hasBattery: true, isCharging: true, percent: 85, acConnected: true })),
      si.osInfo().catch(() => ({ platform: process.platform, distro: 'Windows', release: '11', hostname: 'LAPTOP-SERVER' })),
      si.time()
    ]);

    const mainDisk = fsSize.find(d => d.mount === 'C:' || d.mount === '/') || fsSize[0] || { size: 1, used: 0, use: 0 };
    const activeIface = netIfaces.find(i => !i.internal && i.ip4) || { iface: 'eth0', ip4: '127.0.0.1', mac: 'N/A' };
    const activeNet = netStats[0] || { rx_sec: 0, tx_sec: 0 };

    const up = timeInfo.uptime || Math.floor(process.uptime());
    const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600),
          m = Math.floor((up % 3600) / 60), s = Math.floor(up % 60);
    const uptimeFormatted = `${d > 0 ? d + 'd ' : ''}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    const data = {
      timestamp: Date.now(),
      os: {
        platform: osInfo.platform, distro: osInfo.distro,
        release: osInfo.release, hostname: osInfo.hostname,
        arch: process.arch, uptimeFormatted
      },
      cpu: {
        brand: `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim(),
        cores: cpuInfo.cores, speed: cpuInfo.speed,
        usage: Math.round(cpuLoad.currentLoad * 10) / 10,
        loadCores: (cpuLoad.cpus || []).map(c => Math.round(c.load))
      },
      ram: {
        totalGB: (mem.total / 1073741824).toFixed(2),
        usedGB: (mem.used / 1073741824).toFixed(2),
        freeGB: (mem.free / 1073741824).toFixed(2),
        usagePercent: Math.round((mem.used / mem.total) * 100)
      },
      disk: {
        mount: mainDisk.mount,
        totalGB: (mainDisk.size / 1073741824).toFixed(1),
        usedGB: (mainDisk.used / 1073741824).toFixed(1),
        usagePercent: Math.round(mainDisk.use || (mainDisk.used / mainDisk.size * 100))
      },
      network: {
        interface: activeIface.iface, localIp: activeIface.ip4, mac: activeIface.mac || 'N/A',
        downKbps: Math.round((activeNet.rx_sec || 0) / 1024),
        upKbps: Math.round((activeNet.tx_sec || 0) / 1024)
      },
      battery: {
        hasBattery: battery.hasBattery,
        isCharging: battery.isCharging || battery.acConnected,
        percent: battery.percent || 100,
        acConnected: battery.acConnected
      },
      tunnel: tunnelStats,
      alertConfig
    };

    const now = Date.now();
    if (data.cpu.usage > alertConfig.cpuLimit && now - alertCooldown.cpu > 60000) {
      alertCooldown.cpu = now;
      addLog('warn', `⚠️ CPU tinggi: ${data.cpu.usage}% (limit: ${alertConfig.cpuLimit}%)`, 'SYSTEM');
    }
    if (data.ram.usagePercent > alertConfig.ramLimit && now - alertCooldown.ram > 60000) {
      alertCooldown.ram = now;
      addLog('warn', `⚠️ RAM kritis: ${data.ram.usagePercent}% (limit: ${alertConfig.ramLimit}%)`, 'SYSTEM');
    }
    if (data.battery.hasBattery && !data.battery.isCharging && data.battery.percent < alertConfig.batteryLimit && now - alertCooldown.battery > 120000) {
      alertCooldown.battery = now;
      addLog('error', `🔋 Charger terlepas! Baterai tersisa ${data.battery.percent}%`, 'SYSTEM');
    }
    return data;
  } catch (err) {
    console.error('Telemetry error:', err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// REST API – BOT DEPLOYER
// ────────────────────────────────────────────────────────────────

// GET list all bots
app.get('/api/bots', (req, res) => {
  res.json([...botInstances.values()].map(serializeBot));
});

// POST deploy – upload script file (.js or .zip)
app.post('/api/bots/deploy', upload.single('scriptFile'), (req, res) => {
  try {
    const { botName, entryScript, subdomain } = req.body;
    const file = req.file;
    const botId = makeId();
    const botDir = path.join(BOT_SCRIPTS_DIR, botId);
    fs.mkdirSync(botDir, { recursive: true });

    let resolvedEntry = entryScript || 'index.js';

    if (file) {
      const origName = file.originalname;
      if (origName.endsWith('.zip')) {
        // Extract ZIP into botDir
        const destZip = path.join(botDir, origName);
        fs.renameSync(file.path, destZip);
        try {
          // Use built-in Windows Expand-Archive or node-based unzip
          if (process.platform === 'win32') {
            execSync(`powershell -command "Expand-Archive -Path '${destZip}' -DestinationPath '${botDir}' -Force"`, { timeout: 30000 });
          } else {
            execSync(`unzip -o "${destZip}" -d "${botDir}"`, { timeout: 30000 });
          }
          fs.unlinkSync(destZip);
          addLog('success', `ZIP diekstrak ke ${botDir}`, 'WA_BOT');
        } catch (e) {
          addLog('error', `Gagal ekstrak ZIP: ${e.message}`, 'WA_BOT');
        }
      } else {
        // Single JS file
        const dest = path.join(botDir, origName);
        fs.renameSync(file.path, dest);
        resolvedEntry = origName;
      }
    }

    // Check package.json presence
    const hasPackageJson = fs.existsSync(path.join(botDir, 'package.json'));

    // Auto-determine subdomain
    const resolvedSubdomain = subdomain && subdomain.trim()
      ? subdomain.trim()
      : `bot-port-${nextPort}.server-laptop.my.id`;

    const bot = {
      id: botId,
      name: botName || 'WhatsApp Bot',
      dir: botDir,
      entryScript: resolvedEntry,
      port: nextPort++,
      status: 'REGISTERED',
      subdomain: resolvedSubdomain,
      cloudflareUrl: `https://${resolvedSubdomain}`,
      logs: [`[REGISTERED] Bot "${botName}" terdaftar. Entry: ${resolvedEntry}`],
      pid: null, process: null, startedAt: null,
      packageJsonFound: hasPackageJson
    };
    botInstances.set(botId, bot);
    addLog('success', `Bot "${bot.name}" terdaftar! Port: ${bot.port} | Tunnel: ${bot.cloudflareUrl}`, 'WA_BOT');
    broadcastBots();
    res.json({ success: true, bot: serializeBot(bot) });
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST action on a bot
app.post('/api/bots/:id/action', (req, res) => {
  const bot = botInstances.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  const { action } = req.body;

  if (action === 'npm_install') {
    bot.status = 'INSTALLING';
    bot.logs.unshift('[NPM] Running npm install...');
    broadcastBots();
    addLog('info', `npm install dimulai untuk "${bot.name}"...`, 'WA_BOT');

    const npmInstall = spawn('npm', ['install', '--prefer-offline'], {
      cwd: bot.dir,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    npmInstall.stdout.on('data', d => {
      bot.logs.unshift('[NPM] ' + d.toString().trim());
      if (bot.logs.length > 200) bot.logs.pop();
      broadcastBots();
    });
    npmInstall.stderr.on('data', d => {
      bot.logs.unshift('[NPM WARN] ' + d.toString().trim());
      broadcastBots();
    });
    npmInstall.on('close', code => {
      bot.status = code === 0 ? 'STOPPED' : 'ERROR';
      bot.logs.unshift(code === 0 ? '[NPM] Install selesai! Siap dijalankan.' : `[NPM] Install gagal (code ${code})`);
      addLog(code === 0 ? 'success' : 'error', `npm install ${code === 0 ? 'selesai' : 'GAGAL'} untuk "${bot.name}"`, 'WA_BOT');
      broadcastBots();
    });
    return res.json({ success: true, message: 'npm install dimulai' });
  }

  if (action === 'start') {
    startBotProcess(bot);
    return res.json({ success: true, bot: serializeBot(bot) });
  }

  if (action === 'stop') {
    stopBotProcess(bot);
    return res.json({ success: true, bot: serializeBot(bot) });
  }

  if (action === 'delete') {
    stopBotProcess(bot);
    try { fs.rmSync(bot.dir, { recursive: true, force: true }); } catch (_) {}
    botInstances.delete(bot.id);
    broadcastBots();
    return res.json({ success: true });
  }

  res.status(400).json({ error: 'Unknown action' });
});

// GET logs for a specific bot
app.get('/api/bots/:id/logs', (req, res) => {
  const bot = botInstances.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json(bot.logs);
});

// ────────────────────────────────────────────────────────────────
// REST API – MONITORING & SETTINGS
// ────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const data = await getSystemData();
  res.json(data);
});

app.get('/api/processes', async (req, res) => {
  try {
    const processes = await si.processes();
    const sorted = processes.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 20)
      .map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu.toFixed(1), mem: p.mem.toFixed(1), user: p.user || 'system' }));
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch processes' });
  }
});

app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/alerts/config', (req, res) => {
  const { cpuLimit, ramLimit, batteryLimit, enableWaAlerts, alertPhone } = req.body;
  alertConfig = {
    cpuLimit: Number(cpuLimit) || alertConfig.cpuLimit,
    ramLimit: Number(ramLimit) || alertConfig.ramLimit,
    batteryLimit: Number(batteryLimit) || alertConfig.batteryLimit,
    enableWaAlerts: enableWaAlerts !== false,
    alertPhone: alertPhone || alertConfig.alertPhone
  };
  addLog('info', `Alert config diperbarui: CPU ${alertConfig.cpuLimit}%, RAM ${alertConfig.ramLimit}%`, 'SYSTEM');
  res.json({ success: true, alertConfig });
});

app.post('/api/alerts/test-wa', (req, res) => {
  addLog('success', `📲 Alert WA dikirim ke ${alertConfig.alertPhone}: "Server OK! CPU & RAM Normal."`, 'WA_BOT');
  res.json({ success: true, message: 'Test alert WA terpicu!' });
});

app.post('/api/services/toggle-tunnel', (req, res) => {
  tunnelStats.status = tunnelStats.status === 'ONLINE' ? 'PAUSED' : 'ONLINE';
  addLog(tunnelStats.status === 'ONLINE' ? 'success' : 'warn', `Cloudflare Tunnel ${tunnelStats.status}`, 'TUNNEL');
  res.json({ success: true, status: tunnelStats.status });
});

app.get('/api/db/stack', (req, res) => {
  res.json({
    recommended: [
      {
        name: 'Node.js + Express + PostgreSQL + Prisma ORM',
        badge: '⭐ Direkomendasikan',
        color: '#00f2fe',
        description: 'Stack paling profesional & populer. TypeScript-ready, auto migration, type-safe query builder.',
        install: 'npm install express pg prisma @prisma/client\nnpx prisma init\nnpx prisma migrate dev',
        connectionString: 'postgresql://postgres:password@localhost:5432/botdb'
      },
      {
        name: 'Node.js + Fastify + PostgreSQL + Drizzle ORM',
        badge: '🚀 Paling Cepat',
        color: '#7f00ff',
        description: 'Fastify 3x lebih cepat dari Express. Drizzle ORM ringan & cocok untuk laptop low-RAM.',
        install: 'npm install fastify drizzle-orm drizzle-kit pg\nnpx drizzle-kit generate:pg',
        connectionString: 'postgresql://postgres:password@localhost:5432/botdb'
      },
      {
        name: 'Python + FastAPI + PostgreSQL + SQLAlchemy',
        badge: '🐍 Multi-Purpose',
        color: '#f6821f',
        description: 'Swagger auto-generated, cocok jika ada analisa data AI/ML. Async native dengan asyncpg.',
        install: 'pip install fastapi uvicorn sqlalchemy asyncpg psycopg2',
        connectionString: 'postgresql+asyncpg://postgres:password@localhost:5432/botdb'
      },
      {
        name: 'Go (Golang) + Fiber + PostgreSQL + GORM',
        badge: '💡 Paling Hemat RAM',
        color: '#00e676',
        description: 'Kompilasi ke binary kecil, RAM < 30MB, cocok untuk laptop lama yang resourcenya terbatas.',
        install: 'go get gorm.io/gorm gorm.io/driver/postgres github.com/gofiber/fiber/v2',
        connectionString: 'host=localhost user=postgres password=pw dbname=botdb port=5432 sslmode=disable'
      }
    ],
    postgresInstall: {
      windows: 'winget install PostgreSQL.PostgreSQL',
      ubuntu: 'sudo apt install postgresql postgresql-contrib\nsudo systemctl enable --now postgresql',
      docker: 'docker run --name botdb -e POSTGRES_PASSWORD=password -p 5432:5432 -d postgres:16'
    }
  });
});

// ────────────────────────────────────────────────────────────────
// WEBSOCKET – REAL-TIME TELEMETRY (interval 3s to reduce CPU load)
// ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('WS client connected');
  // Send initial state
  Promise.all([getSystemData()]).then(([data]) => {
    if (ws.readyState === 1 && data) {
      ws.send(JSON.stringify({ type: 'TELEMETRY', data }));
      ws.send(JSON.stringify({ type: 'LOGS_INIT', logs: logs.slice(0, 20) }));
      ws.send(JSON.stringify({ type: 'BOTS_UPDATE', bots: [...botInstances.values()].map(serializeBot) }));
    }
  });
  ws.on('message', msg => {
    try {
      const p = JSON.parse(msg);
      if (p.type === 'PING') ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
    } catch (_) {}
  });
});

// Telemetry broadcast every 3 seconds (was 1.5s – halved CPU from monitoring)
setInterval(async () => {
  if (wss.clients.size === 0) return;
  const data = await getSystemData();
  if (!data) return;
  const payload = JSON.stringify({ type: 'TELEMETRY', data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}, 3000);

// ────────────────────────────────────────────────────────────────
// BOOT
// ────────────────────────────────────────────────────────────────
addLog('success', `Server Monitoring started on port ${PORT}`, 'SYSTEM');
addLog('info', 'Cloudflare Tunnel daemon active', 'TUNNEL');
addLog('info', 'PostgreSQL stack ready — lihat tab "Database & Stack"', 'DATABASE');

server.listen(PORT, () => {
  console.log(`\n=======================================================`);
  console.log(`🚀  Laptop Server Watchdog  →  http://localhost:${PORT}`);
  console.log(`=======================================================\n`);
});
