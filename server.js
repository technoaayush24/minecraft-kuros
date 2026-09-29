const { MongoClient } = require("mongodb");
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

const DATA_DIR = process.env.DATA_DIR || '/tmp/mcdata';
const SERVER_DIR = DATA_DIR + '/server';
const JAVA_DIR = DATA_DIR + '/java';
const BACKUPS_DIR = DATA_DIR + '/backups';
const CONFIG_FILE = DATA_DIR + '/config.json';

let mcProcess = null;
let tunnelProcess = null;
let logs = [];
let status = 'stopped';
let players = [];
let tunnelAddress = null;
let tunnelStatus = 'stopped';
let config = { serverType: 'vanilla', version: 'latest', port: 25565, autoStart: false };

// MongoDB for state persistence (config only, NOT big files)
let mongoClient = null, db = null;
const MONGO_URI = process.env.MONGODB_URI;
let autoSaveInterval = null;

function ensureDirs() {
    [DATA_DIR, SERVER_DIR, JAVA_DIR, BACKUPS_DIR, SERVER_DIR + '/plugins', SERVER_DIR + '/mods'].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

// === MongoDB Functions (state only) ===
async function connectMongo() {
    if (!MONGO_URI) { log('[MongoDB] No URI configured'); return false; }
    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db('minecraft_server');
        log('[MongoDB] Connected');
        return true;
    } catch (e) { log('[MongoDB] Failed: ' + e.message); return false; }
}

async function saveState() {
    if (!db) return;
    try {
        await db.collection('state').replaceOne({ _id: 'main' }, {
            _id: 'main', config, lastSave: new Date()
        }, { upsert: true });
        log('[State] Saved to MongoDB');
        broadcast({ type: 'log', data: '[State] Saved' });
    } catch (e) { log('[MongoDB] Save error: ' + e.message); }
}

async function loadState() {
    if (!db) return null;
    try {
        const s = await db.collection('state').findOne({ _id: 'main' });
        if (s) log('[MongoDB] State loaded from ' + s.lastSave);
        return s;
    } catch (e) { return null; }
}

function startAutoSave() {
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    autoSaveInterval = setInterval(async () => {
        if (status === 'running') {
            await saveState();
            await createCloudBackup(true); // auto backup to Pixxo
        }
    }, 10 * 60 * 1000);
    log('[AutoSave] Started (10 min: state->MongoDB, world->Pixxo)');
}
// === End MongoDB ===


function getJavaVersion(mcVersion) {
    // MC 26.1+ needs Java 25
    if (mcVersion.match(/^26\./)) return 25;
    
    // Parse 1.x.x versions
    const match = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!match) return 25; // Default to latest for unknown
    const minor = parseInt(match[1]) || 0;
    const patch = parseInt(match[2]) || 0;
    
    // Java 21: MC 1.20.5 - 1.21.x
    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    
    // Java 17: MC 1.18 - 1.20.4
    if (minor >= 18) return 17;
    if (minor === 20 && patch <= 4) return 17;
    
    // Java 16: MC 1.17.x
    if (minor === 17) return 16;
    
    // Java 8: MC 1.7 - 1.16.5
    return 8;
}

function getJavaDir(mcVersion) { return `${JAVA_DIR}/jre${getJavaVersion(mcVersion)}`; }

const ALL_VERSIONS = {
    vanilla: ['26.3', '26.2', '26.1', '26.0', '25.1', '25.0', '1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.9'],
    paper: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5'],
    fabric: ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2']
};

let cachedVersions = { ...ALL_VERSIONS };
let vanillaManifest = {};

