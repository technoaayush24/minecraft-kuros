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

const DATA_DIR = '/tmp/mcserver';
const JRE_DIR = '/tmp/jre';
const CONFIG_FILE = DATA_DIR + '/config.json';
const PLAYIT_DIR = '/tmp/playit';

let mcProcess = null;
let playitProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let playitAddress = null;
let config = {
    serverType: 'vanilla',
    version: '1.21.1',
    memory: 400,
    port: 25565
};

// All available versions
const ALL_VERSIONS = {
    vanilla: {
        '1.21.4': 'https://piston-data.mojang.com/v1/objects/4707d00eb834b446575d89a61a11b5d548d8c001/server.jar',
        '1.21.3': 'https://piston-data.mojang.com/v1/objects/45810d238246d90e811d896f87b14695b7fb6839/server.jar',
        '1.21.2': 'https://piston-data.mojang.com/v1/objects/7b20c02cb8df7b29e0c65b69e5eb2c81c4c3af79/server.jar',
        '1.21.1': 'https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar',
        '1.21': 'https://piston-data.mojang.com/v1/objects/450698d1863ab5180c25d7c804ef0fe6369dd1ba/server.jar',
        '1.20.6': 'https://piston-data.mojang.com/v1/objects/145ff0858209bcfc164571aac886be3afc085325/server.jar',
        '1.20.4': 'https://piston-data.mojang.com/v1/objects/8dd1a28015f51b1803213892b50b7b4fc76e594d/server.jar',
        '1.20.2': 'https://piston-data.mojang.com/v1/objects/5b868151bd02b41319f54c8d4061b8cae84e665c/server.jar',
        '1.20.1': 'https://piston-data.mojang.com/v1/objects/84194a2f286ef7c14ed7ce0090dba59902951553/server.jar',
        '1.20': 'https://piston-data.mojang.com/v1/objects/15c777e2cfe0556f19e4ed90cf77f330e94c1b1a/server.jar',
        '1.19.4': 'https://piston-data.mojang.com/v1/objects/8f3112a1049751cc472ec13e397eade5336ca7ae/server.jar',
        '1.19.3': 'https://piston-data.mojang.com/v1/objects/c9df48efed58511cdd0213c56b9013a7b5c9ac1f/server.jar',
        '1.19.2': 'https://piston-data.mojang.com/v1/objects/f69c284232d7c7580bd89a5a4931c3581eae1378/server.jar',
        '1.19.1': 'https://piston-data.mojang.com/v1/objects/8399e1211e95faa421c1507b322dbeae86d604df/server.jar',
        '1.19': 'https://piston-data.mojang.com/v1/objects/e00c4052dac1d59a1188b2aa9d5a87113aaf1122/server.jar',
        '1.18.2': 'https://piston-data.mojang.com/v1/objects/c8f83c5655308435b3dcf03c06d9fe8740a77469/server.jar',
        '1.18.1': 'https://piston-data.mojang.com/v1/objects/125e5adf40c659fd3bce3e66e67a16bb49ecc1b9/server.jar',
        '1.18': 'https://piston-data.mojang.com/v1/objects/3cf24a8694aca6267883b17d934efacc5e44440d/server.jar',
        '1.17.1': 'https://piston-data.mojang.com/v1/objects/a16d67e5807f57fc4e550299cf20226194497dc2/server.jar',
        '1.17': 'https://piston-data.mojang.com/v1/objects/0a269b5f2c5b93b1712d0f5dc43b6182b9ab254e/server.jar',
        '1.16.5': 'https://piston-data.mojang.com/v1/objects/1b557e7b033b583cd9f66746b7a9ab1ec1673ced/server.jar',
        '1.16.4': 'https://piston-data.mojang.com/v1/objects/35139deedbd5182953cf1caa23835da59ca3d7cd/server.jar',
        '1.15.2': 'https://piston-data.mojang.com/v1/objects/bb2b6b1aefcd70dfd1892149ac3a215f6c636b07/server.jar',
        '1.14.4': 'https://piston-data.mojang.com/v1/objects/3dc3d84a581f14691199cf6831b71ed1296a9fdf/server.jar',
        '1.12.2': 'https://piston-data.mojang.com/v1/objects/886945bfb2b978778c3a0288fd7fab09d315b25f/server.jar',
        '1.8.9': 'https://piston-data.mojang.com/v1/objects/b58b2ceb36e01bcd8dbf49c8fb66c55a9f0676cd/server.jar'
    },
    paper: {
        '1.21.4': 'https://api.purpurmc.org/v2/purpur/1.21.4/latest/download',
        '1.21.3': 'https://api.purpurmc.org/v2/purpur/1.21.3/latest/download',
        '1.21.1': 'https://api.purpurmc.org/v2/purpur/1.21.1/latest/download',
        '1.21': 'https://api.purpurmc.org/v2/purpur/1.21/latest/download',
        '1.20.6': 'https://api.purpurmc.org/v2/purpur/1.20.6/latest/download',
        '1.20.4': 'https://api.purpurmc.org/v2/purpur/1.20.4/latest/download',
        '1.20.2': 'https://api.purpurmc.org/v2/purpur/1.20.2/latest/download',
        '1.20.1': 'https://api.purpurmc.org/v2/purpur/1.20.1/latest/download',
        '1.19.4': 'https://api.purpurmc.org/v2/purpur/1.19.4/latest/download',
        '1.19.3': 'https://api.purpurmc.org/v2/purpur/1.19.3/latest/download',
        '1.19.2': 'https://api.purpurmc.org/v2/purpur/1.19.2/latest/download',
        '1.18.2': 'https://api.purpurmc.org/v2/purpur/1.18.2/latest/download',
        '1.17.1': 'https://api.purpurmc.org/v2/purpur/1.17.1/latest/download',
        '1.16.5': 'https://api.purpurmc.org/v2/purpur/1.16.5/latest/download'
    },
    fabric: {
        '1.21.4': 'fabric:1.21.4',
        '1.21.3': 'fabric:1.21.3',
        '1.21.1': 'fabric:1.21.1',
        '1.21': 'fabric:1.21',
        '1.20.6': 'fabric:1.20.6',
        '1.20.4': 'fabric:1.20.4',
        '1.20.1': 'fabric:1.20.1',
        '1.19.4': 'fabric:1.19.4',
        '1.18.2': 'fabric:1.18.2'
    },
    forge: {
        '1.20.1': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-installer.jar',
        '1.19.4': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.19.4-45.2.0/forge-1.19.4-45.2.0-installer.jar',
        '1.18.2': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.18.2-40.2.0/forge-1.18.2-40.2.0-installer.jar',
        '1.16.5': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39-installer.jar',
        '1.12.2': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859-installer.jar'
    }
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) {}
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

