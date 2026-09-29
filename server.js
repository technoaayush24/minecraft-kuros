const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = '/tmp/mcserver';
const JRE_DIR = '/tmp/jre';
const JRE8_DIR = '/tmp/jre8';
const JRE17_DIR = '/tmp/jre17';
const CONFIG_FILE = DATA_DIR + '/config.json';
const PLAYIT_DIR = '/tmp/playit';

let mcProcess = null;
let playitProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let playitAddress = null;
let config = { serverType: 'vanilla', version: '1.21.4', port: 25565 };

// Java version requirements
function getJavaVersion(mcVersion) {
    const ver = mcVersion.split('.').map(Number);
    const major = ver[0], minor = ver[1] || 0;
    
    // 1.20.5+ needs Java 21
    if (major >= 1 && minor >= 21) return 21;
    if (major >= 1 && minor === 20 && (ver[2] || 0) >= 5) return 21;
    
    // 1.17-1.20.4 needs Java 17
    if (major >= 1 && minor >= 17) return 17;
    
    // 1.16 and below needs Java 8
    return 8;
}

function getJavaDir(mcVersion) {
    const jv = getJavaVersion(mcVersion);
    if (jv === 8) return JRE8_DIR;
    if (jv === 17) return JRE17_DIR;
    return JRE_DIR; // Java 21
}

const ALL_VERSIONS = {
    vanilla: [
        '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
        '1.20.6', '1.20.5', '1.20.4', '1.20.2', '1.20.1', '1.20',
        '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
        '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17',
        '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16',
        '1.15.2', '1.14.4', '1.12.2', '1.8.9'
    ],
    paper: [
        '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
        '1.20.6', '1.20.5', '1.20.4', '1.20.2', '1.20.1', '1.20',
        '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
        '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17',
        '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16'
    ],
    neoforge: ['1.21.4', '1.21.3', '1.21.1', '1.20.4', '1.20.1'],
    fabric: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2']
};

let cachedVersions = { ...ALL_VERSIONS };
let vanillaManifest = {};

async function loadVersions() {
    try {
        const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"', { timeout: 10000 }).toString());
        cachedVersions.vanilla = manifest.versions.filter(v => v.type === 'release').map(v => v.id).slice(0, 50);
        manifest.versions.forEach(v => { if (v.type === 'release') vanillaManifest[v.id] = v.url; });
        
        const paper = JSON.parse(execSync('wget -qO- "https://api.papermc.io/v2/projects/paper"', { timeout: 10000 }).toString());
        if (paper.versions) cachedVersions.paper = paper.versions.reverse().slice(0, 40);
        
        log('Loaded latest versions');
    } catch (e) { log('Using cached versions'); }
}

function loadConfig() {
    try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}
}

function saveConfig() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
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

// Install specific Java version
async function installJava(version) {
    const urls = {
        8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u422-b05/OpenJDK8U-jre_x64_alpine-linux_hotspot_8u422b05.tar.gz',
        17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jre_x64_alpine-linux_hotspot_17.0.12_7.tar.gz',
        21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz'
    };
    
    const dirs = { 8: JRE8_DIR, 17: JRE17_DIR, 21: JRE_DIR };
    const extractDirs = { 8: 'jdk8u422-b05-jre', 17: 'jdk-17.0.12+7-jre', 21: 'jdk-21.0.4+7-jre' };
    
    const dir = dirs[version];
    if (fs.existsSync(dir + '/bin/java')) return true;
    
    log(`Installing Java ${version}...`);
    status = 'installing';
    broadcast({ type: 'status', status });
    
    try {
        execSync(`wget -q -O /tmp/jre${version}.tar.gz "${urls[version]}"`, { timeout: 300000 });
        execSync(`mkdir -p ${dir} && tar -xzf /tmp/jre${version}.tar.gz -C /tmp && mv /tmp/${extractDirs[version]}/* ${dir}/`);
        execSync(`rm -f /tmp/jre${version}.tar.gz`);
        log(`Java ${version} installed`);
        return true;
    } catch (e) { log(`Java ${version} install failed: ` + e.message); status = 'error'; return false; }
}

async function installPlayit() {
    if (fs.existsSync(PLAYIT_DIR + '/playit')) return true;
    log('Installing playit.gg...');
    try {
        fs.mkdirSync(PLAYIT_DIR, { recursive: true });
        execSync(`wget -q -O ${PLAYIT_DIR}/playit.tar.gz "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64.tar.gz"`, { timeout: 120000 });
        execSync(`cd ${PLAYIT_DIR} && tar -xzf playit.tar.gz && chmod +x playit*`);
        return true;
    } catch (e) { log('playit.gg failed: ' + e.message); return false; }
}

