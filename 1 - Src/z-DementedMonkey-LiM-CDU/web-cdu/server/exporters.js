/**
 * Launch plane readers against our WinCtrl :8320 server.
 * Keys go through lim_key_simconnect.js. The ATR screen is the optional
 * ms_atr_core.pyd in server/readers. Python is only used to launch that module.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const keySim = require('./lim_key_simconnect');

/** ATR screen module, when ms_atr_core.pyd has been copied into this folder. */
const BUNDLED_SCRIPT_DIR = path.join(__dirname, 'readers');

/** Screen readers. planeTag is the WinCtrl protocol name. */
const EXPORTERS = {
  atr: {
    script: 'ms_atr_42_72_winwing_cdu.py',
    planeTag: 'atr',
    label: 'MS ATR 42/72',
  },
  pmdg737: {
    script: 'pmdg_737_winwing_cdu.py',
    planeTag: 'pmdg737',
    label: 'PMDG 737',
  },
  pmdg777: {
    script: 'pmdg_777_winwing_cdu.py',
    planeTag: 'pmdg777',
    label: 'PMDG 777',
  },
  fenix: {
    script: 'fenix_winwing_cdu.py',
    planeTag: 'fenix',
    label: 'Fenix A320',
  },
  fbw: {
    script: 'fbw_a32nx_winwing_cdu.py',
    planeTag: 'fbw',
    label: 'FBW A32NX',
  },
  ifly737: {
    script: 'ifly_737_winwing_cdu.py',
    planeTag: 'ifly737',
    label: 'iFly 737',
  },
  crj: {
    script: 'aerosoft_crj_winwing_cdu.py',
    planeTag: 'ascrj',
    label: 'Aerosoft CRJ',
  },
  inia300: {
    script: 'ini_a300_winwing_cdu.py',
    planeTag: 'inia300',
    label: 'ini A300',
  },
};

function scriptDirHasAtr(dir) {
  return !!(dir && fs.existsSync(path.join(dir, 'ms_atr_core.cp314-win_amd64.pyd')));
}

function bundledPythonExe() {
  const exe = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  return fs.existsSync(exe) ? exe : null;
}

/** ATR module lives next to the hub. Nothing is read from an outside install. */
function resolveScriptDir() {
  const candidates = [];
  if (process.env.LIM_WINCTRL_SCRIPTS) candidates.push(process.env.LIM_WINCTRL_SCRIPTS);
  candidates.push(BUNDLED_SCRIPT_DIR);
  for (const dir of candidates) {
    if (scriptDirHasAtr(dir)) return dir;
  }
  return null;
}

function parseExporterList(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === '0' || text === 'off' || text === 'none' || text === 'false') {
    return [];
  }
  return text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Stock PMDG presets do not put "PMDG" in the sim TITLE.
 * 737-600/700/800/900 use the variation name, e.g. "737-800 PAX BW TC",
 * "737-700 PAX SSW TC", "737-800BCF SSW", "737-900ER PAX BW",
 * "737-800 BBJ2 SSW" (one 800 preset is "BB2"). Official liveries keep it.
 * 777 titles are "777-300ER", "777-200ER GE", "777-200LR", "777F".
 */
function isPmdg737StockTitle(title) {
  if (!/^737-(?:600|700|800|900)/i.test(title)) return false;
  if (!/\b(?:PAX|BW|SSW|BCF|BDSF|BBJ?\d+)\b/i.test(title)) return false;
  return /^737-(?:600|700|800|900)(?:ER)?(?:\s?(?:BCF|BDSF))?(?:\s+PAX)?(?:\s+BBJ?\d?)?(?:\s+(?:BW|SSW))?(?:\s+(?:HD|SC|TC))?(?:\s+HUES(?:\s+[A-Z0-9]+)?)?$/i.test(title);
}

function isPmdg777StockTitle(title) {
  return /^777-(?:200(?:ER|LR|F)|300ER)(?:\s+[A-Z][A-Z0-9]{1,5})?$/i.test(title)
    || /^777-?F(?:\s+[A-Z][A-Z0-9]{1,5})?$/i.test(title);
}

/** Loaded aircraft TITLE → which WinCtrl reader to run. Native LiM hooks match nothing. */
function exporterForTitle(title) {
  const t = String(title || '');
  if (!t) return '';
  if (/atr[\s-]*(42|72)/i.test(t)) return 'atr';
  if (/ifly/i.test(t) && /737/i.test(t)) return 'ifly737';
  if (/pmdg/i.test(t) && /777/i.test(t)) return 'pmdg777';
  if (/pmdg/i.test(t) && /737/i.test(t)) return 'pmdg737';
  if (isPmdg737StockTitle(t)) return 'pmdg737';
  if (isPmdg777StockTitle(t)) return 'pmdg777';
  if (/fenix/i.test(t)) return 'fenix';
  if (/flybywire|a32nx|\bfbw\b/i.test(t)) return 'fbw';
  if (/\bcrj\b/i.test(t) || /crj[\s-]?(?:550|700|900|1000)/i.test(t)) return 'crj';
  if (/a300/i.test(t)) return 'inia300';
  return '';
}