// Install Java
async function installJava() {
    if (fs.existsSync(JRE_DIR + '/bin/java')) return true;
    
    log('Downloading Java 21...');
    status = 'installing';
    broadcast({ type: 'status', status, message: 'Installing Java...' });
    
    try {
        execSync(`wget -q -O /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz"`, { timeout: 300000 });
        execSync(`mkdir -p ${JRE_DIR} && tar -xzf /tmp/jre.tar.gz -C /tmp && mv /tmp/jdk-21.0.4+7-jre/* ${JRE_DIR}/`);
        execSync('rm -f /tmp/jre.tar.gz');
        log('Java installed');
        return true;
    } catch (e) {
        log('ERROR: Java install failed - ' + e.message);
        status = 'error';
        return false;
    }
}

// Install playit.gg
async function installPlayit() {
    if (fs.existsSync(PLAYIT_DIR + '/playit')) return true;
    
    log('Installing playit.gg tunnel...');
    try {
        fs.mkdirSync(PLAYIT_DIR, { recursive: true });
        execSync(`wget -q -O ${PLAYIT_DIR}/playit.tar.gz "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64.tar.gz"`, { timeout: 120000 });
        execSync(`cd ${PLAYIT_DIR} && tar -xzf playit.tar.gz && chmod +x playit*`);
        log('playit.gg installed');
        return true;
    } catch (e) {
        log('playit.gg install failed: ' + e.message);
        return false;
    }
}

// Start playit tunnel
async function startPlayit() {
    if (playitProcess) return;
    
    if (!await installPlayit()) return;
    
    log('Starting playit.gg tunnel...');
    
    // Check for existing claim code or secret
    const secretFile = PLAYIT_DIR + '/playit.toml';
    
    playitProcess = spawn(PLAYIT_DIR + '/playit', ['--stdout'], {
        cwd: PLAYIT_DIR,
        env: process.env
    });
    
    playitProcess.stdout.on('data', (data) => {
        const text = data.toString();
        log('[playit] ' + text.trim());
        
        // Look for claim URL
        const claimMatch = text.match(/https:\/\/playit\.gg\/claim\/[a-zA-Z0-9-]+/);
        if (claimMatch) {
            playitAddress = claimMatch[0];
            broadcast({ type: 'playit', status: 'claim', url: playitAddress });
        }
        
        // Look for tunnel address
        const tunnelMatch = text.match(/(\w+\.ply\.gg:\d+)/);
        if (tunnelMatch) {
            playitAddress = tunnelMatch[1];
            broadcast({ type: 'playit', status: 'connected', address: playitAddress });
            log('Tunnel ready: ' + playitAddress);
        }
    });
    
    playitProcess.stderr.on('data', (data) => {
        log('[playit] ' + data.toString().trim());
    });
    
    playitProcess.on('close', () => {
        playitProcess = null;
        playitAddress = null;
        broadcast({ type: 'playit', status: 'stopped' });
    });
}

function stopPlayit() {
    if (playitProcess) {
        playitProcess.kill();
        playitProcess = null;
        playitAddress = null;
    }
}

