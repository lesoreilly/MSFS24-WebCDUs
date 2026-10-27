/**
 * z-DementedMonkey-LiM-CDU hub. Modified from dementedmonkey/cj4-mcdu (GPL-3), 2026-10-10.
 *
 *   HTTP     httpPort   (browser page, default 8126)
 *   WS       simPort    (sim + browser, default 8088)
 *   WS       relayPort  (hardware / SPAD, default 8089; 0 = off)
 *   host     relayIp    (the PC where SPAD is listening)
 *   WS       winCtrlPort (MobiFlight WinCtrl ingest, 8320; 0 = off)
 *            winCtrlExporter (auto follows the aircraft title; off = no readers)
 *
 * The sim connects in on simPort. This hub then connects out to
 * relayIp:relayPort and speaks as the plane: mcduConnected, then the
 * same update and key messages. SPAD listens. The hub dials.
 *
 * WinCtrl: hub listens on :8320. winCtrlExporter=auto starts the matching
 * screen reader for planes that have no LiM WEBSOCKETS page. Do not run
 * MobiFlight Connector as the WinCtrl *server* while winCtrlPort is on.
 *
 * Ports: cdu-server.cfg, then environment (LIM_HTTP_PORT / LIM_WS_PORT /
 * LIM_RELAY_PORT / LIM_RELAY_IP / LIM_WINCTRL_PORT / LIM_WINCTRL_EXPORTER),
 * then CLI flags.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { URL } = require('url');
const { WebSocketServer, WebSocket, OPEN } = require('ws');
const winctrl = require('./server/winctrl');
const exporters = require('./server/exporters');

const publicDir = path.join(__dirname, 'public');
const cfgPath = path.join(__dirname, 'cdu-server.cfg');

function readCfg(file) {
  const cfg = {
    httpPort: 8126,
    simPort: 8088,
    relayPort: 8089,
    relayIp: '127.0.0.1',
    winCtrlPort: 8320,
    winCtrlPlaneTag: 'auto',
    winCtrlAircraft: '',
    winCtrlExporter: 'auto',
    mobiFlightDir: '',
  };
  if (!fs.existsSync(file)) {
    return cfg;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'httpPort') cfg.httpPort = Number(value);
    if (key === 'simPort' || key === 'websocketPort') cfg.simPort = Number(value);
    if (key === 'relayPort') cfg.relayPort = Number(value);
    if (key === 'relayIp' || key === 'relayHost') cfg.relayIp = value;
    if (key === 'winCtrlPort') cfg.winCtrlPort = Number(value);
    if (key === 'winCtrlPlaneTag' || key === 'winCtrlTag') cfg.winCtrlPlaneTag = value;
    if (key === 'winCtrlAircraft') cfg.winCtrlAircraft = value;
    if (key === 'winCtrlExporter' || key === 'winCtrlExporters') cfg.winCtrlExporter = value;
    if (key === 'mobiFlightDir' || key === 'mobiflightDir') cfg.mobiFlightDir = value;
  }
  return cfg;
}

function relayHostOr(value, fallback) {
  const host = String(value == null ? '' : value).trim();
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) return fallback;
  return host;
}

function portOr(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback;
  return n;
}

const cfg = readCfg(cfgPath);
let httpPort = portOr(process.env.LIM_HTTP_PORT, cfg.httpPort);
let simPort = portOr(process.env.LIM_WS_PORT, cfg.simPort);
let relayPort = portOr(process.env.LIM_RELAY_PORT, cfg.relayPort);
let relayIp = relayHostOr(process.env.LIM_RELAY_IP, cfg.relayIp || '127.0.0.1');
let winCtrlPort = portOr(process.env.LIM_WINCTRL_PORT, cfg.winCtrlPort);
let winCtrlPlaneTag = String(process.env.LIM_WINCTRL_PLANE_TAG || cfg.winCtrlPlaneTag || 'auto').trim() || 'auto';
let winCtrlAircraft = String(process.env.LIM_WINCTRL_AIRCRAFT || cfg.winCtrlAircraft || '').trim();
let observedAircraft = '';
let observedLivery = '';
let winCtrlExporter = String(process.env.LIM_WINCTRL_EXPORTER || cfg.winCtrlExporter || '').trim();
let mobiFlightDir = String(process.env.LIM_MOBIFLIGHT_DIR || cfg.mobiFlightDir || '').trim();
let exporterChildren = [];
let exporterLabels = [];
let exporterHost = null;
let activeWinCtrlExporter = '';
let keyBridge = null;
let lastWinCtrlProtocolLog = '';

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--http-port=')) httpPort = portOr(arg.split('=')[1], httpPort);
  else if (arg.startsWith('--sim-port=') || arg.startsWith('--websocket-port=')) simPort = portOr(arg.split('=')[1], simPort);
  else if (arg.startsWith('--relay-port=')) relayPort = portOr(arg.split('=')[1], relayPort);
  else if (arg.startsWith('--relay-ip=')) relayIp = relayHostOr(arg.split('=').slice(1).join('='), relayIp);
  else if (arg.startsWith('--winctrl-port=')) winCtrlPort = portOr(arg.split('=')[1], winCtrlPort);
  else if (arg.startsWith('--winctrl-plane-tag=')) winCtrlPlaneTag = arg.split('=').slice(1).join('=') || winCtrlPlaneTag;
  else if (arg.startsWith('--winctrl-aircraft=')) winCtrlAircraft = arg.split('=').slice(1).join('=') || winCtrlAircraft;
  else if (arg.startsWith('--winctrl-exporter=')) winCtrlExporter = arg.split('=').slice(1).join('=') || winCtrlExporter;
  else if (arg.startsWith('--mobiflight-dir=')) mobiFlightDir = arg.split('=').slice(1).join('=') || mobiFlightDir;
  else if (arg === '--help' || arg === '-h') {
    console.log('node index.js [--http-port=N] [--sim-port=N] [--relay-port=N] [--relay-ip=ADDR]');
    console.log('             [--winctrl-port=N] [--winctrl-exporter=auto]');
    console.log('relay-port=0 disables the hardware relay.');
    console.log('winctrl-port=0 disables WinCtrl ingest. The MobiFlight port is 8320.');
    console.log('winctrl-exporter=auto follows the loaded aircraft. off turns readers off.');
    console.log('SPAD listens on relay-ip:relay-port. This hub connects out and speaks as the plane.');
    process.exit(0);
  } else {
    console.error('Unknown argument: ' + arg);
    process.exit(1);
  }
}

if (!httpPort || !simPort) {
  console.error('httpPort and simPort must be 1-65535.');
  process.exit(1);
}
if (relayPort && (relayPort === simPort || relayPort === httpPort)) {
  console.error('relayPort must be different from httpPort and simPort.');
  process.exit(1);
}
if (winCtrlPort && (winCtrlPort === simPort || winCtrlPort === httpPort || winCtrlPort === relayPort)) {
  console.error('winCtrlPort must be different from httpPort, simPort, and relayPort.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
};

function localIpv4s() {
  const skip = /virtual|vethernet|vmware|vbox|loopback|wsl|bluetooth|hyper-v|default switch/i;
  const preferred = [];
  const other = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      const family = info.family === 4 || info.family === 'IPv4';
      if (!family || info.internal || !info.address || info.address.startsWith('169.254.')) continue;
      const row = { name, address: info.address };
      if (skip.test(name)) other.push(row);
      else preferred.push(row);
    }
  }
  return preferred.length ? preferred : other;
}

function href(url) {
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

function checkFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.end();
      reject(new Error('Port ' + port + ' is already in use.'));
    });
    socket.on('error', () => resolve());
  });
}

const blankScreen = { lines: [], scratchpad: '', message: '', title: '', titleLeft: '', page: '', exec: false, power: false };
const powerOffMessage = 'update:*:' + JSON.stringify({ left: blankScreen, right: blankScreen });

const servers = [];
const extraClients = new Set();

function sendSafe(client, text) {
  if (!client || client.readyState !== OPEN) return;
  try { client.send(text); } catch (_e) { /* drop broken sockets */ }
}

