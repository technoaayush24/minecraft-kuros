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

// Broadcast to all WebSocket clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Setup and download server
async function setupServer() {
    const mcDir = '/tmp/minecraft';
    
    if (!fs.existsSync(mcDir)) {
        fs.mkdirSync(mcDir, { recursive: true });
    }
    
    // Check if Java is available
    try {
        execSync('java -version 2>&1');
        console.log('Java found');
    } catch (e) {
        console.log('Java not found, downloading...');
        mcStatus = 'downloading-java';
        broadcast({ type: 'status', status: mcStatus, message: 'Downloading Java...' });
        
        try {
            // Download portable JRE
            execSync('wget -q -O /tmp/jre.tar.gz https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz', { timeout: 120000 });
            execSync('cd /tmp && tar -xzf jre.tar.gz');
            process.env.JAVA_HOME = '/tmp/jdk-21.0.4+7-jre';
            process.env.PATH = `/tmp/jdk-21.0.4+7-jre/bin:${process.env.PATH}`;
            console.log('Java downloaded');
        } catch (e2) {
            console.error('Failed to download Java:', e2.message);
            mcStatus = 'error';
            broadcast({ type: 'status', status: 'error', message: 'Failed to download Java' });
            return false;
        }
    }
    
    // Download Minecraft server if not exists
    const serverJar = path.join(mcDir, 'server.jar');
    if (!fs.existsSync(serverJar)) {
        mcStatus = 'downloading-mc';
        broadcast({ type: 'status', status: mcStatus, message: 'Downloading Minecraft server...' });
        
        try {
            // Download Paper MC (lightweight)
            execSync(`wget -q -O ${serverJar} https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/119/downloads/paper-1.21.1-119.jar`, { timeout: 120000 });
            console.log('Minecraft server downloaded');
        } catch (e) {
            console.error('Failed to download MC:', e.message);
            mcStatus = 'error';
            broadcast({ type: 'status', status: 'error', message: 'Failed to download Minecraft' });
            return false;
        }
    }
    
    // Create eula.txt
    fs.writeFileSync(path.join(mcDir, 'eula.txt'), 'eula=true\n');
    
    // Create server.properties
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
    
    return true;
}

// Start Minecraft server
async function startMC() {
    if (mcProcess) {
        return { error: 'Server already running' };
    }
    
    mcStatus = 'starting';
    mcLogs = [];
    broadcast({ type: 'status', status: mcStatus, message: 'Setting up...' });
    
    const ready = await setupServer();
    if (!ready) return { error: 'Setup failed' };
    
    const mcDir = '/tmp/minecraft';
    const javaPath = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/java` : 'java';
    
    mcProcess = spawn(javaPath, ['-Xms256M', '-Xmx450M', '-jar', 'server.jar', 'nogui'], {
        cwd: mcDir,
        env: process.env
    });
    
    mcProcess.stdout.on('data', (data) => {
        const line = data.toString();
        mcLogs.push(line);
        if (mcLogs.length > 500) mcLogs.shift();
        broadcast({ type: 'log', data: line });
        
        // Detect server ready
        if (line.includes('Done') && line.includes('For help')) {
            mcStatus = 'running';
            broadcast({ type: 'status', status: 'running', message: 'Server is running!' });
        }
        
        // Detect player join/leave
        const joinMatch = line.match(/(\w+) joined the game/);
        const leaveMatch = line.match(/(\w+) left the game/);
        if (joinMatch) {
            players.push(joinMatch[1]);
            broadcast({ type: 'players', players });
        }
        if (leaveMatch) {
            players = players.filter(p => p !== leaveMatch[1]);
            broadcast({ type: 'players', players });
        }
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
        broadcast({ type: 'status', status: 'stopped', message: `Server stopped (code ${code})` });
        broadcast({ type: 'players', players: [] });
    });
    
    return { success: true };
}

// Stop server
function stopMC() {
    if (!mcProcess) return { error: 'Server not running' };
    
    mcStatus = 'stopping';
    broadcast({ type: 'status', status: 'stopping', message: 'Stopping server...' });
    mcProcess.stdin.write('stop\n');
    
    setTimeout(() => {
        if (mcProcess) {
            mcProcess.kill('SIGTERM');
        }
    }, 10000);
    
    return { success: true };
}

// Send command to MC
function sendCommand(cmd) {
    if (!mcProcess) return { error: 'Server not running' };
    mcProcess.stdin.write(cmd + '\n');
    return { success: true };
}

// WebSocket console
wss.on('connection', (ws) => {
    // Send current state
    ws.send(JSON.stringify({ type: 'status', status: mcStatus }));
    ws.send(JSON.stringify({ type: 'players', players }));
    ws.send(JSON.stringify({ type: 'logs', data: mcLogs.join('') }));
    
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'command') {
                sendCommand(data);
            }
        } catch (e) {}
    });
});

// API endpoints
app.get('/api/status', (req, res) => {
    res.json({ status: mcStatus, players, logsCount: mcLogs.length });
});

app.post('/api/start', async (req, res) => {
    res.json(await startMC());
});

app.post('/api/stop', (req, res) => {
    res.json(stopMC());
});

app.post('/api/command', (req, res) => {
    res.json(sendCommand(req.body.cmd || ''));
});

app.get('/api/logs', (req, res) => {
    res.json({ logs: mcLogs.slice(-100) });
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Dashboard on port ${PORT}`);
    console.log('Visit the dashboard to start the Minecraft server!');
});
