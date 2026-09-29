const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/console' });

app.use(express.json());
app.use(express.static('public'));

let mcProcess = null;
let mcLogs = [];
let mcStatus = 'stopped';
let players = [];
let setupInProgress = false;

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function log(msg) {
    console.log(msg);
    mcLogs.push(msg + '\n');
    broadcast({ type: 'log', data: msg + '\n' });
}

// Setup Java and MC server
async function setupServer() {
    if (setupInProgress) return false;
    setupInProgress = true;
    
    const mcDir = '/tmp/minecraft';
    const jreDir = '/tmp/jdk-21.0.4+7-jre';
    
    try {
        if (!fs.existsSync(mcDir)) {
            fs.mkdirSync(mcDir, { recursive: true });
        }
        
        // Check/Download Java
        if (!fs.existsSync(jreDir)) {
            log('[Setup] Downloading Java JRE 21 (this takes ~1 minute)...');
            mcStatus = 'downloading-java';
            broadcast({ type: 'status', status: mcStatus, message: 'Downloading Java...' });
            
            try {
                execSync('wget -q -O /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz"', { 
                    timeout: 180000,
                    stdio: 'inherit'
                });
                log('[Setup] Extracting Java...');
                execSync('cd /tmp && tar -xzf jre.tar.gz', { timeout: 60000 });
                log('[Setup] Java ready!');
            } catch (e) {
                log('[Setup] Failed to download Java: ' + e.message);
                mcStatus = 'error';
                setupInProgress = false;
                return false;
            }
        } else {
            log('[Setup] Java already installed');
        }
        
        // Download Minecraft server
        const serverJar = path.join(mcDir, 'server.jar');
        if (!fs.existsSync(serverJar)) {
            log('[Setup] Downloading Minecraft server (Paper 1.21.1)...');
            mcStatus = 'downloading-mc';
            broadcast({ type: 'status', status: mcStatus, message: 'Downloading Minecraft...' });
            
            try {
                execSync(`wget -q -O ${serverJar} "https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/119/downloads/paper-1.21.1-119.jar"`, { 
                    timeout: 120000 
                });
                log('[Setup] Minecraft server downloaded!');
            } catch (e) {
                log('[Setup] Failed to download MC: ' + e.message);
                mcStatus = 'error';
                setupInProgress = false;
                return false;
            }
        } else {
            log('[Setup] Minecraft server already downloaded');
        }
        
        // Create configs
        fs.writeFileSync(path.join(mcDir, 'eula.txt'), 'eula=true\n');
        fs.writeFileSync(path.join(mcDir, 'server.properties'), `
server-port=25565
online-mode=false
max-players=10
view-distance=6
simulation-distance=4
spawn-protection=0
difficulty=normal
gamemode=survival
motd=\\u00a7a\\u00a7lKuros\\u00a7r Minecraft Server
enable-command-block=true
max-tick-time=120000
`.trim());
        
        log('[Setup] Configuration ready!');
        setupInProgress = false;
        return true;
        
    } catch (e) {
        log('[Setup] Error: ' + e.message);
        mcStatus = 'error';
        setupInProgress = false;
        return false;
    }
}

// Start MC
async function startMC() {
    if (mcProcess) return { error: 'Already running' };
    if (setupInProgress) return { error: 'Setup in progress' };
    
    mcStatus = 'starting';
    mcLogs = [];
    broadcast({ type: 'status', status: mcStatus });
    
    const ready = await setupServer();
    if (!ready) return { error: 'Setup failed' };
    
    log('[Server] Starting Minecraft server...');
    
    const javaPath = '/tmp/jdk-21.0.4+7-jre/bin/java';
    const mcDir = '/tmp/minecraft';
    
    mcProcess = spawn(javaPath, ['-Xms256M', '-Xmx400M', '-jar', 'server.jar', 'nogui'], {
        cwd: mcDir,
        env: { ...process.env, JAVA_HOME: '/tmp/jdk-21.0.4+7-jre' }
    });
    
    mcProcess.stdout.on('data', (data) => {
        const line = data.toString();
        mcLogs.push(line);
        if (mcLogs.length > 500) mcLogs.shift();
        broadcast({ type: 'log', data: line });
        
        if (line.includes('Done') && line.includes('For help')) {
            mcStatus = 'running';
            broadcast({ type: 'status', status: 'running' });
        }
        
        const join = line.match(/(\w+) joined the game/);
        const leave = line.match(/(\w+) left the game/);
        if (join) { players.push(join[1]); broadcast({ type: 'players', players }); }
        if (leave) { players = players.filter(p => p !== leave[1]); broadcast({ type: 'players', players }); }
    });
    
    mcProcess.stderr.on('data', (data) => {
        const line = data.toString();
        mcLogs.push(line);
        broadcast({ type: 'log', data: line });
    });
    
    mcProcess.on('close', (code) => {
        mcStatus = 'stopped';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status: 'stopped' });
        broadcast({ type: 'players', players: [] });
    });
    
    return { success: true };
}

function stopMC() {
    if (!mcProcess) return { error: 'Not running' };
    mcStatus = 'stopping';
    broadcast({ type: 'status', status: 'stopping' });
    mcProcess.stdin.write('stop\n');
    setTimeout(() => { if (mcProcess) mcProcess.kill(); }, 10000);
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    return { success: true };
}

// WebSocket
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: mcStatus }));
    ws.send(JSON.stringify({ type: 'players', players }));
    ws.send(JSON.stringify({ type: 'logs', data: mcLogs.join('') }));
    
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'command') sendCommand(data);
        } catch (e) {}
    });
});

// API
app.get('/api/status', (req, res) => res.json({ status: mcStatus, players, logsCount: mcLogs.length }));
app.post('/api/start', async (req, res) => res.json(await startMC()));
app.post('/api/stop', (req, res) => res.json(stopMC()));
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.get('/api/logs', (req, res) => res.json({ logs: mcLogs.slice(-100) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Dashboard on ' + PORT));