function screenProtocol(text) {
  if (text.indexOf('update:') !== 0) return '';
  const colon = text.indexOf(':', 7);
  if (colon < 0) return '';
  const protocol = text.slice(7, colon);
  if (!protocol || protocol === '*') return '';
  return protocol;
}

/** SPAD already drives these screens itself. The hub must not also feed them. */
const SPAD_OWNS = {
  'wt737/ascrj': true,
  'wt737/pmdg737': true,
  'wt737/pmdg777': true,
  'wt737/fenix': true,
  'wt737/fbw': true,
  'wt737/ifly737': true,
};

function spadOwnsScreen(protocol) {
  return !!(protocol && SPAD_OWNS[protocol]);
}

function holdRelayForSpad() {
  if (relayHeldForSpad && extraClients.size === 0 && !relayOutTimer) return;
  relayHeldForSpad = true;
  relayProtocol = '';
  if (relayOutTimer) {
    clearTimeout(relayOutTimer);
    relayOutTimer = null;
  }
  let dropped = false;
  for (const client of Array.from(extraClients)) {
    dropped = true;
    client._limNoReconnect = true;
    extraClients.delete(client);
    try { client.close(); } catch (_e) { /* close follows */ }
  }
  if (dropped) console.log('Relay left to SPAD');
}

