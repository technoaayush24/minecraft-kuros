const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static('public'));

// PERSISTENT DATA - survives restarts
const DATA_DIR = '/data';  // Mount this as persistent volume
const SERVERS_DIR = DATA_DIR + '/servers';
const JAVA_DIR = DATA_DIR + '/java';
const CONFIG_FILE = DATA_DIR + '/config.json';

let mcProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let config = { serverType: 'vanilla', version: '1.21.4', port: 25565, autoStart: true };

// Ensure directories exist
function ensureDirs() {
    [DATA_DIR, SERVERS_DIR, JAVA_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

// Get server directory (each type+version combo has its own folder with world data)
function getServerDir() {
    const dir = `${SERVERS_DIR}/${config.serverType}-${config.version}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Java version requirements
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
    neoforge: ['1.21.4', '1.21.1', '1.20.4', '1.20.1'],
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
        log('Loaded latest versions');
    } catch (e) { log('Using cached versions'); }
}

function loadConfig() {
    try { 
        if (fs.existsSync(CONFIG_FILE)) {
            config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) {}
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

// Install Java (persisted - only downloads once)
async function installJava(version) {
    const urls = {
        8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u422-b05/OpenJDK8U-jre_x64_alpine-linux_hotspot_8u422b05.tar.gz',
        17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jre_x64_alpine-linux_hotspot_17.0.12_7.tar.gz',
        21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz'
    };
    const extractDirs = { 8: 'jdk8u422-b05-jre', 17: 'jdk-17.0.12+7-jre', 21: 'jdk-21.0.4+7-jre' };
    
    const dir = `${JAVA_DIR}/jre${version}`;
    
    // Already installed (persisted)
    if (fs.existsSync(dir + '/bin/java')) {
        log(`Java ${version} ready (cached)`);
        return true;
    }
    
    log(`Installing Java ${version}...`);
    status = 'installing';
    broadcast({ type: 'status', status, message: `Installing Java ${version}...` });
    
    try {
        const tmpFile = `/tmp/jre${version}.tar.gz`;
        execSync(`wget -q -O ${tmpFile} "${urls[version]}"`, { timeout: 300000 });
        execSync(`mkdir -p ${dir}`);
        execSync(`tar -xzf ${tmpFile} -C /tmp`);
        execSync(`mv /tmp/${extractDirs[version]}/* ${dir}/`);
        execSync(`rm -f ${tmpFile}`);
        log(`Java ${version} installed`);
        return true;
    } catch (e) { 
        log(`Java ${version} failed: ` + e.message); 
        status = 'error'; 
        return false; 
    }
}

async function getVanillaJarUrl(version) {
    try {
        if (vanillaManifest[version]) {
            const data = JSON.parse(execSync(`wget -qO- "${vanillaManifest[version]}"`, { timeout: 15000 }).toString());
            return data.downloads?.server?.url;
        }
        const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"', { timeout: 15000 }).toString());
        const info = manifest.versions.find(v => v.id === version);
        if (info) {
            const data = JSON.parse(execSync(`wget -qO- "${info.url}"`, { timeout: 15000 }).toString());
            return data.downloads?.server?.url;
        }
    } catch (e) {}
    return null;
}

// Download server (persisted - world and configs saved per server)
async function downloadServer() {
    const serverDir = getServerDir();
    const jarPath = serverDir + '/server.jar';
    
    // Already downloaded (persisted with world data)
    if (fs.existsSync(jarPath)) {
        log(`Server ${config.serverType} ${config.version} ready (cached)`);
        return true;
    }
    
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading';
    broadcast({ type: 'status', status, message: `Downloading ${config.serverType} ${config.version}...` });
    
    const javaDir = getJavaDir(config.version);
    
    try {
        if (config.serverType === 'vanilla') {
            const url = await getVanillaJarUrl(config.version);
            if (!url) throw new Error('Version not found');
            execSync(`wget -q -O "${jarPath}" "${url}"`, { timeout: 300000 });
            
        } else if (config.serverType === 'paper') {
            const builds = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}"`, { timeout: 15000 }).toString());
            const latestBuild = builds.builds[builds.builds.length - 1];
            const buildInfo = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${latestBuild}"`, { timeout: 15000 }).toString());
            const fileName = buildInfo.downloads.application.name;
            execSync(`wget -q -O "${jarPath}" "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${latestBuild}/downloads/${fileName}"`, { timeout: 300000 });
            
        } else if (config.serverType === 'neoforge') {
            log('Setting up NeoForge (takes a while)...');
            const nfVersions = JSON.parse(execSync('wget -qO- "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"', { timeout: 15000 }).toString());
            const mcVer = config.version.replace('1.', '');
            const nfVersion = nfVersions.versions.reverse().find(v => v.startsWith(mcVer));
            if (!nfVersion) throw new Error('NeoForge not available');
            
            execSync(`wget -q -O ${serverDir}/neoforge-installer.jar "https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/neoforge-${nfVersion}-installer.jar"`, { timeout: 180000 });
            execSync(`cd ${serverDir} && ${javaDir}/bin/java -jar neoforge-installer.jar --installServer`, { timeout: 600000 });
            execSync(`rm -f ${serverDir}/neoforge-installer.jar`);
            
        } else if (config.serverType === 'fabric') {
            const installerData = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/installer"', { timeout: 15000 }).toString());
            execSync(`wget -q -O ${serverDir}/fabric-installer.jar "${installerData[0]?.url}"`, { timeout: 120000 });
            execSync(`cd ${serverDir} && ${javaDir}/bin/java -jar fabric-installer.jar server -mcversion ${config.version} -downloadMinecraft`, { timeout: 300000 });
            if (fs.existsSync(serverDir + '/fabric-server-launch.jar')) {
                fs.renameSync(serverDir + '/fabric-server-launch.jar', jarPath);
            }
            execSync(`rm -f ${serverDir}/fabric-installer.jar`);
        }
        
        log('Download complete');
        return true;
    } catch (e) { 
        log('Download failed: ' + e.message); 
        status = 'error'; 
        return false; 
    }
}

function createConfigs() {
    const serverDir = getServerDir();
    
    // Only create if not exists (preserve user changes)
    if (!fs.existsSync(serverDir + '/eula.txt')) {
        fs.writeFileSync(serverDir + '/eula.txt', 'eula=true\n');
    }
    
    if (!fs.existsSync(serverDir + '/server.properties')) {
        fs.writeFileSync(serverDir + '/server.properties', `
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
level-name=world
`.trim());
    }
}

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    
    ensureDirs();
    logs = [];
    status = 'starting';
    broadcast({ type: 'status', status });
    broadcast({ type: 'logs', data: '' });
    
    const javaVersion = getJavaVersion(config.version);
    const javaDir = getJavaDir(config.version);
    const serverDir = getServerDir();
    
    log(`Starting ${config.serverType} ${config.version} (Java ${javaVersion})`);
    
    // Install Java if needed
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    
    // Download server if needed
    if (!await downloadServer()) return { error: 'Download failed' };
    
    // Create configs (only if not exist - preserves user configs)
    createConfigs();
    saveConfig();
    
    // Use max available memory
    const maxMem = 450;
    
    let cmd, args;
    if (config.serverType === 'neoforge' && fs.existsSync(serverDir + '/run.sh')) {
        cmd = '/bin/sh';
        args = ['run.sh', 'nogui'];
    } else {
        cmd = javaDir + '/bin/java';
        args = ['-Xms128M', `-Xmx${maxMem}M`, '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-jar', 'server.jar', 'nogui'];
    }
    
    mcProcess = spawn(cmd, args, { cwd: serverDir, env: { ...process.env, JAVA_HOME: javaDir } });
    
    mcProcess.stdout.on('data', handleOutput);
    mcProcess.stderr.on('data', handleOutput);
    
    mcProcess.on('close', (code) => {
        log(`Server stopped (exit ${code})`);
        status = 'stopped';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status });
        broadcast({ type: 'players', players });
    });
    
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
        if (join) { 
            const name = join[1] || join[2]; 
            if (!players.includes(name)) { 
                players.push(name); 
                broadcast({ type: 'players', players }); 
            } 
        }
        if (leave) { 
            players = players.filter(p => p !== leave[1]); 
            broadcast({ type: 'players', players }); 
        }
    });
}

function stopServer() {
    if (!mcProcess) return { error: 'Not running' };
    log('Stopping server...');
    status = 'stopping';
    broadcast({ type: 'status', status });
    mcProcess.stdin.write('stop\n');
    setTimeout(() => mcProcess && mcProcess.kill(), 15000);
    return { success: true };
}

async function restartServer() {
    if (mcProcess) { 
        stopServer(); 
        await new Promise(r => { 
            const i = setInterval(() => { 
                if (!mcProcess) { clearInterval(i); r(); } 
            }, 500); 
            setTimeout(() => { clearInterval(i); r(); }, 20000); 
        }); 
    }
    return startServer();
}

async function changeServer(newType, newVersion) {
    const wasRunning = !!mcProcess;
    
    if (wasRunning) { 
        stopServer(); 
        await new Promise(r => { 
            const i = setInterval(() => { 
                if (!mcProcess) { clearInterval(i); r(); } 
            }, 500); 
            setTimeout(() => { clearInterval(i); r(); }, 20000); 
        }); 
    }
    
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    log(`Switched to ${newType} ${newVersion}`);
    
    if (wasRunning) return startServer();
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// WebSocket
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', 
        status, 
        players, 
        config, 
        logs: logs.slice(-100),
        versions: cachedVersions
    }));
    ws.on('message', (msg) => { 
        try { 
            const { type, data } = JSON.parse(msg); 
            if (type === 'command') sendCommand(data); 
        } catch (e) {} 
    });
});

// API
app.get('/api/status', (req, res) => res.json({ status, players, config, logsCount: logs.length }));
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => { 
    const { serverType, version } = req.body; 
    if (!serverType || !version) return res.json({ error: 'Missing' }); 
    res.json(await changeServer(serverType, version)); 
});
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Dashboard on port ${PORT}`);
    ensureDirs();
    loadConfig();
    await loadVersions();
    
    // Auto-start if enabled
    if (config.autoStart) {
        log('Auto-starting server...');
        startServer();
    }
});

process.on('SIGTERM', () => { 
    if (mcProcess) {
        log('Saving and shutting down...');
        mcProcess.stdin.write('save-all\n');
        setTimeout(() => {
            mcProcess.stdin.write('stop\n');
            setTimeout(() => process.exit(0), 10000);
        }, 2000);
    } else {
        process.exit(0);
    }
});