// Download server
async function downloadServer() {
    const jarPath = DATA_DIR + '/server.jar';
    const urlData = ALL_VERSIONS[config.serverType]?.[config.version];
    
    if (!urlData) {
        log('ERROR: Version not found');
        return false;
    }
    
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading';
    broadcast({ type: 'status', status });
    
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
        
        if (config.serverType === 'fabric') {
            // Fabric installer
            const fabricInstaller = 'https://meta.fabricmc.net/v2/versions/installer';
            const installerData = JSON.parse(execSync(`wget -qO- "${fabricInstaller}"`).toString());
            const installerUrl = installerData[0]?.url;
            
            execSync(`wget -q -O ${DATA_DIR}/fabric-installer.jar "${installerUrl}"`, { timeout: 120000 });
            execSync(`cd ${DATA_DIR} && ${JRE_DIR}/bin/java -jar fabric-installer.jar server -mcversion ${config.version} -downloadMinecraft`, { timeout: 300000 });
            if (fs.existsSync(DATA_DIR + '/fabric-server-launch.jar')) {
                fs.renameSync(DATA_DIR + '/fabric-server-launch.jar', jarPath);
            }
        } else if (config.serverType === 'forge') {
            execSync(`wget -q -O ${DATA_DIR}/forge-installer.jar "${urlData}"`, { timeout: 180000 });
            log('Running Forge installer (this takes a while)...');
            execSync(`cd ${DATA_DIR} && ${JRE_DIR}/bin/java -jar forge-installer.jar --installServer`, { timeout: 600000 });
            // Find the forge jar
            const files = fs.readdirSync(DATA_DIR);
            const forgeJar = files.find(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer'));
            if (forgeJar) fs.renameSync(DATA_DIR + '/' + forgeJar, jarPath);
        } else {
            execSync(`wget -q -O "${jarPath}" "${urlData}"`, { timeout: 300000 });
        }
        
        log('Server downloaded');
        return true;
    } catch (e) {
        log('ERROR: Download failed - ' + e.message);
        status = 'error';
        return false;
    }
}

function createConfigs() {
    fs.writeFileSync(DATA_DIR + '/eula.txt', 'eula=true\n');
    fs.writeFileSync(DATA_DIR + '/server.properties', `
server-port=${config.port}
online-mode=false
max-players=20
view-distance=8
simulation-distance=6
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
    
    if (!await installJava()) return { error: 'Java failed' };
    
    const jarPath = DATA_DIR + '/server.jar';
    if (!fs.existsSync(jarPath)) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    
    createConfigs();
    saveConfig();
    
    log(`Starting ${config.serverType} ${config.version}...`);
    
    mcProcess = spawn(JRE_DIR + '/bin/java', [
        `-Xms${Math.floor(config.memory * 0.5)}M`,
        `-Xmx${config.memory}M`,
        '-XX:+UseG1GC',
        '-jar', 'server.jar', 'nogui'
    ], { cwd: DATA_DIR, env: { ...process.env, JAVA_HOME: JRE_DIR } });
    
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
    
    // Auto-start playit
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
        if (join) {
            const name = join[1] || join[2];
            if (!players.includes(name)) { players.push(name); broadcast({ type: 'players', players }); }
        }
        if (leave) {
            players = players.filter(p => p !== leave[1]);
            broadcast({ type: 'players', players });
        }
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
    if (mcProcess) {
        stopServer();
        await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); });
    }
    return startServer();
}

async function changeServer(newType, newVersion) {
    const wasRunning = !!mcProcess;
    if (wasRunning) {
        stopServer();
        await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); });
    }
    
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    // Delete old jar
    const jarPath = DATA_DIR + '/server.jar';
    if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    // Clean forge/fabric leftovers
    try { execSync(`rm -rf ${DATA_DIR}/libraries ${DATA_DIR}/mods ${DATA_DIR}/*.json ${DATA_DIR}/forge* ${DATA_DIR}/fabric*`); } catch(e){}
    
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

// WebSocket
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', 
        status, 
        players, 
        config, 
        logs: logs.slice(-100),
        playit: playitAddress ? { status: 'connected', address: playitAddress } : { status: 'stopped' },
        versions: Object.keys(ALL_VERSIONS).reduce((acc, type) => { acc[type] = Object.keys(ALL_VERSIONS[type]); return acc; }, {})
    }));
    
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'command') sendCommand(data);
        } catch (e) {}
    });
});

// API
app.get('/api/status', (req, res) => res.json({ status, players, config, playitAddress, logsCount: logs.length }));
app.get('/api/versions', (req, res) => res.json(Object.keys(ALL_VERSIONS).reduce((acc, type) => { acc[type] = Object.keys(ALL_VERSIONS[type]); return acc; }, {})));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => {
    const { serverType, version } = req.body;
    if (!serverType || !version) return res.json({ error: 'Missing params' });
    res.json(await changeServer(serverType, version));
});
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.post('/api/playit/start', async (req, res) => { await startPlayit(); res.json({ success: true }); });
app.post('/api/playit/stop', (req, res) => { stopPlayit(); res.json({ success: true }); });
app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    loadConfig();
    console.log(`Dashboard on port ${PORT}`);
    if (fs.existsSync(DATA_DIR + '/server.jar')) startServer();
});

process.on('SIGTERM', () => {
    if (mcProcess) mcProcess.stdin.write('stop\n');
    stopPlayit();
    setTimeout(() => process.exit(0), 10000);
});