function fanout(message, skip) {
  const text = Buffer.isBuffer(message) ? message.toString() : String(message);
  for (const wss of servers) {
    for (const client of wss.clients) {
      if (client !== skip) sendSafe(client, text);
    }
  }
  // SPAD picks a screen parser from the first update on a socket and keeps it.
  // A new protocol needs a new connection. The fresh socket sends the snapshot.
  const protocol = screenProtocol(text);
  if (spadOwnsScreen(protocol)) {
    holdRelayForSpad();
    return;
  }
  if (relayHeldForSpad && protocol) {
    relayHeldForSpad = false;
    if (extraClients.size === 0 && !relayOutTimer) connectRelayOut();
  }
  if (retargetRelay(protocol)) return;
  for (const client of extraClients) {
    if (client !== skip) sendSafe(client, text);
  }
}

/** Relay-only send (SPAD). Does not touch browser/sim sockets. */
function fanoutRelay(message) {
  const text = Buffer.isBuffer(message) ? message.toString() : String(message);
  if (spadOwnsScreen(screenProtocol(text))) return;
  for (const client of extraClients) sendSafe(client, text);
}

/**
 * WinCtrl readers publish `wt737/<planeTag>`. Some SPAD profiles still bind to
 * bare `wt737`. Sim-socket planes already send `wt21` or `wt737/<mod>` and
 * are forwarded unchanged.
 */
function relayAliasUpdate(dm) {
  const text = String(dm || '');
  const m = /^update:(wt737\/[^:]+):/.exec(text);
  if (!m) return null;
  return 'update:wt737:' + text.slice(m[0].length);
}

function sendRelaySnapshot(ws) {
  if (!lastFromSim || spadOwnsScreen(screenProtocol(lastFromSim))) return;
  sendSafe(ws, lastFromSim);
  if (!lastFromSimViaWinCtrl) return;
  const alias = relayAliasUpdate(lastFromSim);
  if (alias) sendSafe(ws, alias);
}

let simClients = 0;
let lastFromSim = '';
let lastFromSimViaWinCtrl = false;
let winCtrlClients = 0;
let winCtrlAnnounced = false;
let resolvedWinCtrlTag = winCtrlPlaneTag === 'auto' ? 'winctrl' : winctrl.normalizePlaneTag(winCtrlPlaneTag);
/** When a winCtrlExporter is running (e.g. atr), Font hints must not steal the tag
 *  (ATR scripts send AirbusThales, which would otherwise map to fenix). */
let exporterLockedTag = '';
let lastFontHint = '';

function roleOf(text) {
  if (text === 'mcduConnected' || text.indexOf('update:') === 0) return 'sim';
  if (text === 'requestUpdate' || text.indexOf('event:') === 0) return 'browser';
  return null;
}

function aircraftIdent(title, livery) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  const paint = String(livery || '').replace(/\s+/g, ' ').trim();
  let base = '';
  if (text) {
    const type = text.match(/\b(737-(?:600|700|800|900)(?:ER)?|777-(?:200(?:ER|LR)?|300ER)|777-?F|CRJ-?(?:550|700|900|1000)|A300(?:-600)?|ATR[\s-]?(?:42|72))\b/i);
    const variation = text.match(/\b(BBJ?\d+|BCF|BDSF)\b/i);
    if (!type) base = text;
    else {
      const name = type[1].toUpperCase().replace(/\s+/g, '');
      base = variation ? name + ' ' + variation[1].toUpperCase() : name;
    }
  }
  if (!paint) return base;
  const hay = (text + ' ' + base).toUpperCase();
  if (hay.indexOf(paint.toUpperCase()) >= 0) return base;
  return base ? base + ' ' + paint : paint;
}

