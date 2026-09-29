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

// Single server directory
const DATA_DIR = '/tmp/mcdata';
const SERVER_DIR = DATA_DIR + '/server';
const JAVA_DIR = DATA_DIR + '/java';
const BACKUPS_DIR = DATA_DIR + '/backups';
const CONFIG_FILE = DATA_DIR + '/config.json';
const PLAYIT_DIR = DATA_DIR + '/playit';

let mcProcess = null;
let playitProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let tunnelAddress = null;
let tunnelStatus = 'stopped';
let config = { serverType: 'vanilla', version: '1.21.4', port: 25565, autoStart: true };

function ensureDirs() {
    [DATA_DIR, SERVER_DIR, JAVA_DIR, BACKUPS_DIR, PLAYIT_DIR, SERVER_DIR + '/plugins', SERVER_DIR + '/mods'].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function getJavaVersion(mcVersion) {
    const ver = mcVersion.split('.').map(Number);
    const minor = ver[1] || 0, patch = ver[2] || 0;
    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    if (minor >= 17) return 17;
    return 8;
}

function getJavaDir(mcVersion) {
    return `${JAVA_DIR}/jre${getJavaVersion(mcVersion)}`;
}

const ALL_VERSIONS = {
    vanilla: ['1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.15.2', '1.12.2', '1.8.9'],
    paper: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.20', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5'],
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
        log('Loaded versions');
    } catch (e) { log('Using cached versions'); }
}

function loadConfig() {
    try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}
}

function saveConfig() {
    ensureDirs();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function broadcast(data) {
    wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data)));
}

function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 500) logs.shift();
    broadcast({ type: 'log', data: line });
}

// ==================== PLAYIT TUNNEL ====================
async function installPlayit() {
    const playitBin = PLAYIT_DIR + '/playit';
    if (fs.existsSync(playitBin)) return true;
    log('Installing playit.gg...');
    try {
        ensureDirs();
        execSync(`wget -q -O ${playitBin} "https://builds.playit.gg/1.0.10/playit-linux-amd64"`, { timeout: 120000 });
        execSync(`chmod +x ${playitBin}`);
        log('playit.gg installed');
        return true;
    } catch (e) { log('playit.gg failed: ' + e.message); return false; }
}

