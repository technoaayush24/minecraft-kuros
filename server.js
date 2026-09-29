const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

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
    wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data)));
}

function log(msg) {
    const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
    console.log(line);
    mcLogs.push(line + '\n');
    if (mcLogs.length > 1000) mcLogs.shift();
    broadcast({ type: 'log', data: line + '\n' });
}

async function setup() {
    log('Starting setup...');
    if (!fs.existsSync(MC_DIR)) fs.mkdirSync(MC_DIR, { recursive: true });
    
    // Download JRE
    if (!fs.existsSync(JRE_DIR + '/bin/java')) {
        log('Downloading Java JRE 21 (Alpine)...');
        broadcast({ type: 'status', status: 'downloading', message: 'Downloading Java...' });
        try {
            execSync(`wget -q -O /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz"`, { timeout: 300000 });
            log('Extracting Java...');
            execSync(`mkdir -p ${JRE_DIR} && tar -xzf /tmp/jre.tar.gz -C /tmp && mv /tmp/jdk-21.0.4+7-jre/* ${JRE_DIR}/`, { timeout: 60000 });
            execSync('rm -f /tmp/jre.tar.gz');
            log('Java installed!');
        } catch (e) {
            log('ERROR: Java install failed - ' + e.message);
            mcStatus = 'error';
            return false;
        }
    } else {
        log('Java already installed');
    }
    
    // Download Purpur (Paper fork that works)
    const jarPath = MC_DIR + '/server.jar';
    if (!fs.existsSync(jarPath)) {
        log('Downloading Purpur MC 1.21.1...');
        broadcast({ type: 'status', status: 'downloading', message: 'Downloading Minecraft...' });
        try {
            execSync(`wget -q -O ${jarPath} "https://api.purpurmc.org/v2/purpur/1.21.1/2329/download"`, { timeout: 180000 });
            log('Minecraft server downloaded!');
        } catch (e) {
            log('ERROR: MC download failed - ' + e.message);
            mcStatus = 'error';
            return false;
        }
    } else {
        log('MC server already downloaded');
    }
    
    // Configs
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
motd=\\u00a7a\\u00a7lKuros\\u00a7r Minecraft
enable-command-block=true
max-tick-time=120000
`.trim());
    
    log('Setup complete!');
    return true;
}

function startMinecraft() {
    if (mcProcess) return;
    log('Starting Minecraft...');
    mcStatus = 'starting';
    broadcast({ type: 'status', status: 'starting' });
    
    mcProcess = spawn(JRE_DIR + '/bin/java', [
        '-Xms256M', '-Xmx400M', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui'
    ], { cwd: MC_DIR, env: { ...process.env, JAVA_HOME: JRE_DIR } });
    
    mcProcess.stdout.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if (!line.trim()) return;
            mcLogs.push(line + '\n');
            if (mcLogs.length > 1000) mcLogs.shift();
            broadcast({ type: 'log', data: line + '\n' });
            
            if (line.includes('Done') && line.includes('For help')) {
                mcStatus = 'running';
                log('SERVER READY!');
                broadcast({ type: 'status', status: 'running' });
            }
            
            const join = line.match(/(\w+)\[.*\] logged in/);
            const leave = line.match(/(\w+) left the game/);
            if (join && !players.includes(join[1])) { players.push(join[1]); broadcast({ type: 'players', players }); }
            if (leave) { players = players.filter(p => p !== leave[1]); broadcast({ type: 'players', players }); }
        });
    });
    
    mcProcess.stderr.on('data', (d) => { mcLogs.push(d.toString()); broadcast({ type: 'log', data: d.toString() }); });
    
    mcProcess.on('close', (code) => {
        log(`Server stopped (${code}). Restart in 5s...`);
        mcStatus = 'restarting';
        mcProcess = null;
        players = [];
        broadcast({ type: 'status', status: 'restarting' });
        broadcast({ type: 'players', players: [] });
        setTimeout(startMinecraft, 5000);
    });
}

function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Not ready' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: mcStatus }));
    ws.send(JSON.stringify({ type: 'players', players }));
    ws.send(JSON.stringify({ type: 'logs', data: mcLogs.slice(-200).join('') }));
    ws.on('message', (m) => { try { const {type,data}=JSON.parse(m); if(type==='command')sendCommand(data); } catch(e){} });
});

app.get('/api/status', (req, res) => res.json({ status: mcStatus, players, playerCount: players.length, logsCount: mcLogs.length, uptime: process.uptime() }));
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.get('/api/logs', (req, res) => res.json({ logs: mcLogs.slice(-(parseInt(req.query.count)||100)) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    log('Dashboard on port ' + PORT);
    if (await setup()) startMinecraft();
});

process.on('SIGTERM', () => { if(mcProcess) mcProcess.stdin.write('stop\n'); setTimeout(()=>process.exit(0),10000); });