function planeFromUpdate(text) {
  if (text.indexOf('update:') !== 0) return null;
  const colon = text.indexOf(':', 7);
  if (colon < 0) return null;
  const protocol = text.slice(7, colon);
  if (!protocol || protocol === '*') return null;
  let aircraft = '';
  let face = '';
  try {
    const json = JSON.parse(text.slice(colon + 1));
    aircraft = String(json.aircraft || '').trim();
    if (json.face === '4in' || json.face === '5in') face = json.face;
  } catch (e) {
    return null;
  }
  const kind = protocol === 'wt737/wt747' ? '747'
    : protocol === 'wt737/uns1' ? 'UNS-1'
    : protocol === 'wt737' ? '737'
    : protocol.indexOf('wt737/') === 0 ? protocol.slice(6).toUpperCase()
    : protocol === 'wt21' ? 'WT21'
    : protocol;
  const family = kind + (face ? ' ' + face : '');
  const label = aircraft && family ? aircraft + ' — ' + family : (aircraft || family);
  return label || null;
}

function attachMirror(wss, label) {
  wss.on('connection', (ws) => {
    let role = label === 'relay' ? 'relay' : null;
    let plane = '';
    if (role === 'relay') console.log('Relay connected');
    ws.on('message', (message) => {
      const text = message.toString();
      if (!role) {
        role = roleOf(text);
        if (role === 'sim') {
          simClients += 1;
          console.log('Sim connected');
        } else if (role === 'browser') {
          console.log('Browser connected');
        }
      }
      if (role === 'sim' && text.indexOf('update:') === 0) {
        lastFromSim = text;
        lastFromSimViaWinCtrl = false;
        const next = planeFromUpdate(text);
        if (next && next !== plane) {
          plane = next;
          console.log('Aircraft: ' + plane);
        }
      }
      // When only WinCtrl is feeding screens, answer browser refresh ourselves.
      // Each live frame is one CDU, so replay both cached sides. Sending only
      // the latest frame leaves the other CDU blank until its text changes.
      if (text === 'requestUpdate' && simClients === 0 && ws.readyState === OPEN) {
        const cachedLeft = lastWinCtrlDm.left;
        const cachedRight = lastWinCtrlDm.right;
        if (cachedLeft || cachedRight) {
          if (cachedLeft) sendSafe(ws, cachedLeft);
          if (cachedRight) sendSafe(ws, cachedRight);
        } else if (lastFromSim) {
          sendSafe(ws, lastFromSim);
        }
      }
      if (text === 'requestUpdate' && pmdgCduOptions != null && role === 'browser' &&
          ws.readyState === OPEN) {
        try { ws.send('pmdgCduOptions:' + pmdgCduOptions); } catch (_e) { /* ignore */ }
      }
      // Browser keypad → LiM key bridge (ATR LVars, PMDG rotor brake).
      // Only accept from browser clients so cockpit/SPAD traffic cannot loop back into presses.
      const atrEv = exporters.parseAtrEvent(text);
      if (atrEv && keyBridge && role === 'browser') {
        exporters.sendAtrKey(keyBridge, atrEv.side, atrEv.key);
      }
      const pmdgEv = exporters.parsePmdgEvent(text);
      if (pmdgEv && keyBridge && role === 'browser') {
        exporters.sendPmdgKey(keyBridge, pmdgEv.side, pmdgEv.key, pmdgEv.phase);
      }
      const pmdg777Ev = exporters.parsePmdg777Event(text);
      if (pmdg777Ev && keyBridge && role === 'browser') {
        exporters.sendPmdg777Key(keyBridge, pmdg777Ev.side, pmdg777Ev.key, pmdg777Ev.phase);
      }
      const ascrjEv = exporters.parseAscrjEvent(text);
      if (ascrjEv && keyBridge && role === 'browser') {
        exporters.sendAscrjKey(keyBridge, ascrjEv.side, ascrjEv.key);
      }
      const bb757Ev = exporters.parseBb757Event(text);
      if (bb757Ev && keyBridge && role === 'browser') {
        exporters.sendBb757Key(keyBridge, bb757Ev.side, bb757Ev.key, bb757Ev.phase);
      }
      fanout(text, ws);
    });
    ws.on('close', () => {
      if (role === 'sim') {
        simClients = Math.max(0, simClients - 1);
        console.log(plane ? 'Sim disconnected: ' + plane : 'Sim disconnected');
        if (simClients === 0) console.log('Waiting for simulator...');
        fanout(powerOffMessage);
      } else if (role === 'browser') {
        console.log('Browser disconnected');
      } else if (role === 'relay') {
        console.log('Relay disconnected');
      }
    });
  });
}

