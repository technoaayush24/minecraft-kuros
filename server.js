const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const DATA_DIR = '/tmp/mcdata';
const SERVER_DIR = DATA_DIR + '/server';
const JAVA_DIR = DATA_DIR + '/java';
const BACKUPS_DIR = DATA_DIR + '/backups';
const CONFIG_FILE = DATA_DIR + '/config.json';

let mcProcess = null;
let tunnelProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let tunnelAddress = null;
let tunnelStatus = 'stopped';
let config = { serverType: 'vanilla', version: '1.21.4', port: 25565, autoStart: true };

function ensureDirs() {
    [DATA_DIR, SERVER_DIR, JAVA_DIR, BACKUPS_DIR, SERVER_DIR + '/plugins', SERVER_DIR + '/mods'].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function getJavaVersion(mcVersion) {
    // Parse version like "1.21.4" or "1.20.1"
    const match = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!match) return 21; // Default to Java 21 for safety
    const minor = parseInt(match[1]) || 0;
    const patch = parseInt(match[2]) || 0;
    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    if (minor >= 17) return 17;
    if (minor >= 12) return 8;
    return 8;
}

function getJavaDir(mcVersion) { return `${JAVA_DIR}/jre${getJavaVersion(mcVersion)}`; }

const ALL_VERSIONS = {
    vanilla: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.9'],
    paper: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5'],
    fabric: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2']
};

let cachedVersions = { ...ALL_VERSIONS };
let vanillaManifest = {};

async function loadVersions() {
    try {
        const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"', { timeout: 15000 }).toString());
        cachedVersions.vanilla = manifest.versions.filter(v => v.type === 'release').map(v => v.id).slice(0, 40);
        manifest.versions.forEach(v => { if (v.type === 'release') vanillaManifest[v.id] = v.url; });
        const paper = JSON.parse(execSync('wget -qO- "https://api.papermc.io/v2/projects/paper"', { timeout: 15000 }).toString());
        if (paper.versions) cachedVersions.paper = paper.versions.reverse().slice(0, 30);
    } catch (e) {}
}

function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {} }
function saveConfig() { ensureDirs(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

function broadcast(data) { wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data))); }

function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 500) logs.shift();
    broadcast({ type: 'log', data: line });
}

// ==================== BORE TUNNEL (Simple, no signup!) ====================
async function installBore() {
    const boreBin = DATA_DIR + '/bore';
    if (fs.existsSync(boreBin)) return true;
    log('Installing bore tunnel...');
    try {
        ensureDirs();
        execSync(`wget -q -O /tmp/bore.tar.gz "https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-unknown-linux-musl.tar.gz"`, { timeout: 60000 });
        execSync(`tar -xzf /tmp/bore.tar.gz -C ${DATA_DIR} && rm /tmp/bore.tar.gz`);
        execSync(`chmod +x ${boreBin}`);
        log('bore installed');
        return true;
    } catch (e) { 
        log('bore install failed: ' + e.message); 
        return false; 
    }
}