async function startTunnel() {
    if (playitProcess) return;
    if (!await installPlayit()) return;
    log('Starting tunnel...');
    tunnelStatus = 'starting';
    broadcast({ type: 'tunnel', status: tunnelStatus });
    
    playitProcess = spawn(PLAYIT_DIR + '/playit', [], { cwd: PLAYIT_DIR, env: { ...process.env, HOME: PLAYIT_DIR } });
    
    const handleData = (data) => {
        const text = data.toString();
        const claimMatch = text.match(/https:\/\/playit\.gg\/claim\/[\w-]+/);
        if (claimMatch) {
            tunnelAddress = claimMatch[0];
            tunnelStatus = 'claim';
            log('🔗 Claim: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'claim', url: tunnelAddress });
        }
        const addrMatch = text.match(/([a-z0-9-]+\.(?:at\.playit\.gg|ply\.gg):\d+)/i);
        if (addrMatch) {
            tunnelAddress = addrMatch[1];
            tunnelStatus = 'connected';
            log('✅ Tunnel: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'connected', address: tunnelAddress });
        }
    };
    playitProcess.stdout.on('data', handleData);
    playitProcess.stderr.on('data', handleData);
    playitProcess.on('close', () => { playitProcess = null; tunnelStatus = 'stopped'; tunnelAddress = null; broadcast({ type: 'tunnel', status: 'stopped' }); });
}

function stopTunnel() {
    if (playitProcess) { playitProcess.kill(); playitProcess = null; tunnelStatus = 'stopped'; tunnelAddress = null; }
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
    
    // Remove old jar
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
    if (!fs.existsSync(SERVER_DIR + '/server.properties')) {
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
`);
    }
}

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    
    ensureDirs();
    logs = [];
    status = 'starting';
    broadcast({ type: 'status', status });
    
    const javaVersion = getJavaVersion(config.version);
    const javaDir = getJavaDir(config.version);
    
    log(`Starting ${config.serverType} ${config.version}`);
    
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    if (!fs.existsSync(SERVER_DIR + '/server.jar')) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    
    createConfigs();
    saveConfig();
    
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
    
    startTunnel();
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
    log('Stopping...');
    status = 'stopping';
    broadcast({ type: 'status', status });
    mcProcess.stdin.write('stop\n');
    setTimeout(() => mcProcess && mcProcess.kill(), 15000);
    return { success: true };
}

async function restartServer() {
    if (mcProcess) { stopServer(); await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); }); }
    return startServer();
}

// Change version (same server, just re-download jar)
async function changeServer(newType, newVersion) {
    const wasRunning = !!mcProcess;
    if (wasRunning) { stopServer(); await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); }); }
    
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    // Remove old jar to force re-download
    try { fs.unlinkSync(SERVER_DIR + '/server.jar'); } catch(e) {}
    // Clean fabric leftovers
    try { execSync(`rm -rf ${SERVER_DIR}/.fabric ${SERVER_DIR}/libraries ${SERVER_DIR}/.mixin*`); } catch(e) {}
    
    log(`Changed to ${newType} ${newVersion}`);
    if (wasRunning) return startServer();
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// ==================== WORLD MANAGEMENT ====================
function backupWorld() {
    const worldDir = SERVER_DIR + '/world';
    if (!fs.existsSync(worldDir)) return { error: 'No world to backup' };
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `world-${timestamp}`;
    const backupPath = BACKUPS_DIR + '/' + backupName;
    
    try {
        execSync(`cp -r ${worldDir} ${backupPath}`);
        log(`Backup created: ${backupName}`);
        return { success: true, name: backupName };
    } catch (e) {
        return { error: 'Backup failed: ' + e.message };
    }
}

function listBackups() {
    try {
        const backups = fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith('world-')).map(name => {
            const stat = fs.statSync(BACKUPS_DIR + '/' + name);
            return { name, date: stat.mtime, size: Math.round(stat.size / 1024 / 1024) + 'MB' };
        }).sort((a, b) => b.date - a.date);
        return backups;
    } catch (e) { return []; }
}

function restoreBackup(name) {
    const backupPath = BACKUPS_DIR + '/' + name;
    const worldDir = SERVER_DIR + '/world';
    
    if (!fs.existsSync(backupPath)) return { error: 'Backup not found' };
    if (mcProcess) return { error: 'Stop server first' };
    
    try {
        execSync(`rm -rf ${worldDir} && cp -r ${backupPath} ${worldDir}`);
        log(`Restored backup: ${name}`);
        return { success: true };
    } catch (e) { return { error: 'Restore failed' }; }
}

function deleteBackup(name) {
    try {
        execSync(`rm -rf ${BACKUPS_DIR}/${name}`);
        return { success: true };
    } catch (e) { return { error: 'Delete failed' }; }
}

function resetWorld() {
    if (mcProcess) return { error: 'Stop server first' };
    try {
        execSync(`rm -rf ${SERVER_DIR}/world ${SERVER_DIR}/world_nether ${SERVER_DIR}/world_the_end`);
        log('World reset - new world on next start');
        return { success: true };
    } catch (e) { return { error: 'Reset failed' }; }
}

// ==================== FILE MANAGEMENT ====================
function listFiles(subpath = '') {
    const dir = path.join(SERVER_DIR, subpath);
    if (!dir.startsWith(SERVER_DIR)) return { error: 'Invalid path' };
    
    try {
        const items = fs.readdirSync(dir).map(name => {
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                path: path.join(subpath, name),
                isDir: stat.isDirectory(),
                size: stat.size,
                modified: stat.mtime
            };
        }).sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return { items, path: subpath };
    } catch (e) { return { error: 'Cannot read directory' }; }
}

function readFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid path' };
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, path: subpath };
    } catch (e) { return { error: 'Cannot read file' }; }
}

function writeFile(subpath, content) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid path' };
    
    try {
        fs.writeFileSync(filePath, content);
        log(`File saved: ${subpath}`);
        return { success: true };
    } catch (e) { return { error: 'Cannot write file' }; }
}

function deleteFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid path' };
    
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            execSync(`rm -rf "${filePath}"`);
        } else {
            fs.unlinkSync(filePath);
        }
        log(`Deleted: ${subpath}`);
        return { success: true };
    } catch (e) { return { error: 'Cannot delete' }; }
}

// ==================== PLUGINS/MODS ====================
function listPlugins() {
    const pluginsDir = SERVER_DIR + '/plugins';
    const modsDir = SERVER_DIR + '/mods';
    
    const plugins = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir).filter(f => f.endsWith('.jar')) : [];
    const mods = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')) : [];
    
    return { plugins, mods };
}

async function installPlugin(url, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const fileName = url.split('/').pop().split('?')[0] || 'plugin.jar';
    const filePath = dir + '/' + fileName;
    
    try {
        log(`Downloading ${type}: ${fileName}...`);
        execSync(`wget -q -O "${filePath}" "${url}"`, { timeout: 120000 });
        log(`Installed ${type}: ${fileName}`);
        return { success: true, name: fileName };
    } catch (e) {
        return { error: 'Download failed' };
    }
}

function removePlugin(name, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    const filePath = dir + '/' + name;
    
    try {
        fs.unlinkSync(filePath);
        log(`Removed ${type}: ${name}`);
        return { success: true };
    } catch (e) { return { error: 'Remove failed' }; }
}

// ==================== WEBSOCKET ====================
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', status, players, config, logs: logs.slice(-100), versions: cachedVersions,
        tunnel: { status: tunnelStatus, address: tunnelAddress }
    }));
    ws.on('message', (msg) => { 
        try { const { type, data } = JSON.parse(msg); if (type === 'command') sendCommand(data); } catch (e) {} 
    });
});

// ==================== API ====================
app.get('/api/status', (req, res) => res.json({ status, players, config, tunnel: { status: tunnelStatus, address: tunnelAddress } }));
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => { 
    const { serverType, version } = req.body; 
    res.json(await changeServer(serverType, version)); 
});
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));

// World
app.post('/api/world/backup', (req, res) => res.json(backupWorld()));
app.get('/api/world/backups', (req, res) => res.json(listBackups()));
app.post('/api/world/restore', (req, res) => res.json(restoreBackup(req.body.name)));
app.post('/api/world/delete-backup', (req, res) => res.json(deleteBackup(req.body.name)));
app.post('/api/world/reset', (req, res) => res.json(resetWorld()));

// Files
app.get('/api/files', (req, res) => res.json(listFiles(req.query.path || '')));
app.get('/api/files/read', (req, res) => res.json(readFile(req.query.path)));
app.post('/api/files/write', (req, res) => res.json(writeFile(req.body.path, req.body.content)));
app.post('/api/files/delete', (req, res) => res.json(deleteFile(req.body.path)));

// Plugins/Mods
app.get('/api/plugins', (req, res) => res.json(listPlugins()));
app.post('/api/plugins/install', async (req, res) => res.json(await installPlugin(req.body.url, req.body.type)));
app.post('/api/plugins/remove', (req, res) => res.json(removePlugin(req.body.name, req.body.type)));

app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Dashboard on port ${PORT}`);
    ensureDirs();
    loadConfig();
    await loadVersions();
    if (config.autoStart) { log('Auto-starting...'); startServer(); }
});

process.on('SIGTERM', () => { 
    if (mcProcess) { mcProcess.stdin.write('save-all\n'); setTimeout(() => mcProcess?.stdin.write('stop\n'), 2000); }
    stopTunnel();
    setTimeout(() => process.exit(0), 12000);
});