function effectiveWinCtrlTag() {
  if (winCtrlPlaneTag !== 'auto') return winctrl.normalizePlaneTag(winCtrlPlaneTag);
  if (exporterLockedTag) return exporterLockedTag;
  if (lastFontHint) {
    const fromFont = winctrl.tagFromFont(lastFontHint);
    if (fromFont) return fromFont;
  }
  return resolvedWinCtrlTag || 'winctrl';
}

const atrExecLt = { 1: false, 2: false };
const lastWinCtrlDm = { left: null, right: null };
let pmdgCduOptions = null;

function publishPmdgCduOptions(value) {
  const mode = Number(value) >= 0.5 ? 1 : 0;
  if (pmdgCduOptions === mode) return;
  pmdgCduOptions = mode;
  fanout('pmdgCduOptions:' + mode);
}

const pmdgAnnun = { 1: null, 2: null };

function withPmdgAnnun(dm, side) {
  if (!dm || (effectiveWinCtrlTag() !== 'pmdg737' && effectiveWinCtrlTag() !== 'pmdg777')) return dm;
  const mcdu = side === 'right' ? 2 : 1;
  const lamps = pmdgAnnun[mcdu];
  if (!lamps) return dm;
  const colon = dm.indexOf(':', 7);
  if (colon < 0) return dm;
  let payload;
  try {
    payload = JSON.parse(dm.slice(colon + 1));
  } catch (_e) {
    return dm;
  }
  const key = side === 'right' ? 'right' : 'left';
  if (!payload[key]) return dm;
  payload[key].exec = !!lamps.exec;
  payload[key].dspy = !!lamps.dspy;
  payload[key].fail = !!lamps.fail;
  payload[key].msg = !!lamps.msg;
  payload[key].ofst = !!lamps.ofst;
  return dm.slice(0, colon + 1) + JSON.stringify(payload);
}

function publishPmdgAnnun(annun) {
  if (!annun || typeof annun !== 'object') return;
  let changed = false;
  [1, 2].forEach(function (mcdu) {
    const raw = annun[mcdu] != null ? annun[mcdu] : annun[String(mcdu)];
    if (!raw || typeof raw !== 'object') return;
    const next = {
      exec: !!raw.exec,
      dspy: !!raw.dspy,
      fail: !!raw.fail,
      msg: !!raw.msg,
      ofst: !!raw.ofst,
    };
    const prev = pmdgAnnun[mcdu];
    if (prev && prev.exec === next.exec && prev.dspy === next.dspy &&
        prev.fail === next.fail && prev.msg === next.msg && prev.ofst === next.ofst) {
      return;
    }
    pmdgAnnun[mcdu] = next;
    changed = true;
  });
  if (!changed) return;
  ['left', 'right'].forEach(function (side) {
    if (!lastWinCtrlDm[side]) return;
    const next = withPmdgAnnun(lastWinCtrlDm[side], side);
    lastWinCtrlDm[side] = next;
    lastFromSim = next;
    lastFromSimViaWinCtrl = true;
    fanout(next);
    const alias = relayAliasUpdate(next);
    if (alias) fanoutRelay(alias);
  });
}

function withAtrExec(dm, side) {
  if (!dm || effectiveWinCtrlTag() !== 'atr') return dm;
  const colon = dm.indexOf(':', 7);
  if (colon < 0) return dm;
  let payload;
  try {
    payload = JSON.parse(dm.slice(colon + 1));
  } catch (_e) {
    return dm;
  }
  const key = side === 'right' ? 'right' : 'left';
  const mcdu = key === 'right' ? 2 : 1;
  if (payload[key]) payload[key].exec = !!atrExecLt[mcdu];
  return dm.slice(0, colon + 1) + JSON.stringify(payload);
}