async function startPlayit() {
    if (playitProcess) return;
    if (!await installPlayit()) return;
    log('Starting tunnel...');
    
    playitProcess = spawn(PLAYIT_DIR + '/playit', ['--stdout'], { cwd: PLAYIT_DIR });
    
    playitProcess.stdout.on('data', (data) => {
        const text = data.toString();
        const claimMatch = text.match(/https:\/\/playit\.gg\/claim\/[a-zA-Z0-9-]+/);
        if (claimMatch) { playitAddress = claimMatch[0]; broadcast({ type: 'playit', status: 'claim', url: playitAddress }); log('Claim tunnel: ' + playitAddress); }
        const tunnelMatch = text.match(/(\w+\.ply\.gg:\d+)/);
        if (tunnelMatch) { playitAddress = tunnelMatch[1]; broadcast({ type: 'playit', status: 'connected', address: playitAddress }); log('Tunnel ready: ' + playitAddress); }
    });
    playitProcess.stderr.on('data', (data) => {});
    playitProcess.on('close', () => { playitProcess = null; playitAddress = null; broadcast({ type: 'playit', status: 'stopped' }); });
}

function stopPlayit() { if (playitProcess) { playitProcess.kill(); playitProcess = null; playitAddress = null; } }

async function getVanillaJarUrl(version) {
    try {
        if (vanillaManifest[version]) {
            const versionData = JSON.parse(execSync(`wget -qO- "${vanillaManifest[version]}"`, { timeout: 10000 }).toString());
            return versionData.downloads?.server?.url;
        }
        const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"', { timeout: 10000 }).toString());
        const versionInfo = manifest.versions.find(v => v.id === version);
        if (versionInfo) {
            const versionData = JSON.parse(execSync(`wget -qO- "${versionInfo.url}"`, { timeout: 10000 }).toString());
            return versionData.downloads?.server?.url;
        }
    } catch (e) {}
    return null;
}

async function downloadServer() {
    const jarPath = DATA_DIR + '/server.jar';
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading';
    broadcast({ type: 'status', status });
    
    const javaDir = getJavaDir(config.version);
    
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
        
        if (config.serverType === 'vanilla') {
            const url = await getVanillaJarUrl(config.version);
            if (!url) throw new Error('Version not found');
            execSync(`wget -q -O "${jarPath}" "${url}"`, { timeout: 300000 });
            
        } else if (config.serverType === 'paper') {
            const builds = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}"`, { timeout: 10000 }).toString());
            const latestBuild = builds.builds[builds.builds.length - 1];
            const buildInfo = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${latestBuild}"`, { timeout: 10000 }).toString());
            const fileName = buildInfo.downloads.application.name;
            execSync(`wget -q -O "${jarPath}" "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${latestBuild}/downloads/${fileName}"`, { timeout: 300000 });
            
        } else if (config.serverType === 'neoforge') {
            log('Setting up NeoForge...');
            const nfVersions = JSON.parse(execSync('wget -qO- "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"', { timeout: 10000 }).toString());
            const mcVer = config.version.replace('1.', '');
            const nfVersion = nfVersions.versions.reverse().find(v => v.startsWith(mcVer));
            if (!nfVersion) throw new Error('NeoForge not available for ' + config.version);
            
            execSync(`wget -q -O ${DATA_DIR}/neoforge-installer.jar "https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/neoforge-${nfVersion}-installer.jar"`, { timeout: 180000 });
            execSync(`cd ${DATA_DIR} && ${javaDir}/bin/java -jar neoforge-installer.jar --installServer`, { timeout: 600000 });
            
        } else if (config.serverType === 'fabric') {
            const installerData = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/installer"', { timeout: 10000 }).toString());
            execSync(`wget -q -O ${DATA_DIR}/fabric-installer.jar "${installerData[0]?.url}"`, { timeout: 120000 });
            execSync(`cd ${DATA_DIR} && ${javaDir}/bin/java -jar fabric-installer.jar server -mcversion ${config.version} -downloadMinecraft`, { timeout: 300000 });
            if (fs.existsSync(DATA_DIR + '/fabric-server-launch.jar')) fs.renameSync(DATA_DIR + '/fabric-server-launch.jar', jarPath);
        }
        
        log('Download complete');
        return true;
    } catch (e) { log('Download failed: ' + e.message); status = 'error'; return false; }
}

