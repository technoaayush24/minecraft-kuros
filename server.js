const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const DATA_DIR = '/tmp/mcdata';
const SERVER_DIR = DATA_DIR + '/server';
const JAVA_DIR = DATA_DIR + '/java';
const BACKUPS_DIR = DATA_DIR + '/backups';

let mcProcess = null;
let tunnelProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let tunnelAddress = null;
let tunnelStatus = 'stopped';
let config = { serverType: 'vanilla', version: '1.21.4', port: 25565 };

const ALL_VERSIONS = {
    vanilla: ['26.3', '26.2', '26.1', '26.0', '25.1', '25.0', '1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.9'],
    paper: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5'],
    fabric: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2']
};
let cachedVersions = { ...ALL_VERSIONS };

function ensureDirs() {
    [DATA_DIR, SERVER_DIR, JAVA_DIR, BACKUPS_DIR, SERVER_DIR + '/plugins', SERVER_DIR + '/mods'].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function getJavaVersion(mcVersion) {
    if (mcVersion.match(/^2[56]\./)) return 25;
    const m = mcVersion.match(/^1\.(\d+)/);
    if (!m) return 21;
    const minor = parseInt(m[1]);
    if (minor >= 21) return 21;
    if (minor >= 18) return 17;
    if (minor >= 17) return 16;
    return 8;
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

async function installJava(version) {
    const javaDir = `${JAVA_DIR}/jre${version}`;
    if (fs.existsSync(javaDir + '/bin/java')) return true;
    log(`Installing Java ${version}...`);
    status = 'installing'; broadcast({ type: 'status', status });
    try {
        const urls = {
            8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u412-b08/OpenJDK8U-jre_x64_linux_hotspot_8u412b08.tar.gz',
            16: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jre_x64_linux_hotspot_16.0.2_7.tar.gz',
            17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.11%2B9/OpenJDK17U-jre_x64_linux_hotspot_17.0.11_9.tar.gz',
            21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.3%2B9/OpenJDK21U-jre_x64_linux_hotspot_21.0.3_9.tar.gz',
            25: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25%2B3-ea-beta/OpenJDK25U-jre_x64_linux_hotspot_25_3-ea.tar.gz'
        };
        execSync(`mkdir -p ${javaDir} && wget -qO- "${urls[version]}" | tar xz -C ${javaDir} --strip-components=1`, { timeout: 300000 });
        log(`Java ${version} installed`);
        return true;
    } catch (e) {
        log(`Java install failed: ${e.message}`);
        return false;
    }
}

async function downloadServer() {
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading'; broadcast({ type: 'status', status });
    try {
        let url;
        if (config.serverType === 'vanilla') {
            const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"').toString());
            const ver = manifest.versions.find(v => v.id === config.version);
            if (!ver) throw new Error('Version not found');
            const verData = JSON.parse(execSync(`wget -qO- "${ver.url}"`).toString());
            url = verData.downloads.server.url;
        } else if (config.serverType === 'paper') {
            const builds = JSON.parse(execSync(`wget -qO- "https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds"`).toString());
            const build = builds.builds[builds.builds.length - 1];
            url = `https://api.papermc.io/v2/projects/paper/versions/${config.version}/builds/${build.build}/downloads/${build.downloads.application.name}`;
        } else if (config.serverType === 'fabric') {
            const loaders = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/loader"').toString());
            const installers = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/installer"').toString());
            url = `https://meta.fabricmc.net/v2/versions/loader/${config.version}/${loaders[0].version}/${installers[0].version}/server/jar`;
        }
        execSync(`wget -qO "${SERVER_DIR}/server.jar" "${url}"`, { timeout: 300000 });
        log('Download complete');
        return true;
    } catch (e) {
        log(`Download failed: ${e.message}`);
        return false;
    }
}

function createConfigs() {
    const props = `server-port=${config.port}
online-mode=false
white-list=false
enforce-whitelist=false
enable-command-block=true
max-players=20
motd=Minecraft Server
`;
    fs.writeFileSync(SERVER_DIR + '/server.properties', props);
    fs.writeFileSync(SERVER_DIR + '/eula.txt', 'eula=true');
}

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    ensureDirs(); logs = []; status = 'starting';
    broadcast({ type: 'status', status });
    
    const javaVersion = getJavaVersion(config.version);
    const javaDir = `${JAVA_DIR}/jre${javaVersion}`;
    log(`Starting ${config.serverType} ${config.version} (Java ${javaVersion})`);
    
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    if (!fs.existsSync(SERVER_DIR + '/server.jar')) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    createConfigs();
    
    mcProcess = spawn(javaDir + '/bin/java', ['-Xms128M', '-Xmx380M', '-jar', 'server.jar', 'nogui'], { cwd: SERVER_DIR });
    mcProcess.stdout.on('data', d => d.toString().split('\n').filter(l => l.trim()).forEach(l => {
        logs.push(l); broadcast({ type: 'log', data: l });
        if (l.includes('Done')) { status = 'running'; broadcast({ type: 'status', status }); }
        const join = l.match(/(\w+) joined the game/);
        const leave = l.match(/(\w+) left the game/);
        if (join && !players.includes(join[1])) { players.push(join[1]); broadcast({ type: 'players', players }); }
        if (leave) { players = players.filter(p => p !== leave[1]); broadcast({ type: 'players', players }); }
    }));
    mcProcess.stderr.on('data', d => d.toString().split('\n').filter(l => l.trim()).forEach(l => { logs.push(l); broadcast({ type: 'log', data: l }); }));
    mcProcess.on('close', () => { status = 'stopped'; mcProcess = null; players = []; broadcast({ type: 'status', status }); broadcast({ type: 'players', players }); });
    
    return { success: true };
}

function stopServer() {
    if (!mcProcess) return { error: 'Not running' };
    log('Stopping server...');
    mcProcess.stdin.write('stop\n');
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    return { success: true };
}

async function changeVersion(type, version) {
    if (mcProcess) { stopServer(); await new Promise(r => setTimeout(r, 5000)); }
    config.serverType = type;
    config.version = version;
    fs.rmSync(SERVER_DIR + '/server.jar', { force: true });
    log(`Changed to ${type} ${version}`);
    return { success: true };
}

async function startTunnel() {
    if (tunnelProcess) return { error: 'Already running' };
    const boreBin = DATA_DIR + '/bore';
    if (!fs.existsSync(boreBin)) {
        log('Installing bore...');
        try {
            execSync(`wget -qO- "https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-unknown-linux-musl.tar.gz" | tar xz -C ${DATA_DIR}`, { timeout: 60000 });
            execSync(`chmod +x ${boreBin}`);
        } catch (e) { return { error: 'Bore install failed' }; }
    }
    tunnelProcess = spawn(boreBin, ['local', config.port.toString(), '--to', 'bore.pub']);
    tunnelStatus = 'connecting'; broadcast({ type: 'tunnel', status: tunnelStatus, address: null });
    tunnelProcess.stdout.on('data', d => {
        const m = d.toString().match(/bore\.pub:(\d+)/);
        if (m) { tunnelAddress = `bore.pub:${m[1]}`; tunnelStatus = 'connected'; broadcast({ type: 'tunnel', status: tunnelStatus, address: tunnelAddress }); log(`Tunnel: ${tunnelAddress}`); }
    });
    tunnelProcess.on('close', () => { tunnelProcess = null; tunnelStatus = 'stopped'; tunnelAddress = null; broadcast({ type: 'tunnel', status: tunnelStatus, address: null }); });
    return { success: true };
}

function stopTunnel() {
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    tunnelStatus = 'stopped'; tunnelAddress = null;
    return { success: true };
}

// Routes
app.get('/api/status', (req, res) => res.json({ status, players, config, tunnel: { status: tunnelStatus, address: tunnelAddress } }));
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.command)));
app.post('/api/change', async (req, res) => res.json(await changeVersion(req.body.serverType, req.body.version)));
app.post('/api/tunnel/start', async (req, res) => res.json(await startTunnel()));
app.post('/api/tunnel/stop', (req, res) => res.json(stopTunnel()));

// WebSocket
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', status, players, config, logs: logs.slice(-100), versions: cachedVersions, tunnel: { status: tunnelStatus, address: tunnelAddress } }));
    ws.on('message', msg => { try { const { type, data } = JSON.parse(msg); if (type === 'command') sendCommand(data); } catch (e) {} });
});

server.listen(3000, () => { console.log('Dashboard on port 3000'); ensureDirs(); });