function publishAtrExec(execLt) {
  if (!execLt || typeof execLt !== 'object') return;
  const changed = [];
  [1, 2].forEach(function (mcdu) {
    if (execLt[mcdu] == null && execLt[String(mcdu)] == null) return;
    const raw = execLt[mcdu] != null ? execLt[mcdu] : execLt[String(mcdu)];
    const lit = Number(raw) >= 0.5;
    if (atrExecLt[mcdu] === lit) return;
    atrExecLt[mcdu] = lit;
    changed.push(mcdu === 2 ? 'right' : 'left');
  });
  changed.forEach(function (side) {
    if (!lastWinCtrlDm[side]) return;
    const next = withAtrExec(lastWinCtrlDm[side], side);
    lastWinCtrlDm[side] = next;
    lastFromSim = next;
    lastFromSimViaWinCtrl = true;
    fanout(next);
    const alias = relayAliasUpdate(next);
    if (alias) fanoutRelay(alias);
  });
}

function logWinCtrlAircraft(dm) {
  const protocol = screenProtocol(dm);
  if (!protocol || protocol === lastWinCtrlProtocolLog) return;
  lastWinCtrlProtocolLog = protocol;
  const label = planeFromUpdate(dm);
  if (label) console.log('Aircraft: ' + label + ' (WinCtrl)');
}

function republishWinCtrlCache() {
  const tag = effectiveWinCtrlTag();
  const protocol = winctrl.protocolForTag(tag);
  const aircraft = winCtrlAircraft || aircraftIdent(observedAircraft, observedLivery) || tag;
  ['left', 'right'].forEach(function (side) {
    const prev = lastWinCtrlDm[side];
    if (!prev || prev.indexOf('update:') !== 0) return;
    const colon = prev.indexOf(':', 7);
    if (colon < 0) return;
    let body = prev.slice(colon + 1);
    try {
      const payload = JSON.parse(body);
      if (aircraft) payload.aircraft = aircraft;
      body = JSON.stringify(payload);
    } catch (_e) { /* keep the previous body */ }
    const next = 'update:' + protocol + ':' + body;
    if (next === prev) return;
    lastWinCtrlDm[side] = next;
    lastFromSim = next;
    lastFromSimViaWinCtrl = true;
    logWinCtrlAircraft(next);
    fanout(next);
    const alias = relayAliasUpdate(next);
    if (alias) fanoutRelay(alias);
  });
}

function publishWinCtrlDisplay(frame, side) {
  // Prefer a live DM sim exporter when present.
  if (simClients > 0) return;
  const tag = effectiveWinCtrlTag();
  const aircraft = winCtrlAircraft || aircraftIdent(observedAircraft, observedLivery) || tag;
  let dm = winctrl.displayToDmUpdate(frame, { side, planeTag: tag, aircraft });
  if (!dm) return;
  dm = withAtrExec(dm, side);
  dm = withPmdgAnnun(dm, side);
  lastWinCtrlDm[side === 'right' ? 'right' : 'left'] = dm;
  if (!winCtrlAnnounced) {
    winCtrlAnnounced = true;
    const protocol = winctrl.protocolForTag(tag);
    if (!spadOwnsScreen(protocol)) fanout('mcduConnected');
    console.log('WinCtrl ingest active — DM protocol ' + protocol);
  }
  lastFromSim = dm;
  lastFromSimViaWinCtrl = true;
  logWinCtrlAircraft(dm);
  fanout(dm);
  const alias = relayAliasUpdate(dm);
  if (alias) fanoutRelay(alias);
}