function createConfigs() {
    fs.writeFileSync(DATA_DIR + '/eula.txt', 'eula=true\n');
    fs.writeFileSync(DATA_DIR + '/server.properties', `
server-port=${config.port}
online-mode=false
max-players=20
view-distance=6
simulation-distance=4
spawn-protection=0
difficulty=normal
gamemode=survival
motd=\\u00a7b\\u00a7lKuros MC\\u00a7r - ${config.serverType} ${config.version}
enable-command-block=true
max-tick-time=120000
`.trim());
}

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    
    logs = [];
    status = 'starting';
    broadcast({ type: 'status', status });
    broadcast({ type: 'logs', data: '' });
    
    // Install correct Java version
    const javaVersion = getJavaVersion(config.version);
    const javaDir = getJavaDir(config.version);
    log(`MC ${config.version} requires Java ${javaVersion}`);
    
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    
    const jarPath = DATA_DIR + '/server.jar';
    const hasServer = fs.existsSync(jarPath) || fs.existsSync(DATA_DIR + '/run.sh');
    if (!hasServer) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    
    createConfigs();
    saveConfig();
    
    log(`Starting ${config.serverType} ${config.version}...`);
    
    // Use max memory (leave some for system)
    const maxMem = 450; // Safe for 512MB container
    
    let cmd, args;
    if (config.serverType === 'neoforge' && fs.existsSync(DATA_DIR + '/run.sh')) {
        cmd = '/bin/sh';
        args = ['run.sh', 'nogui'];
    } else {
        cmd = javaDir + '/bin/java';
        args = [`-Xms128M`, `-Xmx${maxMem}M`, '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-jar', 'server.jar', 'nogui'];
    }
    
    mcProcess = spawn(cmd, args, { cwd: DATA_DIR, env: { ...process.env, JAVA_HOME: javaDir } });
    
    mcProcess.stdout.on('data', handleOutput);
    mcProcess.stderr.on('data', handleOutput);
    
    mcProcess.on('close', (code) => {
        log(`Server stopped (${code})`);
        status = 'stopped';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status });
        broadcast({ type: 'players', players });
    });
    
    startPlayit();
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
            log('Server ready!');
            broadcast({ type: 'status', status });
        }
        
        const join = line.match(/(\w+)\[.*?\] logged in|(\w+) joined the game/);
        const leave = line.match(/(\w+) left the game/);
        if (join) { const name = join[1] || join[2]; if (!players.includes(name)) { players.push(name); broadcast({ type: 'players', players }); } }
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

async function changeServer(newType, newVersion) {
    const wasRunning = !!mcProcess;
    if (wasRunning) { stopServer(); await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); }); }
    
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    try { execSync(`rm -rf ${DATA_DIR}/server.jar ${DATA_DIR}/libraries ${DATA_DIR}/mods ${DATA_DIR}/*.json ${DATA_DIR}/run.sh ${DATA_DIR}/*installer* ${DATA_DIR}/fabric*`); } catch(e){}
    
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

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', status, players, config, logs: logs.slice(-100),
        playit: playitAddress ? (playitAddress.startsWith('http') ? { status: 'claim', url: playitAddress } : { status: 'connected', address: playitAddress }) : { status: 'stopped' },
        versions: cachedVersions
    }));
    ws.on('message', (msg) => { try { const { type, data } = JSON.parse(msg); if (type === 'command') sendCommand(data); } catch (e) {} });
});

app.get('/api/status', (req, res) => res.json({ status, players, config, playitAddress, logsCount: logs.length }));
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => { const { serverType, version } = req.body; if (!serverType || !version) return res.json({ error: 'Missing' }); res.json(await changeServer(serverType, version)); });
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.post('/api/playit/start', async (req, res) => { await startPlayit(); res.json({ success: true }); });
app.post('/api/playit/stop', (req, res) => { stopPlayit(); res.json({ success: true }); });
app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    loadConfig();
    console.log(`Dashboard on port ${PORT}`);
    await loadVersions();
    if (fs.existsSync(DATA_DIR + '/server.jar') || fs.existsSync(DATA_DIR + '/run.sh')) startServer();
});

process.on('SIGTERM', () => { if (mcProcess) mcProcess.stdin.write('stop\n'); stopPlayit(); setTimeout(() => process.exit(0), 10000); });
