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

const MC_DIR = '/tmp/minecraft';
const JRE_DIR = '/tmp/jre';
let mcProcess = null;
let mcLogs = [];
let mcStatus = 'starting';
let players = [];

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function log(msg) {
    const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
    console.log(line);
    mcLogs.push(line + '\n');
    if (mcLogs.length > 1000) mcLogs.shift();
    broadcast({ type: 'log', data: line + '\n' });
}

// Download and setup everything
async function setup() {
    log('Starting setup...');
    
    if (!fs.existsSync(MC_DIR)) fs.mkdirSync(MC_DIR, { recursive: true });
    
    // Download JRE if needed
    if (!fs.existsSync(JRE_DIR + '/bin/java')) {
        log('Downloading Java JRE 21...');
        broadcast({ type: 'status', status: 'downloading', message: 'Downloading Java...' });
        
        try {
            // Use smaller musl JRE for Alpine
            execSync(`wget -q -O /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz"`, { 
                timeout: 300000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            log('Extracting Java...');
            execSync(`mkdir -p ${JRE_DIR} && tar -xzf /tmp/jre.tar.gz -C /tmp && mv /tmp/jdk-21.0.4+7-jre/* ${JRE_DIR}/`, { timeout: 60000 });
            execSync('rm -f /tmp/jre.tar.gz');
            log('Java installed!');
        } catch (e) {
            log('ERROR: Failed to install Java - ' + e.message);
            mcStatus = 'error';
            broadcast({ type: 'status', status: 'error', message: 'Java install failed' });
            return false;
        }
    } else {
        log('Java already installed');
    }
    
    // Download MC server if needed
    const jarPath = MC_DIR + '/server.jar';
    if (!fs.existsSync(jarPath)) {
        log('Downloading Minecraft Paper 1.21.1...');
        broadcast({ type: 'status', status: 'downloading', message: 'Downloading Minecraft...' });
        
        try {
            execSync(`wget -q -O ${jarPath} "https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/119/downloads/paper-1.21.1-119.jar"`, { 
                timeout: 180000 
            });
            log('Minecraft server downloaded!');
        } catch (e) {
            log('ERROR: Failed to download Minecraft - ' + e.message);
            mcStatus = 'error';
            broadcast({ type: 'status', status: 'error', message: 'MC download failed' });
            return false;
        }
    } else {
        log('Minecraft server already downloaded');
    }
    
    // Write configs
    fs.writeFileSync(MC_DIR + '/eula.txt', 'eula=true\n');
    fs.writeFileSync(MC_DIR + '/server.properties', `
server-port=25565
online-mode=false
max-players=20
view-distance=8
simulation-distance=6
spawn-protection=0
difficulty=normal
gamemode=survival
motd=\\u00a7a\\u00a7lKuros\\u00a7r Minecraft Server
enable-command-block=true
max-tick-time=120000
network-compression-threshold=256
`.trim());
    
    log('Setup complete!');
    return true;
}

// Start Minecraft server
function startMinecraft() {
    if (mcProcess) return;
    
    log('Starting Minecraft server...');
    mcStatus = 'starting';
    broadcast({ type: 'status', status: 'starting' });
    
    const javaPath = JRE_DIR + '/bin/java';
    
    mcProcess = spawn(javaPath, [
        '-Xms256M', '-Xmx400M',
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled', 
        '-XX:MaxGCPauseMillis=200',
        '-jar', 'server.jar', 'nogui'
    ], {
        cwd: MC_DIR,
        env: { ...process.env, JAVA_HOME: JRE_DIR }
    });
    
    mcProcess.stdout.on('data', (data) => {
        const text = data.toString();
        text.split('\n').forEach(line => {
            if (!line.trim()) return;
            mcLogs.push(line + '\n');
            if (mcLogs.length > 1000) mcLogs.shift();
            broadcast({ type: 'log', data: line + '\n' });
            
            // Server ready
            if (line.includes('Done') && line.includes('For help')) {
                mcStatus = 'running';
                log('SERVER IS READY!');
                broadcast({ type: 'status', status: 'running' });
            }
            
            // Player events
            const join = line.match(/(\w+)\[.*\] logged in/);
            const leave = line.match(/(\w+) left the game/);
            if (join && !players.includes(join[1])) {
                players.push(join[1]);
                broadcast({ type: 'players', players });
            }
            if (leave) {
                players = players.filter(p => p !== leave[1]);
                broadcast({ type: 'players', players });
            }
        });
    });
    
    mcProcess.stderr.on('data', (data) => {
        const text = data.toString();
        mcLogs.push(text);
        broadcast({ type: 'log', data: text });
    });
    
    mcProcess.on('close', (code) => {
        log(`Server stopped (code ${code}). Restarting in 5s...`);
        mcStatus = 'restarting';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status: 'restarting' });
        broadcast({ type: 'players', players: [] });
        
        // Auto-restart after 5 seconds
        setTimeout(startMinecraft, 5000);
    });
    
    mcProcess.on('error', (err) => {
        log('Process error: ' + err.message);
    });
}

// Send command to MC
function sendCommand(cmd) {
    if (!mcProcess || !mcProcess.stdin) return { error: 'Server not ready' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// WebSocket handler
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: mcStatus }));
    ws.send(JSON.stringify({ type: 'players', players }));
    ws.send(JSON.stringify({ type: 'logs', data: mcLogs.slice(-200).join('') }));
    
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'command' && data) {
                sendCommand(data);
            }
        } catch (e) {}
    });
});

// API endpoints
app.get('/api/status', (req, res) => {
    res.json({ 
        status: mcStatus, 
        players, 
        playerCount: players.length,
        logsCount: mcLogs.length,
        uptime: process.uptime()
    });
});

app.post('/api/command', (req, res) => {
    const cmd = req.body.cmd || req.body.command;
    if (!cmd) return res.json({ error: 'No command' });
    res.json(sendCommand(cmd));
});

app.get('/api/logs', (req, res) => {
    const count = parseInt(req.query.count) || 100;
    res.json({ logs: mcLogs.slice(-count) });
});

app.get('/health', (req, res) => res.send('OK'));

// Start everything
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    log(`Dashboard running on port ${PORT}`);
    log('Setting up Minecraft server...');
    
    const ready = await setup();
    if (ready) {
        startMinecraft();
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('Shutting down...');
    if (mcProcess) {
        mcProcess.stdin.write('stop\n');
        setTimeout(() => process.exit(0), 10000);
    } else {
        process.exit(0);
    }
});