function attachWinCtrlServer() {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LiM WinCtrl ingest — connect ws://127.0.0.1:' + winCtrlPort + '/winwing/cdu-captain\n');
  });
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch (_e) {
      pathname = String(request.url || '/').split('?')[0];
    }
    pathname = winctrl.normalizePath(pathname);
    if (!winctrl.isWinCtrlPath(pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, pathname);
    });
  });

  wss.on('connection', (ws, _request, pathname) => {
    const side = winctrl.sideFromPath(pathname) || 'left';
    winCtrlClients += 1;
    console.log('WinCtrl connected ' + pathname + ' (' + side + ')');

    ws.on('message', (message) => {
      const parsed = winctrl.parseWinCtrlMessage(message.toString());
      if (!parsed) return;
      if (parsed.kind === 'font') {
        lastFontHint = parsed.font || '';
        if (winCtrlPlaneTag === 'auto' && !exporterLockedTag) {
          const hint = winctrl.tagFromFont(lastFontHint);
          if (hint && hint !== resolvedWinCtrlTag) {
            resolvedWinCtrlTag = hint;
            console.log('WinCtrl Font "' + lastFontHint + '" → planeTag ' + hint);
            republishWinCtrlCache();
          }
        } else if (exporterLockedTag && lastFontHint) {
          console.log('WinCtrl Font "' + lastFontHint + '" ignored — exporter locked tag=' + exporterLockedTag);
        }
        return;
      }
      if (parsed.kind === 'display') {
        publishWinCtrlDisplay(parsed.frame, side);
      }
    });

    ws.on('close', () => {
      winCtrlClients = Math.max(0, winCtrlClients - 1);
      console.log('WinCtrl disconnected ' + pathname);
      if (winCtrlClients === 0 && simClients === 0) {
        winCtrlAnnounced = false;
        fanout(winctrl.powerOffDmUpdate(effectiveWinCtrlTag(), winCtrlAircraft || effectiveWinCtrlTag()));
      }
    });
  });

  httpServer.on('error', (err) => {
    console.error('WinCtrl listen failed: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });

  httpServer.listen(winCtrlPort, '127.0.0.1', () => {
    console.log('WinCtrl listening ws://127.0.0.1:' + winCtrlPort + '/winwing/cdu-{captain|co-pilot|observer}');
    startConfiguredExporters();
  });

  return { httpServer, wss };
}

function applyAircraftLivery(livery) {
  const next = String(livery || '').trim();
  if (next === observedLivery) return;
  observedLivery = next;
  republishWinCtrlCache();
}

function applyAircraftTitle(title) {
  if (!exporterHost || !exporterHost.auto) return;
  const nextTitle = String(title || '');
  if (nextTitle && nextTitle !== observedAircraft) observedLivery = '';
  if (!winCtrlAircraft && nextTitle) observedAircraft = nextTitle;
  const direct = exporters.directWinCtrlForTitle(title);
  const name = direct || exporters.exporterForTitle(title);
  if (name === activeWinCtrlExporter) {
    republishWinCtrlCache();
    return;
  }
  exporterHost.stopReaders();
  activeWinCtrlExporter = name;
  if (direct) {
    exporterLockedTag = direct;
    resolvedWinCtrlTag = direct;
    exporterLabels = [direct];
    console.log('Aircraft: ' + title + ' → ' + direct + ' (direct WinCtrl)');
    republishWinCtrlCache();
    return;
  }
  if (!name) {
    exporterLockedTag = '';
    exporterLabels = [];
    console.log('Aircraft: ' + title + ' (in-sim CDU hook)');
    return;
  }
  const def = exporters.EXPORTERS[name];
  if (!exporterHost.startReader(name)) {
    activeWinCtrlExporter = '';
    exporterLockedTag = '';
    return;
  }
  exporterLockedTag = def.planeTag;
  resolvedWinCtrlTag = def.planeTag;
  exporterLabels = [def.planeTag];
  console.log('Aircraft: ' + title + ' → ' + def.label);
}

function startConfiguredExporters() {
  if (!winCtrlPort || !winCtrlExporter) return;
  const started = exporters.startExporters({
    exporterList: winCtrlExporter,
    mobiFlightDir,
    winCtrlPort,
    log: console.log,
    onAtrExec: publishAtrExec,
    onAircraftTitle: applyAircraftTitle,
    onAircraftLivery: applyAircraftLivery,
    onPmdgCduOptions: publishPmdgCduOptions,
    onPmdgAnnun: publishPmdgAnnun,
  });
  exporterHost = started;
  exporterChildren = started.children;
  exporterLabels = started.planeTags.slice();
  keyBridge = started.keyBridge || null;
  for (const err of started.errors) console.error('WinCtrl exporter: ' + err);
  if (!started.auto && winCtrlPlaneTag === 'auto' && started.planeTags.length === 1) {
    exporterLockedTag = started.planeTags[0];
    resolvedWinCtrlTag = exporterLockedTag;
    activeWinCtrlExporter = started.planeTags[0];
    console.log('WinCtrl planeTag → ' + resolvedWinCtrlTag + ' (locked by exporter)');
  }
}

function printBanner() {
  const lan = localIpv4s();
  console.log('');
  console.log('z-DementedMonkey-LiM-CDU');
  console.log('');
  console.log('  This PC     ' + href('http://localhost:' + httpPort));
  for (const nic of lan) {
    console.log('  LAN         ' + href('http://' + nic.address + ':' + httpPort) + '   (' + nic.name + ')');
  }
  console.log('  Sim socket  ws://127.0.0.1:' + simPort);
  if (!relayPort) {
    console.log('  Relay       off');
  } else {
    console.log('  Relay out   ws://' + relayIp + ':' + relayPort + '   (SPAD listens, this hub connects like the plane)');
  }
  if (!winCtrlPort) {
    console.log('  WinCtrl     off');
  } else {
    console.log('  WinCtrl in  ws://127.0.0.1:' + winCtrlPort + '/winwing/cdu-*');
    if (exporterLabels.length) {
      console.log('  Exporter    ' + exporterLabels.join(', ') + '  (node reader → our :' + winCtrlPort + ')');
    } else if (winCtrlExporter === 'auto') {
      console.log('  Exporter    auto — follows the loaded aircraft');
    } else if (winCtrlExporter) {
      console.log('  Exporter    configured (' + winCtrlExporter + ') but not started — see errors above');
    } else {
      console.log('  Exporter    off');
    }
  }
  console.log('');
  console.log('Waiting for simulator...');
  console.log('');
}

let relayOutTimer = null;
let relayWasOpen = false;
let relayWaitingLogged = false;
let relayProtocol = '';
let relayHeldForSpad = false;

function retargetRelay(protocol) {
  if (!relayPort || !protocol) return false;
  if (!relayProtocol) {
    relayProtocol = protocol;
    return false;
  }
  if (relayProtocol === protocol) return false;
  const previous = relayProtocol;
  relayProtocol = protocol;
  if (relayOutTimer) {
    clearTimeout(relayOutTimer);
    relayOutTimer = null;
  }
  for (const client of Array.from(extraClients)) {
    client._limNoReconnect = true;
    extraClients.delete(client);
    try { client.close(); } catch (_e) { /* close follows */ }
  }
  console.log('Relay reconnect ' + previous + ' → ' + protocol);
  connectRelayOut();
  return true;
}

function connectRelayOut() {
  const url = 'ws://' + relayIp + ':' + relayPort;
  const ws = new WebSocket(url);
  extraClients.add(ws);
  ws.on('open', () => {
    relayWasOpen = true;
    relayWaitingLogged = false;
    console.log('Relay connected ' + url);
    sendSafe(ws, 'mcduConnected');
    sendRelaySnapshot(ws);
  });
  ws.on('message', (message) => {
    const text = message.toString();
    // SPAD may ask for a refresh; answer on this socket (not only via fanout).
    if (text === 'requestUpdate') {
      sendRelaySnapshot(ws);
      return;
    }
    fanout(text, ws);
  });
  ws.on('close', () => {
    extraClients.delete(ws);
    if (ws._limNoReconnect) return;
    if (relayWasOpen) {
      relayWasOpen = false;
      relayWaitingLogged = false;
      console.log('Relay disconnected');
    } else if (!relayWaitingLogged) {
      relayWaitingLogged = true;
      console.log('Relay waiting  ' + url);
    }
    relayOutTimer = setTimeout(connectRelayOut, 2000);
  });
  ws.on('error', () => {
    // close follows. A refused connect is the waiting line, not an error every retry.
  });
}

async function main() {
  await checkFree(simPort);
  await checkFree(httpPort);
  if (winCtrlPort) await checkFree(winCtrlPort);

  const httpServer = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    // Landing page routes to 747 / 737 / UNS / WT21 faces from the first sim update.
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    if (rel.includes('..')) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const filePath = path.join(publicDir, rel);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      let body = data;
      if (ext === '.html' || ext === '.js') {
        body = Buffer.from(String(data).replace(/__LIM_WS_PORT__/g, String(simPort)));
      }
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.html' || ext === '.css' || ext === '.js') headers['Cache-Control'] = 'no-store';
      res.writeHead(200, headers);
      res.end(body);
    });
  });

  httpServer.on('error', (err) => {
    console.error(err.message || err);
    process.exit(1);
  });

  const simWss = new WebSocketServer({ port: simPort });
  servers.push(simWss);
  attachMirror(simWss, 'sim');

  if (relayPort) connectRelayOut();
  if (winCtrlPort) attachWinCtrlServer();

  process.on('exit', () => exporters.stopExporters(exporterChildren));
  process.on('SIGINT', () => {
    exporters.stopExporters(exporterChildren);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    exporters.stopExporters(exporterChildren);
    process.exit(0);
  });

  httpServer.listen(httpPort, '0.0.0.0', printBanner);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