async function loadVersions() {
    const snapshot26 = ['26.3', '26.2', '26.1', '26.0', '25.1', '25.0'];
    try {
        const manifest = JSON.parse(execSync('wget -qO- "https://launchermeta.mojang.com/mc/game/version_manifest.json"', { timeout: 15000 }).toString());
        const mojangVersions = manifest.versions.filter(v => v.type === 'release').map(v => v.id).slice(0, 30);
        cachedVersions.vanilla = [...snapshot26, ...mojangVersions];
        manifest.versions.forEach(v => { if (v.type === 'release') vanillaManifest[v.id] = v.url; });
        
        const paper = JSON.parse(execSync('wget -qO- "https://api.papermc.io/v2/projects/paper"', { timeout: 15000 }).toString());
        if (paper.versions) cachedVersions.paper = paper.versions.reverse().slice(0, 30);
        
        const fabric = JSON.parse(execSync('wget -qO- "https://meta.fabricmc.net/v2/versions/game"', { timeout: 15000 }).toString());
        if (fabric) cachedVersions.fabric = fabric.filter(v => v.stable).map(v => v.version).slice(0, 30);
        
        log('[Versions] Loaded: vanilla=' + cachedVersions.vanilla.length + ', paper=' + cachedVersions.paper.length + ', fabric=' + cachedVersions.fabric.length);
        
        // Set default to latest if config says 'latest'
        if (config.version === 'latest') {
            config.version = cachedVersions[config.serverType]?.[0] || '1.21.4';
            log('[Versions] Default set to ' + config.version);
        }
    } catch (e) {
        log('[Versions] Fetch failed: ' + e.message + ', using defaults');
        if (config.version === 'latest') config.version = cachedVersions[config.serverType]?.[0] || '1.21.4';
    }
}

function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {} }
function saveConfig() { ensureDirs(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

function broadcast(data) { wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data))); }

function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 500) logs.shift();
    broadcast({ type: 'log', data: line });
}

// ==================== BORE TUNNEL (Simple, no signup!) ====================
async function installBore() {
    const boreBin = DATA_DIR + '/bore';
    if (fs.existsSync(boreBin)) return true;
    log('Installing bore tunnel...');
    try {
        ensureDirs();
        execSync(`wget -q -O /tmp/bore.tar.gz "https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-unknown-linux-musl.tar.gz"`, { timeout: 60000 });
        execSync(`tar -xzf /tmp/bore.tar.gz -C ${DATA_DIR} && rm /tmp/bore.tar.gz`);
        execSync(`chmod +x ${boreBin}`);
        log('bore installed');
        return true;
    } catch (e) { 
        log('bore install failed: ' + e.message); 
        return false; 
    }
}