async function startTunnel() {
    if (tunnelProcess) {
        log('Tunnel already running');
        return;
    }
    
    if (!await installBore()) return;
    
    log('Starting tunnel...');
    tunnelStatus = 'starting';
    broadcast({ type: 'tunnel', status: tunnelStatus });
    
    const boreBin = DATA_DIR + '/bore';
    
    tunnelProcess = spawn(boreBin, ['local', '25565', '--to', 'bore.pub'], {
        cwd: DATA_DIR
    });
    
    tunnelProcess.stdout.on('data', (data) => {
        const text = data.toString();
        console.log('[bore]', text.trim());
        
        // Look for the address
        const match = text.match(/listening at ([^\s]+)/i);
        if (match) {
            tunnelAddress = match[1];
            tunnelStatus = 'connected';
            log('✅ CONNECT: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'connected', address: tunnelAddress });
        }
    });
    
    tunnelProcess.stderr.on('data', (data) => {
        const text = data.toString();
        console.log('[bore]', text.trim());
        
        const match = text.match(/listening at ([^\s]+)/i);
        if (match) {
            tunnelAddress = match[1];
            tunnelStatus = 'connected';
            log('✅ CONNECT: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'connected', address: tunnelAddress });
        }
        
        if (text.includes('error')) {
            log('[tunnel] ' + text.trim());
        }
    });
    
    tunnelProcess.on('close', (code) => {
        log(`Tunnel exited (${code})`);
        tunnelProcess = null;
        tunnelStatus = 'stopped';
        tunnelAddress = null;
        broadcast({ type: 'tunnel', status: 'stopped' });
    });
}

function stopTunnel() {
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    tunnelStatus = 'stopped'; 
    tunnelAddress = null;
    broadcast({ type: 'tunnel', status: 'stopped' });
}

// ==================== JAVA ====================
async function installJava(version) {
    const urls = {
        8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u422-b05/OpenJDK8U-jre_x64_alpine-linux_hotspot_8u422b05.tar.gz',
        17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jre_x64_alpine-linux_hotspot_17.0.12_7.tar.gz',
        21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz'
    };
    const extractDirs = { 8: 'jdk8u422-b05-jre', 17: 'jdk-17.0.12+7-jre', 21: 'jdk-21.0.4+7-jre' };
    const dir = `${JAVA_DIR}/jre${version}`;
    if (fs.existsSync(dir + '/bin/java')) return true;
    log(`Installing Java ${version}...`);
    status = 'installing';
    broadcast({ type: 'status', status });
    try {
        execSync(`wget -q -O /tmp/jre.tar.gz "${urls[version]}"`, { timeout: 300000 });
        execSync(`mkdir -p ${dir} && tar -xzf /tmp/jre.tar.gz -C /tmp && mv /tmp/${extractDirs[version]}/* ${dir}/ && rm /tmp/jre.tar.gz`);
        log(`Java ${version} ready`);
        return true;
    } catch (e) { log(`Java failed: ` + e.message); status = 'error'; return false; }
}

// ==================== SERVER ====================
async function getVanillaJarUrl(version) {
    try {
        if (vanillaManifest[version]) {
            const data = JSON.parse(execSync(`wget -qO- "${vanillaManifest[version]}"`, { timeout: 15000 }).toString());
            return data.downloads?.server?.url;
        }
    } catch (e) {}
    return null;
}

async function downloadServer() {
    const jarPath = SERVER_DIR + '/server.jar';
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading';
    broadcast({ type: 'status', status });
    if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    const javaDir = getJavaDir(config.version);
    try {
        if (config.serverType === 'vanilla') {
            const url = await getVanillaJarUrl(config.version);
            if (!url) throw new Error('Version not found');
            execSync(`wget -q -O "${jarPath}" "${url}"`, { timeout: 300000 });
        } else if (config.serverType === 'paper') {
            const builds = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}"`, { timeout: 15000 }).toString());
            const build = builds.builds[builds.builds.length - 1];
            const info = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${build}"`, { timeout: 15000 }).toString());
            execSync(`wget -q -O "${jarPath}" "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${build}/downloads/${info.downloads.application.name}"`, { timeout: 300000 });
        } else if (config.serverType === 'fabric') {
            const installer = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/installer"', { timeout: 15000 }).toString());
            execSync(`wget -q -O ${SERVER_DIR}/fabric-installer.jar "${installer[0]?.url}"`, { timeout: 120000 });
            execSync(`cd ${SERVER_DIR} && ${javaDir}/bin/java -jar fabric-installer.jar server -mcversion ${config.version} -downloadMinecraft`, { timeout: 300000 });
            if (fs.existsSync(SERVER_DIR + '/fabric-server-launch.jar')) fs.renameSync(SERVER_DIR + '/fabric-server-launch.jar', jarPath);
            try { fs.unlinkSync(SERVER_DIR + '/fabric-installer.jar'); } catch(e){}
        }
        log('Download complete');
        return true;
    } catch (e) { log('Download failed: ' + e.message); status = 'error'; return false; }
}

function createConfigs() {
    if (!fs.existsSync(SERVER_DIR + '/eula.txt')) fs.writeFileSync(SERVER_DIR + '/eula.txt', 'eula=true\n');
    fs.writeFileSync(SERVER_DIR + '/server.properties', `server-port=25565
online-mode=false
max-players=20
view-distance=6
simulation-distance=4
spawn-protection=0
difficulty=normal
gamemode=survival
motd=\\u00a7bKuros MC Server
enable-command-block=true
max-tick-time=120000
`);
}

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    ensureDirs(); logs = []; status = 'starting';
    broadcast({ type: 'status', status });
    const javaVersion = getJavaVersion(config.version);
    const javaDir = getJavaDir(config.version);
    log(`Starting ${config.serverType} ${config.version}`);
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    if (!fs.existsSync(SERVER_DIR + '/server.jar')) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    createConfigs(); saveConfig();
    mcProcess = spawn(javaDir + '/bin/java', ['-Xms128M', '-Xmx380M', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui'], 
        { cwd: SERVER_DIR, env: { ...process.env, JAVA_HOME: javaDir } });
    mcProcess.stdout.on('data', handleOutput);
    mcProcess.stderr.on('data', handleOutput);
    mcProcess.on('close', (code) => {
        log(`Server stopped (${code})`);
        status = 'stopped'; mcProcess = null; players = [];
        broadcast({ type: 'status', status });
        broadcast({ type: 'players', players });
    });
    // Start tunnel automatically
    setTimeout(() => startTunnel(), 3000);
    return { success: true };
}

function handleOutput(data) {
    data.toString().split('\n').forEach(line => {
        if (!line.trim()) return;
        logs.push(line);
        if (logs.length > 500) logs.shift();
        broadcast({ type: 'log', data: line });
        if (line.includes('Done') && line.includes('For help')) {
            status = 'running';
            log('✓ Server ready!');
            broadcast({ type: 'status', status });
        }
        const join = line.match(/(\w+)\[.*?\] logged in|(\w+) joined the game/);
        const leave = line.match(/(\w+) left the game/);
        if (join) { const n = join[1] || join[2]; if (!players.includes(n)) { players.push(n); broadcast({ type: 'players', players }); } }
        if (leave) { players = players.filter(p => p !== leave[1]); broadcast({ type: 'players', players }); }
    });
}

function stopServer() {
    if (!mcProcess) return { error: 'Not running' };
    log('Stopping...'); status = 'stopping';
    broadcast({ type: 'status', status });
    mcProcess.stdin.write('stop\n');
    setTimeout(() => mcProcess && mcProcess.kill(), 15000);
    stopTunnel();
    return { success: true };
}

async function restartServer() {
    if (mcProcess) { stopServer(); await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); }); }
    return startServer();
}

