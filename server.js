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

let mcProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let config = {
    serverType: 'vanilla',
    version: '1.21.1',
    memory: 400,
    port: 25565
};

// Load config
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

// Get download URLs for different server types
function getServerUrl(type, version) {
    const urls = {
        vanilla: {
            '1.21.1': 'https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar',
            '1.21': 'https://piston-data.mojang.com/v1/objects/450698d1863ab5180c25d7c804ef0fe6369dd1ba/server.jar',
            '1.20.6': 'https://piston-data.mojang.com/v1/objects/145ff0858209bcfc164571aac886be3afc085325/server.jar',
            '1.20.4': 'https://piston-data.mojang.com/v1/objects/8dd1a28015f51b1803213892b50b7b4fc76e594d/server.jar',
            '1.20.2': 'https://piston-data.mojang.com/v1/objects/5b868151bd02b41319f54c8d4061b8cae84e665c/server.jar',
            '1.20.1': 'https://piston-data.mojang.com/v1/objects/84194a2f286ef7c14ed7ce0090dba59902951553/server.jar',
            '1.19.4': 'https://piston-data.mojang.com/v1/objects/8f3112a1049751cc472ec13e397eade5336ca7ae/server.jar',
            '1.18.2': 'https://piston-data.mojang.com/v1/objects/c8f83c5655308435b3dcf03c06d9fe8740a77469/server.jar'
        },
        paper: {
            '1.21.1': 'https://api.purpurmc.org/v2/purpur/1.21.1/latest/download',
            '1.21': 'https://api.purpurmc.org/v2/purpur/1.21/latest/download',
            '1.20.6': 'https://api.purpurmc.org/v2/purpur/1.20.6/latest/download',
            '1.20.4': 'https://api.purpurmc.org/v2/purpur/1.20.4/latest/download',
            '1.20.2': 'https://api.purpurmc.org/v2/purpur/1.20.2/latest/download',
            '1.20.1': 'https://api.purpurmc.org/v2/purpur/1.20.1/latest/download',
            '1.19.4': 'https://api.purpurmc.org/v2/purpur/1.19.4/latest/download',
            '1.18.2': 'https://api.purpurmc.org/v2/purpur/1.18.2/latest/download'
        },
        forge: {
            '1.20.1': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
            '1.19.4': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.19.4-45.2.0/forge-1.19.4-45.2.0-installer.jar',
            '1.18.2': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.18.2-40.2.0/forge-1.18.2-40.2.0-installer.jar'
        }
    };
    return urls[type]?.[version] || urls.vanilla['1.21.1'];
}

function getAvailableVersions(type) {
    const versions = {
        vanilla: ['1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.18.2'],
        paper: ['1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.18.2'],
        forge: ['1.20.1', '1.19.4', '1.18.2']
    };
    return versions[type] || versions.vanilla;
}

// Install Java
async function installJava() {
    if (fs.existsSync(JRE_DIR + '/bin/java')) {
        log('Java already installed');
        return true;
    }
    
    log('Downloading Java 21...');
    status = 'installing';
    broadcast({ type: 'status', status, message: 'Installing Java...' });
    
    try {
        execSync(`wget -q -O /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz"`, { timeout: 300000 });
        execSync(`mkdir -p ${JRE_DIR} && tar -xzf /tmp/jre.tar.gz -C /tmp && mv /tmp/jdk-21.0.4+7-jre/* ${JRE_DIR}/`);
        execSync('rm -f /tmp/jre.tar.gz');
        log('Java installed successfully');
        return true;
    } catch (e) {
        log('ERROR: Java installation failed - ' + e.message);
        status = 'error';
        broadcast({ type: 'status', status, message: 'Java install failed' });
        return false;
    }
}

// Download server
async function downloadServer() {
    const jarPath = DATA_DIR + '/server.jar';
    const url = getServerUrl(config.serverType, config.version);
    
    log(`Downloading ${config.serverType} ${config.version}...`);
    status = 'downloading';
    broadcast({ type: 'status', status, message: `Downloading ${config.serverType}...` });
    
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        
        // Remove old jar
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
        
        execSync(`wget -q -O "${jarPath}" "${url}"`, { timeout: 300000 });
        
        // For forge, need to run installer
        if (config.serverType === 'forge') {
            log('Running Forge installer...');
            execSync(`cd ${DATA_DIR} && java -jar server.jar --installServer`, { timeout: 600000 });
        }
        
        log('Server downloaded successfully');
        return true;
    } catch (e) {
        log('ERROR: Download failed - ' + e.message);
        status = 'error';
        broadcast({ type: 'status', status, message: 'Download failed' });
        return false;
    }
}

// Create server config files
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