/** Planes that publish WinCtrl themselves. No reader; the tag must stay locked
 *  so a Boeing font hint does not fall through to the PMDG 737. */
function directWinCtrlForTitle(title) {
  const t = String(title || '');
  if (/bluebird/i.test(t) && /757/i.test(t)) return 'bb757';
  return '';
}

/**
 * @param {{ exporterList: string, log?: Function }} opts
 * @returns {{ children: import('child_process').ChildProcess[], planeTags: string[], errors: string[] }}
 */
function mfPythonEnv(pythonExe) {
  const packages = path.join(path.dirname(pythonExe), 'packages');
  const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' });
  if (fs.existsSync(packages)) {
    env.PYTHONPATH = packages + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
  }
  return env;
}

function startExporters(opts) {
  const log = typeof opts.log === 'function' ? opts.log : console.log;
  const names = parseExporterList(opts.exporterList);
  const auto = names.length === 1 && names[0] === 'auto';
  const result = {
    children: [],
    readers: [],
    planeTags: [],
    errors: [],
    keyBridge: null,
    auto: auto,
    startReader: function () { return false; },
    stopReaders: function () {},
  };
  if (!names.length) return result;

  const python = bundledPythonExe();
  const env = python ? mfPythonEnv(python) : process.env;
  const scriptDir = resolveScriptDir();
  const winPort = Number(opts.winCtrlPort) || 8320;

  function track(name, child) {
    child.limName = name;
    result.readers.push(child);
    result.children.push(child);
    result.planeTags.push(EXPORTERS[name].planeTag);
  }

  function spawnReader(name) {
    const def = EXPORTERS[name];
    if (!def) {
      log('Unknown winCtrlExporter "' + name + '"');
      return false;
    }
    if (result.readers.some(function (r) { return r.limName === name && !r.killed; })) {
      return true;
    }
    if (name === 'atr') {
      if (!python) {
        log('ATR screen needs the bundled Python runtime (web-cdu/runtime/python)');
        return false;
      }
      if (!scriptDir) {
        log('ATR screen module missing: ' + path.join(BUNDLED_SCRIPT_DIR, 'ms_atr_core.cp314-win_amd64.pyd'));
        return false;
      }
      const boot = 'import sys; sys.path.insert(0, ' + JSON.stringify(scriptDir) + '); import ms_atr_core; ms_atr_core.main()';
      const child = spawn(python, ['-c', boot], {
        cwd: scriptDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
      child.stdout.on('data', (buf) => {
        const line = String(buf).trim();
        if (line) log('  [atr] ' + line);
      });
      child.stderr.on('data', (buf) => {
        const line = String(buf).trim();
        if (line) log('  [atr] ' + line);
      });
      child.on('exit', (code, signal) => {
        log('ATR screen module exited' +
          (code != null ? ' code=' + code : '') +
          (signal ? ' signal=' + signal : ''));
      });
      child.on('error', (err) => {
        log('ATR screen module failed: ' + (err && err.message ? err.message : err));
      });
      track(name, child);
      log('WinCtrl reader started: ' + def.label + ' (node → ms_atr_core.pyd)');
      return true;
    }
    // Own process. A second SimConnect client inside the hub crashes it
    // (access violation) once the key bridge is already connected.
    const readerPath = path.join(__dirname, 'node-readers.js');
    const child = spawn(process.execPath, [readerPath, name, String(winPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (buf) => {
      const line = String(buf).trim();
      if (line) log(line);
    });
    child.stderr.on('data', (buf) => {
      const line = String(buf).trim();
      if (line) log('WinCtrl reader ' + name + ': ' + line);
    });
    child.on('exit', (code) => {
      const text = code == null ? 'no code' : (code < 0 ? '0x' + (code >>> 0).toString(16) : String(code));
      log('WinCtrl reader ' + name + ' exited (' + text + ')');
    });
    child.on('error', (err) => {
      log('WinCtrl reader ' + name + ' failed: ' + (err && err.message ? err.message : err));
    });
    track(name, child);
    log('WinCtrl reader started: ' + def.label + ' (node)');
    return true;
  }

  result.startReader = spawnReader;
  result.stopReaders = function () {
    const dying = result.readers.splice(0, result.readers.length);
    for (const child of dying) {
      try { if (child && !child.killed) child.kill(); } catch (_e) { /* ignore */ }
      const idx = result.children.indexOf(child);
      if (idx >= 0) result.children.splice(idx, 1);
    }
    result.planeTags = [];
  };

  if (!auto) {
    for (const name of names) {
      if (!EXPORTERS[name]) {
        result.errors.push('Unknown winCtrlExporter "' + name + '" (known: auto, ' + Object.keys(EXPORTERS).join(', ') + ')');
        continue;
      }
      spawnReader(name);
    }
  }

  try {
    const bridge = keySim.start({
      log: log,
      onTitle: opts.onAircraftTitle,
      onLivery: opts.onAircraftLivery,
      onAtrExec: opts.onAtrExec,
      onPmdgCduOptions: opts.onPmdgCduOptions,
      onPmdgAnnun: opts.onPmdgAnnun,
    });
    result.children.push(bridge);
    result.keyBridge = bridge;
    log('Key bridge started');
  } catch (err) {
    result.errors.push('Key bridge failed: ' + (err && err.message ? err.message : err));
  }
  return result;
}

function mcduSide(side) {
  return side === 2 || side === '2' || side === 'right' ? 2 : 1;
}

function sendAtrKey(bridge, side, key) {
  if (!bridge || bridge.killed || typeof bridge.atrKey !== 'function') return false;
  return bridge.atrKey(mcduSide(side), key);
}

/**
 * Parse DM event:wt737/atr:<side>:<key> (or event:wt737/atr:<key>).
 * @returns {{ side: number, key: string }|null}
 */
function parseAtrEvent(text) {
  const raw = String(text || '');
  if (raw.indexOf('event:wt737/atr:') !== 0) return null;
  const rest = raw.slice('event:wt737/atr:'.length);
  const parts = rest.split(':');
  if (parts.length >= 2) {
    const side = parseInt(parts[0], 10);
    const key = parts.slice(1).join(':');
    return { side: side === 2 ? 2 : 1, key };
  }
  if (parts.length === 1 && parts[0]) {
    return { side: 1, key: parts[0] };
  }
  return null;
}

function sendPmdgKey(bridge, side, key, phase) {
  if (!bridge || bridge.killed || typeof bridge.pmdgKey !== 'function') return false;
  return bridge.pmdgKey(mcduSide(side), key, phase === 'up' ? 'up' : 'down');
}

function sendPmdg777Key(bridge, side, key, phase) {
  if (!bridge || bridge.killed || typeof bridge.pmdg777Key !== 'function') return false;
  return bridge.pmdg777Key(mcduSide(side), key, phase === 'up' ? 'up' : 'down');
}

function parsePmdg777Event(text) {
  const raw = String(text || '');
  const prefix = 'event:wt737/pmdg777:';
  if (raw.indexOf(prefix) !== 0) return null;
  const parts = raw.slice(prefix.length).split(':');
  if (parts.length < 3 || !parts[1]) return null;
  const side = parseInt(parts[0], 10);
  return {
    side: side === 2 ? 2 : 1,
    key: parts[1],
    phase: parts[2] === 'up' ? 'up' : 'down',
  };
}

function sendAscrjKey(bridge, side, key) {
  if (!bridge || bridge.killed || typeof bridge.ascrjKey !== 'function') return false;
  return bridge.ascrjKey(mcduSide(side), key);
}

function parseAscrjEvent(text) {
  const raw = String(text || '');
  const prefix = 'event:wt737/ascrj:';
  if (raw.indexOf(prefix) !== 0) return null;
  const parts = raw.slice(prefix.length).split(':');
  if (parts.length >= 2 && parts[1]) {
    const side = parseInt(parts[0], 10);
    return { side: side === 2 ? 2 : 1, key: parts.slice(1).join(':') };
  }
  if (parts.length === 1 && parts[0]) return { side: 1, key: parts[0] };
  return null;
}

function sendBb757Key(bridge, side, key, phase) {
  if (!bridge || bridge.killed || typeof bridge.bb757Key !== 'function') return false;
  return bridge.bb757Key(mcduSide(side), key, phase === 'up' ? 'up' : 'down');
}

function parseBb757Event(text) {
  const raw = String(text || '');
  const prefix = 'event:wt737/bb757:';
  if (raw.indexOf(prefix) !== 0) return null;
  const parts = raw.slice(prefix.length).split(':');
  if (parts.length < 3 || !parts[1]) return null;
  const side = parseInt(parts[0], 10);
  return {
    side: side === 2 ? 2 : 1,
    key: parts[1],
    phase: parts[2] === 'up' ? 'up' : 'down',
  };
}

function parsePmdgEvent(text) {
  const raw = String(text || '');
  const prefix = 'event:wt737/pmdg737:';
  if (raw.indexOf(prefix) !== 0) return null;
  const parts = raw.slice(prefix.length).split(':');
  if (parts.length < 3 || !parts[1]) return null;
  const side = parseInt(parts[0], 10);
  return {
    side: side === 2 ? 2 : 1,
    key: parts[1],
    phase: parts[2] === 'up' ? 'up' : 'down',
  };
}

function stopExporters(children) {
  for (const child of children || []) {
    try {
      if (child && !child.killed) child.kill();
    } catch (_e) { /* ignore */ }
  }
}

module.exports = {
  EXPORTERS,
  parseExporterList,
  exporterForTitle,
  directWinCtrlForTitle,
  resolveScriptDir,
  startExporters,
  stopExporters,
  sendAtrKey,
  parseAtrEvent,
  sendPmdgKey,
  parsePmdgEvent,
  sendPmdg777Key,
  parsePmdg777Event,
  sendBb757Key,
  parseBb757Event,
  sendAscrjKey,
  parseAscrjEvent,
};