async function startTunnel() {
    if (tunnelProcess) {
        log('Tunnel already running');
        return;
    }
    
    if (!await installBore()) return;
    
    log('Starting tunnel...');
    tunnelStatus = 'starting';
    broadcast({ type: 'tunnel', status: tunnelStatus });
    
    const boreBin = DATA_DIR + '/bore';
    
    tunnelProcess = spawn(boreBin, ['local', '25565', '--to', 'bore.pub'], {
        cwd: DATA_DIR
    });
    
    tunnelProcess.stdout.on('data', (data) => {
        const text = data.toString();
        console.log('[bore]', text.trim());
        
        // Look for the address
        const match = text.match(/listening at ([^\s]+)/i);
        if (match) {
            tunnelAddress = match[1];
            tunnelStatus = 'connected';
            log('✅ CONNECT: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'connected', address: tunnelAddress });
        }
    });
    
    tunnelProcess.stderr.on('data', (data) => {
        const text = data.toString();
        console.log('[bore]', text.trim());
        
        const match = text.match(/listening at ([^\s]+)/i);
        if (match) {
            tunnelAddress = match[1];
            tunnelStatus = 'connected';
            log('✅ CONNECT: ' + tunnelAddress);
            broadcast({ type: 'tunnel', status: 'connected', address: tunnelAddress });
        }
        
        if (text.includes('error')) {
            log('[tunnel] ' + text.trim());
        }
    });
    
    tunnelProcess.on('close', (code) => {
        log(`Tunnel exited (${code})`);
        tunnelProcess = null;
        tunnelStatus = 'stopped';
        tunnelAddress = null;
        broadcast({ type: 'tunnel', status: 'stopped' });
    });
}

function stopTunnel() {
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    tunnelStatus = 'stopped'; 
    tunnelAddress = null;
    broadcast({ type: 'tunnel', status: 'stopped' });
}

// ==================== JAVA ====================
async function installJava(version) {
    const urls = {
        8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u422-b05/OpenJDK8U-jre_x64_alpine-linux_hotspot_8u422b05.tar.gz',
        16: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jre_x64_alpine-linux_hotspot_16.0.2_7.tar.gz',
        17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jre_x64_alpine-linux_hotspot_17.0.12_7.tar.gz',
        21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.4_7.tar.gz',
        25: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_alpine-linux_hotspot_25.0.4.1_1.tar.gz'
    };
    const extractDirs = { 8: 'jdk8u422-b05-jre', 16: 'jdk-16.0.2+7-jre', 17: 'jdk-17.0.12+7-jre', 21: 'jdk-21.0.4+7-jre', 25: 'jdk-25.0.4.1+1-jre' };
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
    if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    const javaDir = getJavaDir(config.version);
    try {
        if (config.serverType === 'vanilla') {
            const url = await getVanillaJarUrl(config.version);
            if (!url) throw new Error('Version not found');
            execSync(`wget -q -O "${jarPath}" "${url}"`, { timeout: 300000 });
        } else if (config.serverType === 'paper') {
            // PaperMC API v2 is sunset - scrape from downloads page
            log('Fetching Paper download URL from papermc.io...');
            const html = execSync(`wget -qO- "https://papermc.io/downloads/paper"`, { timeout: 30000 }).toString();
            const urlMatch = html.match(/https:\/\/fill-data\.papermc\.io\/v1\/objects\/[a-f0-9]+\/paper-[0-9.]+-\d+\.jar/);
            if (!urlMatch) throw new Error('Could not find Paper download URL');
            const paperUrl = urlMatch[0];
            log(`Found Paper URL: ${paperUrl}`);
            execSync(`wget -q -O "${jarPath}" "${paperUrl}"`, { timeout: 300000 });
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
max-tick-time=120000
white-list=false
enforce-whitelist=false
`);
}


// === Performance Optimization ===
const SPARK_URL = 'https://ci.lucko.me/job/spark/lastSuccessfulBuild/artifact/spark-bukkit/build/libs/spark-1.10.119-bukkit.jar';
const CLEARLAGG_URL = 'https://github.com/bob7l/ClearLag/releases/download/v3.2.2/ClearLag-3.2.2.jar';

async function installOptimizationPlugins() {
    if (config.serverType !== 'paper') return;
    const pluginsDir = SERVER_DIR + '/plugins';
    ensureDirs();
    
    // Install Spark if not exists
    const sparkExists = fs.readdirSync(pluginsDir).some(f => f.toLowerCase().includes('spark'));
    if (!sparkExists) {
        log('[Optimize] Installing Spark profiler...');
        try {
            execSync(`wget -q -O "${pluginsDir}/spark.jar" "${SPARK_URL}"`, { timeout: 60000 });
            log('[Optimize] Spark installed');
        } catch (e) { log('[Optimize] Spark install failed: ' + e.message); }
    }
    
    // Install ClearLagg if not exists
    const clearlaggExists = fs.readdirSync(pluginsDir).some(f => f.toLowerCase().includes('clearlag'));
    if (!clearlaggExists) {
        log('[Optimize] Installing ClearLagg...');
        try {
            execSync(`wget -q -O "${pluginsDir}/ClearLagg.jar" "${CLEARLAGG_URL}"`, { timeout: 60000 });
            log('[Optimize] ClearLagg installed');
        } catch (e) { log('[Optimize] ClearLagg install failed: ' + e.message); }
    }
}

function optimizeServerConfigs() {
    // Optimize server.properties
    const propsFile = SERVER_DIR + '/server.properties';
    if (fs.existsSync(propsFile)) {
        let props = fs.readFileSync(propsFile, 'utf8');
        // Reduce view distance for performance
        props = props.replace(/view-distance=\d+/, 'view-distance=6');
        props = props.replace(/simulation-distance=\d+/, 'simulation-distance=4');
        // Reduce max players if very high
        if (props.includes('max-players=20')) {
            props = props.replace(/max-players=\d+/, 'max-players=10');
        }
        fs.writeFileSync(propsFile, props);
        log('[Optimize] server.properties tuned');
    }
    
    // Optimize spigot.yml
    const spigotFile = SERVER_DIR + '/spigot.yml';
    if (fs.existsSync(spigotFile)) {
        let spigot = fs.readFileSync(spigotFile, 'utf8');
        // Reduce mob spawn ranges
        spigot = spigot.replace(/mob-spawn-range: \d+/, 'mob-spawn-range: 4');
        spigot = spigot.replace(/entity-activation-range:/, 'entity-activation-range:\n      animals: 16\n      monsters: 24\n      raiders: 48\n      misc: 8');
        fs.writeFileSync(spigotFile, spigot);
        log('[Optimize] spigot.yml tuned');
    }
    
    // Create/update bukkit.yml for chunk loading
    const bukkitFile = SERVER_DIR + '/bukkit.yml';
    if (fs.existsSync(bukkitFile)) {
        let bukkit = fs.readFileSync(bukkitFile, 'utf8');
        bukkit = bukkit.replace(/chunk-gc:[\s\S]*?period-in-ticks: \d+/, 'chunk-gc:\n  period-in-ticks: 400');
        fs.writeFileSync(bukkitFile, bukkit);
        log('[Optimize] bukkit.yml tuned');
    }
}

// === End Optimization ===

async function startServer() {
    if (mcProcess) return { error: 'Already running' };
    ensureDirs(); logs = []; status = 'starting';
    broadcast({ type: 'status', status });
    const javaVersion = getJavaVersion(config.version);
    const javaDir = getJavaDir(config.version);
    log(`Starting ${config.serverType} ${config.version}`);
    if (!await installJava(javaVersion)) return { error: 'Java failed' };
    if (!fs.existsSync(SERVER_DIR + '/server.jar')) {
        if (!await downloadServer()) return { error: 'Download failed' };
    }
    // Install optimization plugins for Paper
    // Optimize configs on every start
    setTimeout(() => optimizeServerConfigs(), 5000);
    if (config.serverType === "paper") {
        await installOptimizationPlugins();
    }
    createConfigs(); saveConfig();
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
    // Start tunnel automatically
    setTimeout(() => startTunnel(), 3000);
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
    log('Stopping...'); status = 'stopping';
    broadcast({ type: 'status', status });
    mcProcess.stdin.write('stop\n');
    setTimeout(() => mcProcess && mcProcess.kill(), 15000);
    stopTunnel();
    return { success: true };
}

async function restartServer() {
    if (mcProcess) { stopServer(); await new Promise(r => { const i = setInterval(() => { if (!mcProcess) { clearInterval(i); r(); } }, 500); setTimeout(() => { clearInterval(i); r(); }, 20000); }); }
    return startServer();
}

async function changeServer(newType, newVersion) {
    // Strict validation - version must be in our list
    const validVersions = cachedVersions[newType] || [];
    if (!validVersions.includes(newVersion)) {
        log(`❌ Invalid version: ${newType} ${newVersion}`);
        log(`Valid versions: ${validVersions.slice(0, 10).join(', ')}...`);
        return { error: 'Invalid version. Select from dropdown.' };
    }
    
    // Minecraft versions: old style (1.x.x) or new style (26.x)
    if (!newVersion.match(/^(1\.\d+|2[0-9]\.\d+)/)) {
        log(`❌ Invalid version format: ${newVersion}`);
        return { error: 'Invalid version format' };
    }
    
    // Don't change if same version
    if (config.serverType === newType && config.version === newVersion) {
        log('Already on this version');
        return { success: true, message: 'Already on this version' };
    }
    
    const wasRunning = !!mcProcess;
    
    // Force stop server if running
    if (mcProcess) {
        log('Stopping server for version change...');
        status = 'stopping';
        broadcast({ type: 'status', status });
        
        // Try graceful stop first
        try { mcProcess.stdin.write('stop\n'); } catch(e) {}
        
        // Wait max 15 seconds for graceful stop
        let waited = 0;
        while (mcProcess && waited < 15000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        
        // Force kill if still running
        if (mcProcess) {
            log('Force stopping server...');
            try { mcProcess.kill('SIGKILL'); } catch(e) {}
            mcProcess = null;
        }
        
        // Wait for process cleanup
        await new Promise(r => setTimeout(r, 2000));
        status = 'stopped';
        broadcast({ type: 'status', status });
    }
    
    // Auto-backup world before version change
    const worldDir = SERVER_DIR + '/world';
    if (fs.existsSync(worldDir)) {
    const backupName = (isAuto ? 'auto-' : '') + `${config.serverType}-${config.version}-${new Date().toISOString().slice(0,10)}-${timestamp}`;
        try {
            // Remove old backup with same name if exists
            try { execSync(`rm -rf ${BACKUPS_DIR}/${backupName}`); } catch(e) {}
            execSync(`cp -r ${worldDir} ${BACKUPS_DIR}/${backupName}`);
            log(`📦 Auto-backup: ${backupName}`);
        } catch(e) {
            log('Backup warning: ' + e.message);
        }
    }
    
    // Update config
    const oldVersion = config.version;
    config.serverType = newType;
    config.version = newVersion;
    saveConfig();
    
    // Clean up server files BUT KEEP THE WORLD
    log(`Switching ${oldVersion} → ${newVersion}...`);
    try { fs.unlinkSync(SERVER_DIR + '/server.jar'); } catch(e) {}
    try { execSync(`rm -rf ${SERVER_DIR}/.fabric ${SERVER_DIR}/libraries ${SERVER_DIR}/.mixin* ${SERVER_DIR}/versions ${SERVER_DIR}/*.json 2>/dev/null || true`); } catch(e) {}
    
    log(`✓ Ready for ${newType} ${newVersion}`);
    
    if (wasRunning) {
        await new Promise(r => setTimeout(r, 1000));
        return startServer();
    }
    return { success: true };
}

function sendCommand(cmd) {
    if (!mcProcess?.stdin) return { error: 'Not running' };
    mcProcess.stdin.write(cmd + '\n');
    log('> ' + cmd);
    return { success: true };
}

// ==================== WORLD ====================
function backupWorld() {
    const worldDir = SERVER_DIR + '/world';
    if (!fs.existsSync(worldDir)) return { error: 'No world' };
    const name = `world-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    try { execSync(`cp -r ${worldDir} ${BACKUPS_DIR}/${name}`); log(`Backup: ${name}`); return { success: true, name }; } 
    catch (e) { return { error: 'Failed' }; }
}

function listBackups() {
    try {
        return fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith('world-')).map(name => {
            const stat = fs.statSync(BACKUPS_DIR + '/' + name);
            return { name, date: stat.mtime };
        }).sort((a, b) => b.date - a.date);
    } catch (e) { return []; }
}

function restoreBackup(name) {
    if (mcProcess) return { error: 'Stop server first' };
    if (!fs.existsSync(BACKUPS_DIR + '/' + name)) return { error: 'Not found' };
    try { execSync(`rm -rf ${SERVER_DIR}/world && cp -r ${BACKUPS_DIR}/${name} ${SERVER_DIR}/world`); log(`Restored: ${name}`); return { success: true }; } 
    catch (e) { return { error: 'Failed' }; }
}

function deleteBackup(name) { try { execSync(`rm -rf ${BACKUPS_DIR}/${name}`); return { success: true }; } catch (e) { return { error: 'Failed' }; } }

function resetWorld() {
    if (mcProcess) return { error: 'Stop server first' };
    try { execSync(`rm -rf ${SERVER_DIR}/world ${SERVER_DIR}/world_nether ${SERVER_DIR}/world_the_end`); log('World reset'); return { success: true }; } 
    catch (e) { return { error: 'Failed' }; }
}

// ==================== FILES ====================
function listFiles(subpath = '') {
    const dir = path.join(SERVER_DIR, subpath);
    if (!dir.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try {
        const items = fs.readdirSync(dir).map(name => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, path: path.join(subpath, name), isDir: stat.isDirectory(), size: stat.size };
        }).sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
        return { items, path: subpath };
    } catch (e) { return { error: 'Cannot read' }; }
}

function readFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try { return { content: fs.readFileSync(filePath, 'utf8'), path: subpath }; } catch (e) { return { error: 'Cannot read' }; }
}

function writeFile(subpath, content) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try { fs.writeFileSync(filePath, content); log(`Saved: ${subpath}`); return { success: true }; } catch (e) { return { error: 'Cannot write' }; }
}

function deleteFile(subpath) {
    const filePath = path.join(SERVER_DIR, subpath);
    if (!filePath.startsWith(SERVER_DIR)) return { error: 'Invalid' };
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) execSync(`rm -rf "${filePath}"`); else fs.unlinkSync(filePath);
        return { success: true };
    } catch (e) { return { error: 'Cannot delete' }; }
}

// ==================== PLUGINS ====================
function listPlugins() {
    const plugins = fs.existsSync(SERVER_DIR + '/plugins') ? fs.readdirSync(SERVER_DIR + '/plugins').filter(f => f.endsWith('.jar')) : [];
    const mods = fs.existsSync(SERVER_DIR + '/mods') ? fs.readdirSync(SERVER_DIR + '/mods').filter(f => f.endsWith('.jar')) : [];
    return { plugins, mods };
}

async function installPlugin(url, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fileName = url.split('/').pop().split('?')[0] || 'plugin.jar';
    try { log(`Installing: ${fileName}...`); execSync(`wget -q -O "${dir}/${fileName}" "${url}"`, { timeout: 120000 }); log(`Installed: ${fileName}`); return { success: true, name: fileName }; } 
    catch (e) { return { error: 'Failed' }; }
}

function removePlugin(name, type = 'plugin') {
    const dir = type === 'mod' ? SERVER_DIR + '/mods' : SERVER_DIR + '/plugins';
    try { fs.unlinkSync(dir + '/' + name); log(`Removed: ${name}`); return { success: true }; } catch (e) { return { error: 'Failed' }; }
}

// ==================== ROUTES ====================
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ 
        type: 'init', status, players, config, logs: logs.slice(-100), versions: cachedVersions,
        tunnel: { status: tunnelStatus, address: tunnelAddress }
    }));
    ws.on('message', (msg) => { try { const { type, data } = JSON.parse(msg); if (type === 'command') sendCommand(data); } catch (e) {} });
});

app.get('/api/status', (req, res) => res.json({ status, players, config, tunnel: { status: tunnelStatus, address: tunnelAddress } }));
app.post('/api/save-state', async (req, res) => { await saveState(); res.json({ message: 'State saved' }); });
app.post('/api/optimize', async (req, res) => {
    await installOptimizationPlugins();
    optimizeServerConfigs();
    res.json({ message: 'Optimization plugins installed and configs tuned. Restart server to apply.' });
});
app.get('/api/versions', (req, res) => res.json(cachedVersions));
app.post('/api/start', async (req, res) => res.json(await startServer()));
app.post('/api/stop', (req, res) => res.json(stopServer()));
app.post('/api/restart', async (req, res) => res.json(await restartServer()));
app.post('/api/change', async (req, res) => res.json(await changeServer(req.body.serverType, req.body.version)));
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.cmd || '')));
app.post('/api/tunnel/start', async (req, res) => { await startTunnel(); res.json({ success: true }); });
app.post('/api/tunnel/stop', (req, res) => { stopTunnel(); res.json({ success: true }); });

app.post('/api/world/backup', (req, res) => res.json(backupWorld()));
app.get('/api/world/backups', (req, res) => res.json(listBackups()));
app.post('/api/world/restore', (req, res) => res.json(restoreBackup(req.body.name)));
app.post('/api/world/delete-backup', (req, res) => res.json(deleteBackup(req.body.name)));
app.post('/api/world/reset', (req, res) => res.json(resetWorld()));

app.get('/api/files', (req, res) => res.json(listFiles(req.query.path || '')));
app.get('/api/files/read', (req, res) => res.json(readFile(req.query.path)));
app.post('/api/files/write', (req, res) => res.json(writeFile(req.body.path, req.body.content)));
app.post('/api/files/delete', (req, res) => res.json(deleteFile(req.body.path)));

app.get('/api/plugins', (req, res) => res.json(listPlugins()));
app.post('/api/plugins/install', async (req, res) => res.json(await installPlugin(req.body.url, req.body.type)));
app.post('/api/plugins/remove', (req, res) => res.json(removePlugin(req.body.name, req.body.type)));

app.get('/api/logs', (req, res) => res.json({ logs: logs.slice(-(parseInt(req.query.count) || 100)) }));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Dashboard on port ${PORT}`);
    ensureDirs(); loadConfig(); await loadVersions();
    const mongoOk = await connectMongo();
    if (mongoOk) {
        const s = await loadState();
        if (s?.config) { config = { ...config, ...s.config }; saveConfig(); log("[Startup] Config restored from MongoDB"); }
        startAutoSave();
    }
    if (config.autoStart) { log("Auto-starting..."); startServer(); }
});

process.on("SIGTERM", async () => {
    await saveState();
    if (mcProcess) { mcProcess.stdin.write("save-all\n"); setTimeout(() => mcProcess?.stdin.write("stop\n"), 2000); }
    stopTunnel();
    if (mongoClient) await mongoClient.close();
    setTimeout(() => process.exit(0), 12000);
});

// ==================== PIXXO CLOUD BACKUP ====================
const Pixxo = require('@sarangkale66/pixxo-sdk-node');
const archiver = require('archiver');

const pixxo = new Pixxo({
    email: process.env.PIXXO_EMAIL || "",
    password: process.env.PIXXO_PASSWORD || ""
});

const CLOUD_INDEX_FILE = DATA_DIR + '/cloud_backups.json';

function loadCloudIndex() {
    try {
        if (fs.existsSync(CLOUD_INDEX_FILE)) {
            return JSON.parse(fs.readFileSync(CLOUD_INDEX_FILE, 'utf8'));
        }
    } catch(e) {}
    return [];
}

function saveCloudIndex(index) {
    ensureDirs();
    fs.writeFileSync(CLOUD_INDEX_FILE, JSON.stringify(index, null, 2));
}

async function createCloudBackup(isAuto = false) {
    const worldDir = SERVER_DIR + '/world';
    if (!fs.existsSync(worldDir)) return { error: 'No world to backup' };
    
    log('☁️ Creating cloud backup...');
    broadcast({ type: 'log', data: '☁️ Compressing world...' });
    
    const timestamp = Date.now();
    const backupName = (isAuto ? 'auto-' : '') + `${config.serverType}-${config.version}-${new Date().toISOString().slice(0,10)}-${timestamp}`;
    const zipPath = `/tmp/mc-${timestamp}.zip`;
    
    // Snapshot metadata
    const snapshot = {
        timestamp,
        date: new Date().toISOString(),
        serverType: config.serverType,
        version: config.version,
        plugins: fs.existsSync(SERVER_DIR + '/plugins') ? fs.readdirSync(SERVER_DIR + '/plugins').filter(f => f.endsWith('.jar')) : [],
        mods: fs.existsSync(SERVER_DIR + '/mods') ? fs.readdirSync(SERVER_DIR + '/mods').filter(f => f.endsWith('.jar')) : []
    };
    
    try {
        // Create zip
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(worldDir, 'world');
            archive.append(JSON.stringify(snapshot, null, 2), { name: 'snapshot.json' });
            if (fs.existsSync(SERVER_DIR + '/server.properties')) {
                archive.file(SERVER_DIR + '/server.properties', { name: 'server.properties' });
            }
            archive.finalize();
        });
        
        broadcast({ type: 'log', data: '☁️ Uploading to cloud...' });
        
        // Upload to Pixxo
        const result = await pixxo.upload({
            file: fs.readFileSync(zipPath),
            fileName: `${backupName}.zip`,
            folder: "/minecraft-backups"
        });
        
        // Save to local index
        const index = loadCloudIndex();
        index.unshift({
            name: backupName,
            fileId: result.fileId,
            url: result.url,
            snapshot,
            uploadedAt: new Date().toISOString()
        });
        // Keep only 5 auto backups, delete old ones from Pixxo
        if (isAuto) {
            const autoBackups = index.filter(b => b.name.startsWith("auto-"));
            while (autoBackups.length > 5) {
                const old = autoBackups.pop();
                try { await pixxo.deleteFile(old.fileId); log("☁️ Deleted old auto: " + old.name); } catch(e) {}
                const i = index.findIndex(x => x.fileId === old.fileId);
                if (i >= 0) index.splice(i, 1);
            }
        }
        
        // Cleanup
        try { fs.unlinkSync(zipPath); } catch(e) {}
        
        log('☁️ Backup uploaded: ' + backupName);
        return { success: true, name: backupName };
    } catch (e) {
        log('☁️ Upload failed: ' + e.message);
        try { fs.unlinkSync(zipPath); } catch(x) {}
        return { error: e.message };
    }
}

function listCloudBackups() {
    return loadCloudIndex();
}

async function restoreCloudBackup(fileId) {
    if (mcProcess) return { error: 'Stop server first' };
    
    const index = loadCloudIndex();
    const backup = index.find(b => b.fileId === fileId);
    if (!backup) return { error: 'Backup not found' };
    
    log('☁️ Downloading backup...');
    broadcast({ type: 'log', data: '☁️ Downloading from cloud...' });
    
    try {
        const zipPath = `/tmp/restore-${Date.now()}.zip`;
        const extractDir = `/tmp/restore-${Date.now()}`;
        
        // Download
        execSync(`wget -q -O "${zipPath}" "${backup.url}"`, { timeout: 300000 });
        
        // Extract
        execSync(`mkdir -p ${extractDir} && unzip -q ${zipPath} -d ${extractDir}`);
        
        // Backup current world first
        if (fs.existsSync(SERVER_DIR + '/world')) {
            const localBackup = `world-before-restore-${Date.now()}`;
            execSync(`cp -r ${SERVER_DIR}/world ${BACKUPS_DIR}/${localBackup}`);
            log('📦 Local backup: ' + localBackup);
        }
        
        // Restore world
        execSync(`rm -rf ${SERVER_DIR}/world && mv ${extractDir}/world ${SERVER_DIR}/`);
        
        // Restore settings
        if (fs.existsSync(`${extractDir}/server.properties`)) {
            fs.copyFileSync(`${extractDir}/server.properties`, SERVER_DIR + '/server.properties');
        }
        
        // Update config
        if (backup.snapshot) {
            config.serverType = backup.snapshot.serverType;
            config.version = backup.snapshot.version;
            saveConfig();
        }
        
        // Cleanup
        execSync(`rm -rf ${extractDir} ${zipPath}`);
        
        log('☁️ Restored: ' + backup.name);
        return { success: true, backup };
    } catch (e) {
        log('☁️ Restore failed: ' + e.message);
        return { error: e.message };
    }
}

async function deleteCloudBackup(fileId) {
    try {
        await pixxo.deleteFile(fileId);
        const index = loadCloudIndex().filter(b => b.fileId !== fileId);
        saveCloudIndex(index);
        log('☁️ Deleted cloud backup');
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
}

// Cloud routes
app.post('/api/cloud/backup', async (req, res) => res.json(await createCloudBackup()));
app.get('/api/cloud/list', (req, res) => res.json(listCloudBackups()));
app.post('/api/cloud/restore', async (req, res) => res.json(await restoreCloudBackup(req.body.fileId)));
app.post('/api/cloud/delete', async (req, res) => res.json(await deleteCloudBackup(req.body.fileId)));