// Start server
async function startServer() {
    if (mcProcess) {
        log('Server already running');
        return { error: 'Already running' };
    }
    
    logs = [];
    status = 'starting';
    broadcast({ type: 'status', status });
    broadcast({ type: 'logs', data: '' });
    
    // Install Java if needed
    if (!await installJava()) return { error: 'Java install failed' };
    
    // Download server if needed
    const jarPath = DATA_DIR + '/server.jar';
    if (!fs.existsSync(jarPath)) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    
    createConfigs();
    saveConfig();
    
    log(`Starting ${config.serverType} ${config.version}...`);
    
    const javaArgs = [
        `-Xms${Math.floor(config.memory * 0.5)}M`,
        `-Xmx${config.memory}M`,
        '-XX:+UseG1GC',
        '-jar', 'server.jar', 'nogui'
    ];
    
    mcProcess = spawn(JRE_DIR + '/bin/java', javaArgs, {
        cwd: DATA_DIR,
        env: { ...process.env, JAVA_HOME: JRE_DIR }
    });
    
    mcProcess.stdout.on('data', handleOutput);
    mcProcess.stderr.on('data', handleOutput);
    
    mcProcess.on('close', (code) => {
        log(`Server stopped (exit code: ${code})`);
        status = 'stopped';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status });
        broadcast({ type: 'players', players });
    });
    
    mcProcess.on('error', (err) => {
        log('Process error: ' + err.message);
        status = 'error';
        broadcast({ type: 'status', status });
    });
    
    return { success: true };
}

function handleOutput(data) {
    const text = data.toString();
    text.split('\n').forEach(line => {
        if (!line.trim()) return;
        logs.push(line);
        if (logs.length > 500) logs.shift();
        broadcast({ type: 'log', data: line });
        
        // Detect server ready
        if (line.includes('Done') && line.includes('For help')) {
            status = 'running';
            log('Server is ready!');
            broadcast({ type: 'status', status });
        }
        
        // Track players
        const join = line.match(/(\w+)\[.*?\] logged in|(\w+) joined the game/);
        const leave = line.match(/(\w+) left the game/);
        if (join) {
            const name = join[1] || join[2];
            if (!players.includes(name)) {
                players.push(name);
                broadcast({ type: 'players', players });
            }
        }
        if (leave && players.includes(leave[1])) {
            players = players.filter(p => p !== leave[1]);
            broadcast({ type: 'players', players });
        }
    });
}

// Stop server
function stopServer() {
    if (!mcProcess) return { error: 'Not running' };
    
    log('Stopping server...');
    status = 'stopping';
    broadcast({ type: 'status', status });
    
    mcProcess.stdin.write('stop\n');
    
    setTimeout(() => {
        if (mcProcess) {
            mcProcess.kill('SIGTERM');
            setTimeout(() => mcProcess && mcProcess.kill('SIGKILL'), 5000);
        }
    }, 15000);
    
    return { success: true };
}

// Restart server
async function restartServer() {
    if (mcProcess) {
        stopServer();
        // Wait for stop
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!mcProcess) { clearInterval(check); resolve(); }
            }, 500);
            setTimeout(() => { clearInterval(check); resolve(); }, 20000);
        });
    }
    return startServer();
}

// Change server type/version
async function changeServer(newType, newVersion) {
    const wasRunning = !!mcProcess;
    
    if (wasRunning) {
        stopServer();
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!mcProcess) { clearInterval(check); resolve(); }
            }, 500);
            setTimeout(() => { clearInterval(check); resolve(); }, 20000);
        });
    }
    
    // Update config
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    // Delete old server jar to force re-download
    const jarPath = DATA_DIR + '/server.jar';
    if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    
    log(`Changed to ${newType} ${newVersion}`);
    
    if (wasRunning) {
        return startServer();
    }
    
    return { success: true };
}

// Send command
function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Server not running' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// WebSocket
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', status, players, config, logs: logs.slice(-100) }));
    
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'command') sendCommand(data);
        } catch (e) {}
    });
});

// API
app.get('/api/status', (req, res) => {
    res.json({ status, players, config, logsCount: logs.length, uptime: process.uptime() });
});

app.get('/api/versions', (req, res) => {
    const type = req.query.type || 'vanilla';
    res.json({ versions: getAvailableVersions(type) });
});

app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));

app.post('/api/change', async (req, res) => {
    const { serverType, version } = req.body;
    if (!serverType || !version) return res.json({ error: 'Missing params' });
    res.json(await changeServer(serverType, version));
});

app.post('/api/command', (req, res) => {
    res.json(sendCommand(req.body.cmd || ''));
});

app.get('/api/logs', (req, res) => {
    res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) });
});

app.get('/health', (req, res) => res.send('OK'));

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    loadConfig();
    console.log(`Dashboard running on port ${PORT}`);
    // Auto-start if was running before
    if (fs.existsSync(DATA_DIR + '/server.jar')) {
        startServer();
    }
});

process.on('SIGTERM', () => {
    if (mcProcess) mcProcess.stdin.write('stop\n');
    setTimeout(() => process.exit(0), 10000);
});