async function changeServer(newType, newVersion) {
    // Strict validation - version must be in our list
    const validVersions = cachedVersions[newType] || [];
    if (!validVersions.includes(newVersion)) {
        log(`❌ Invalid version: ${newType} ${newVersion}`);
        log(`Valid versions: ${validVersions.slice(0, 10).join(', ')}...`);
        return { error: 'Invalid version. Select from dropdown.' };
    }
    
    // Must start with "1." (Minecraft versions are 1.x.x)
    if (!newVersion.match(/^1\.\d+/)) {
        log(`❌ Invalid version format: ${newVersion}`);
        return { error: 'Invalid version format' };
    }
    
    // Don't change if same version
    if (config.serverType === newType && config.version === newVersion) {
        log('Already on this version');
        return { success: true, message: 'Already on this version' };
    }
    
    const wasRunning = !!mcProcess;
    
    // Force stop server if running
    if (mcProcess) {
        log('Stopping server for version change...');
        status = 'stopping';
        broadcast({ type: 'status', status });
        
        // Try graceful stop first
        try { mcProcess.stdin.write('stop\n'); } catch(e) {}
        
        // Wait max 15 seconds for graceful stop
        let waited = 0;
        while (mcProcess && waited < 15000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        
        // Force kill if still running
        if (mcProcess) {
            log('Force stopping server...');
            try { mcProcess.kill('SIGKILL'); } catch(e) {}
            mcProcess = null;
        }
        
        // Wait for process cleanup
        await new Promise(r => setTimeout(r, 2000));
        status = 'stopped';
        broadcast({ type: 'status', status });
    }
    
    // Auto-backup world before version change
    const worldDir = SERVER_DIR + '/world';
    if (fs.existsSync(worldDir)) {
        const backupName = `backup-before-${newVersion}`;
        try {
            // Remove old backup with same name if exists
            try { execSync(`rm -rf ${BACKUPS_DIR}/${backupName}`); } catch(e) {}
            execSync(`cp -r ${worldDir} ${BACKUPS_DIR}/${backupName}`);
            log(`📦 Auto-backup: ${backupName}`);
        } catch(e) {
            log('Backup warning: ' + e.message);
        }
    }
    
    // Update config
    const oldVersion = config.version;
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    // Clean up server files BUT KEEP THE WORLD
    log(`Switching ${oldVersion} → ${newVersion}...`);
    try { fs.unlinkSync(SERVER_DIR + '/server.jar'); } catch(e) {}
    try { execSync(`rm -rf ${SERVER_DIR}/.fabric ${SERVER_DIR}/libraries ${SERVER_DIR}/.mixin* ${SERVER_DIR}/versions ${SERVER_DIR}/*.json 2>/dev/null || true`); } catch(e) {}
    
    log(`✓ Ready for ${newType} ${newVersion}`);
    
    if (wasRunning) {
        await new Promise(r => setTimeout(r, 1000));
        return startServer();
    }
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// ==================== WORLD ====================
function backupWorld() {
    const worldDir = SERVER_DIR + '/world';
    if (!fs.existsSync(worldDir)) return { error: 'No world' };
    const name = `world-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    try { execSync(`cp -r ${worldDir} ${BACKUPS_DIR}/${name}`); log(`Backup: ${name}`); return { success: true, name }; } 
    catch (e) { return { error: 'Failed' }; }
}

function listBackups() {
    try {
        return fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith('world-')).map(name => {
            const stat = fs.statSync(BACKUPS_DIR + '/' + name);
            return { name, date: stat.mtime };
        }).sort((a, b) => b.date - a.date);
    } catch (e) { return []; }
}

function restoreBackup(name) {
    if (mcProcess) return { error: 'Stop server first' };
    if (!fs.existsSync(BACKUPS_DIR + '/' + name)) return { error: 'Not found' };
    try { execSync(`rm -rf ${SERVER_DIR}/world && cp -r ${BACKUPS_DIR}/${name} ${SERVER_DIR}/world`); log(`Restored: ${name}`); return { success: true }; } 
    catch (e) { return { error: 'Failed' }; }
}

function deleteBackup(name) { try { execSync(`rm -rf ${BACKUPS_DIR}/${name}`); return { success: true }; } catch (e) { return { error: 'Failed' }; } }

function resetWorld() {
    if (mcProcess) return { error: 'Stop server first' };
    try { execSync(`rm -rf ${SERVER_DIR}/world ${SERVER_DIR}/world_nether ${SERVER_DIR}/world_the_end`); log('World reset'); return { success: true }; } 
    catch (e) { return { error: 'Failed' }; }
}

// ==================== FILES ====================
function listFiles(subpath = '') {
    const dir = path.join(SERVER_DIR, subpath);
    if (!dir.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try {
        const items = fs.readdirSync(dir).map(name => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, path: path.join(subpath, name), isDir: stat.isDirectory(), size: stat.size };
        }).sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
        return { items, path: subpath };
    } catch (e) { return { error: 'Cannot read' }; }
}

function readFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try { return { content: fs.readFileSync(filePath, 'utf8'), path: subpath }; } catch (e) { return { error: 'Cannot read' }; }
}

function writeFile(subpath, content) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try { fs.writeFileSync(filePath, content); log(`Saved: ${subpath}`); return { success: true }; } catch (e) { return { error: 'Cannot write' }; }
}

function deleteFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) execSync(`rm -rf "${filePath}"`); else fs.unlinkSync(filePath);
        return { success: true };
    } catch (e) { return { error: 'Cannot delete' }; }
}

// ==================== PLUGINS ====================
function listPlugins() {
    const plugins = fs.existsSync(SERVER_DIR + '/plugins') ? fs.readdirSync(SERVER_DIR + '/plugins').filter(f => f.endsWith('.jar')) : [];
    const mods = fs.existsSync(SERVER_DIR + '/mods') ? fs.readdirSync(SERVER_DIR + '/mods').filter(f => f.endsWith('.jar')) : [];
    return { plugins, mods };
}

async function installPlugin(url, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fileName = url.split('/').pop().split('?')[0] || 'plugin.jar';
    try { log(`Installing: ${fileName}...`); execSync(`wget -q -O "${dir}/${fileName}" "${url}"`, { timeout: 120000 }); log(`Installed: ${fileName}`); return { success: true, name: fileName }; } 
    catch (e) { return { error: 'Failed' }; }
}

function removePlugin(name, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    try { fs.unlinkSync(dir + '/' + name); log(`Removed: ${name}`); return { success: true }; } catch (e) { return { error: 'Failed' }; }
}

// ==================== ROUTES ====================
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', status, players, config, logs: logs.slice(-100), versions: cachedVersions,
        tunnel: { status: tunnelStatus, address: tunnelAddress }
    }));
    ws.on('message', (msg) => { try { const { type, data } = JSON.parse(msg); if (type === 'command') sendCommand(data); } catch (e) {} });
});

app.get('/api/status', (req, res) => res.json({ status, players, config, tunnel: { status: tunnelStatus, address: tunnelAddress } }));
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => res.json(await changeServer(req.body.serverType, req.body.version)));
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.post('/api/tunnel/start', async (req, res) => { await startTunnel(); res.json({ success: true }); });
app.post('/api/tunnel/stop', (req, res) => { stopTunnel(); res.json({ success: true }); });

app.post('/api/world/backup', (req, res) => res.json(backupWorld()));
app.get('/api/world/backups', (req, res) => res.json(listBackups()));
app.post('/api/world/restore', (req, res) => res.json(restoreBackup(req.body.name)));
app.post('/api/world/delete-backup', (req, res) => res.json(deleteBackup(req.body.name)));
app.post('/api/world/reset', (req, res) => res.json(resetWorld()));

app.get('/api/files', (req, res) => res.json(listFiles(req.query.path || '')));
app.get('/api/files/read', (req, res) => res.json(readFile(req.query.path)));
app.post('/api/files/write', (req, res) => res.json(writeFile(req.body.path, req.body.content)));
app.post('/api/files/delete', (req, res) => res.json(deleteFile(req.body.path)));

app.get('/api/plugins', (req, res) => res.json(listPlugins()));
app.post('/api/plugins/install', async (req, res) => res.json(await installPlugin(req.body.url, req.body.type)));
app.post('/api/plugins/remove', (req, res) => res.json(removePlugin(req.body.name, req.body.type)));

app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Dashboard on port ${PORT}`);
    ensureDirs(); loadConfig(); await loadVersions();
    if (config.autoStart) { log('Auto-starting...'); startServer(); }
});

process.on('SIGTERM', () => { 
    if (mcProcess) { mcProcess.stdin.write('save-all\n'); setTimeout(() => mcProcess?.stdin.write('stop\n'), 2000); }
    stopTunnel();
    setTimeout(() => process.exit(0), 12000);
});
