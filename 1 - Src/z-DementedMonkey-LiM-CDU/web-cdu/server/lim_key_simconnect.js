/**
 * SimConnect key bridge. One client for the aircraft title, CDU key writes,
 * ATR EXEC lamps, PMDG layout, and PMDG annunciators.
 * The ATR screen stays in the optional ms_atr_core.pyd.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

const RECV_EXCEPTION = 1;
const RECV_OPEN = 2;
const RECV_QUIT = 3;
const RECV_SIMOBJECT = 8;
const RECV_SIMOBJECT_BYTYPE = 9;
const RECV_CLIENT_DATA = 16;
const DATA_OFFSET = 40;
const FLOAT64 = 4;
const STRINGV = 11;
const UNUSED = 0xFFFFFFFF;
const EVENT_FLAG_GROUP_IS_PRIORITY = 16;

const KEY_MAP = {
  MENU: 'MENU', PREVPAGE: 'PREV', PREV: 'PREV', NEXTPAGE: 'NEXT', NEXT: 'NEXT',
  RMS: 'RMS', FPLN: 'FPLN', DTO: 'DTO', PERF: 'PERF', MSG: 'MSG', EXEC: 'EXEC',
  PROG: 'PROG', DATA: 'DATA', VNAV: 'VNAV', MRK: 'MRK', CLR: 'CLR',
  DOT: 'PERIOD', PERIOD: 'PERIOD', DIV: 'SLASH', SLASH: 'SLASH',
  SP: 'SPACE', SPACE: 'SPACE', PLUSMINUS: 'PLUSMINUS',
  BRT_UP: 'BRT_UP', BRT_DN: 'BRT_DN',
};
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') KEY_MAP[ch] = ch;
for (let i = 1; i <= 6; i++) {
  KEY_MAP['L' + i] = 'L' + i;
  KEY_MAP['R' + i] = 'R' + i;
}
const LONG_MAP = { L1: 'L1_LONG', L2: 'L2_LONG', L3: 'L3_LONG', L4: 'L4_LONG', CLR: 'CLR_LONG' };

const PMDG_ORDER = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']
  .concat(['INITREF', 'RTE', 'CLB', 'CRZ', 'DES', 'MENU', 'LEGS', 'DEPARR', 'HOLD', 'PROG', 'EXEC'])
  .concat(['N1LIMIT', 'FIX', 'PREVPAGE', 'NEXTPAGE'])
  .concat('123456789'.split(''))
  .concat(['DOT', '0', 'PLUSMINUS'])
  .concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
  .concat(['SP', 'DEL', 'DIV', 'CLR']);
const PMDG_CDU_LEFT = {};
PMDG_ORDER.forEach(function (name, i) { PMDG_CDU_LEFT[name] = 534 + i; });
PMDG_CDU_LEFT.BRT_DN = 605;
PMDG_CDU_LEFT.BRT_UP = 605;
PMDG_CDU_LEFT.SLASH = PMDG_CDU_LEFT.DIV;
PMDG_CDU_LEFT.SPACE = PMDG_CDU_LEFT.SP;
PMDG_CDU_LEFT.PERIOD = PMDG_CDU_LEFT.DOT;
PMDG_CDU_LEFT.INIT = PMDG_CDU_LEFT.INITREF;

const PMDG777_TOP = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']
  .concat(['INITREF', 'RTE', 'DEPARR', 'ALTN', 'VNAV', 'FIX', 'LEGS', 'HOLD']);
const PMDG777_LEFT = {};
PMDG777_TOP.forEach(function (name, i) { PMDG777_LEFT[name] = 328 + i; });
['PROG', 'EXEC', 'MENU', 'NAVRAD', 'PREVPAGE', 'NEXTPAGE'].forEach(function (name, i) {
  PMDG777_LEFT[name] = 348 + i;
});
const PMDG777_PAD = '123456789'.split('').concat(['DOT', '0', 'PLUSMINUS'])
  .concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
  .concat(['SP', 'DEL', 'DIV', 'CLR']);
PMDG777_PAD.forEach(function (name, i) { PMDG777_LEFT[name] = 354 + i; });
PMDG777_LEFT.FMCCOMM = 3471;
PMDG777_LEFT.BRT_DN = 400;
PMDG777_LEFT.BRT_UP = 400;
PMDG777_LEFT.SLASH = PMDG777_LEFT.DIV;
PMDG777_LEFT.SPACE = PMDG777_LEFT.SP;
PMDG777_LEFT.PERIOD = PMDG777_LEFT.DOT;
PMDG777_LEFT.INIT = PMDG777_LEFT.INITREF;
PMDG777_LEFT.NAV = PMDG777_LEFT.NAVRAD;
const PMDG777_RIGHT_OFFSET = 73;
const PMDG777_RIGHT_FMCCOMM = 4201;

const BB757_KEY = {
  INITREF: 'INIT', INIT: 'INIT', RTE: 'RTE', DEPARR: 'DEPARR', ATC: 'ATC',
  VNAV: 'VNAV', FIX: 'FIX', LEGS: 'LEGS', HOLD: 'HOLD', FMCCOMM: 'FMCCOMM',
  PROG: 'PROG', EXEC: 'EXEC', MENU: 'MENU', NAVRAD: 'NAVRAD', NAV: 'NAVRAD',
  PREVPAGE: 'PREV', PREV: 'PREV', NEXTPAGE: 'NEXT', NEXT: 'NEXT',
  DOT: 'NUMPER', PERIOD: 'NUMPER', PLUSMINUS: 'NUMPLUS',
  SP: 'KEYSP', SPACE: 'KEYSP', DEL: 'KEYDEL', DIV: 'KEYSLASH', SLASH: 'KEYSLASH',
  CLR: 'KEYCLR',
};
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') BB757_KEY[ch] = 'KEY' + ch;
for (const n of '0123456789') BB757_KEY[n] = 'NUM' + n;
for (let i = 1; i <= 6; i++) {
  BB757_KEY['L' + i] = 'L' + i;
  BB757_KEY['R' + i] = 'R' + i;
}

const ASCRJ_KEY = {
  DIR: 'DIR_INTC', DIR_INTC: 'DIR_INTC', DEPARR: 'DEP_ARR', DEP_ARR: 'DEP_ARR',
  PREVPAGE: 'PREV_PAGE', PREV: 'PREV_PAGE', NEXTPAGE: 'NEXT_PAGE', NEXT: 'NEXT_PAGE',
  SECFPLN: 'SEC_FPLN', SEC_FPLN: 'SEC_FPLN', DOT: 'PERIOD', PERIOD: 'PERIOD',
  DIV: 'SLASH', SLASH: 'SLASH', PLUSMINUS: 'PLUS', PLUS: 'PLUS',
  CLR: 'CLR', CLR_LONG: 'CLR',
};
for (const name of ['MSG', 'FPLN', 'HOLD', 'UP', 'INDEX', 'FIX', 'LEGS', 'VNAV', 'DOWN', 'EXEC', 'RADIO', 'PROG', 'PERF', 'MCDU_MENU', 'MFD_DATA', 'MFD_MENU', 'MFD_ADV', 'SP', 'DEL']) {
  ASCRJ_KEY[name] = name;
}
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') ASCRJ_KEY[ch] = ch;
for (let i = 1; i <= 6; i++) {
  ASCRJ_KEY['L' + i] = 'LSK' + i + 'L';
  ASCRJ_KEY['R' + i] = 'LSK' + i + 'R';
}

function loadDll() {
  const file = path.join(__dirname, 'native', 'SimConnect.dll');
  if (!fs.existsSync(file)) throw new Error('SimConnect.dll not found in server/native');
  return file;
}

function start(opts) {
  const say = typeof opts.log === 'function' ? opts.log : function () {};
  const lib = koffi.load(loadDll());
  const Open = lib.func('int32 SimConnect_Open(_Out_ void **phSimConnect, const char *szName, void *hWnd, uint32 UserEventWin32, void *hEventHandle, uint32 ConfigIndex)');
  const Close = lib.func('int32 SimConnect_Close(void *hSimConnect)');
  const CallDispatch = lib.func('int32 SimConnect_CallDispatch(void *hSimConnect, void *cb, void *ctx)');
  const AddDef = lib.func('int32 SimConnect_AddToDataDefinition(void *hSimConnect, uint32 defineId, const char *name, const char *units, uint32 type, float epsilon, uint32 datumId)');
  const RequestType = lib.func('int32 SimConnect_RequestDataOnSimObjectType(void *hSimConnect, uint32 requestId, uint32 defineId, uint32 radius, uint32 type)');
  const SetData = lib.func('int32 SimConnect_SetDataOnSimObject(void *hSimConnect, uint32 defineId, uint32 objectId, uint32 flags, uint32 count, uint32 cbUnit, void *data)');
  const MapEvent = lib.func('int32 SimConnect_MapClientEventToSimEvent(void *hSimConnect, uint32 eventId, const char *name)');
  const Transmit = lib.func('int32 SimConnect_TransmitClientEvent(void *hSimConnect, uint32 objectId, uint32 eventId, uint32 data, uint32 groupId, uint32 flags)');
  const MapName = lib.func('int32 SimConnect_MapClientDataNameToID(void *hSimConnect, const char *name, uint32 id)');
  const AddClientDef = lib.func('int32 SimConnect_AddToClientDataDefinition(void *hSimConnect, uint32 defineId, uint32 offset, uint32 size, float epsilon, uint32 datumId)');
  const RequestClient = lib.func('int32 SimConnect_RequestClientData(void *hSimConnect, uint32 clientId, uint32 requestId, uint32 defineId, uint32 period, uint32 flags, uint32 origin, uint32 interval, uint32 limit)');
  const Dispatch = koffi.proto('void LiMKeyDispatch(void *pData, uint32 cbData, void *ctx)');

  let handle = null;
  let callback = null;
  let timer = null;
  let pollTimer = null;
  let retryTimer = null;
  let opened = false;
  let waitingLogged = false;
  let rotorOk = false;
  let nextReadId = 1;
  let nextWriteDef = 10000;
  let pollTick = 0;
  const reads = new Map();
  const writeDefs = new Map();
  const writeFails = new Set();
  const unmapped = new Set();
  const crjReads = new Map();
  const crjCount = new Map();
  const pulseGen = new Map();
  const seenExceptions = {};
  const annunAreas = [];
  let titleSlot = null;
  let liverySlot = null;
  let exec1 = null;
  let exec2 = null;
  let cduSlot = null;
  let lastTitle = '';
  let lastLivery = '';
  let execState = {};
  let cduMode = null;
  let annunKey = '';

  const api = {
    killed: false,
    kill: stop,
    atrKey: atrKey,
    pmdgKey: pmdgKey,
    pmdg777Key: pmdg777Key,
    ascrjKey: ascrjKey,
    bb757Key: bb757Key,
  };

  function readPacket(pData, cbData) {
    const dwSize = koffi.decode(pData, 'uint32');
    const size = Math.max(0, Math.min(dwSize || 0, cbData || dwSize || 0, 8192));
    if (size < 12) return null;
    return Buffer.from(koffi.decode(pData, koffi.array('uint8', size)));
  }

  function onDispatch(pData, cbData) {
    try {
      const bytes = readPacket(pData, cbData);
      if (!bytes) return;
      const id = bytes.readUInt32LE(8);
      if (id === RECV_OPEN) {
        opened = true;
        subscribe();
        return;
      }
      if (id === RECV_QUIT) {
        setImmediate(dropConnection);
        return;
      }
      if (id === RECV_EXCEPTION) {
        const code = bytes.readUInt32LE(12);
        if (code === 3 || code === 7) return;
        if (!seenExceptions[code]) {
          seenExceptions[code] = true;
          say('Key bridge SimConnect exception ' + code);
        }
        return;
      }
      if ((id === RECV_SIMOBJECT || id === RECV_SIMOBJECT_BYTYPE) && bytes.length >= DATA_OFFSET) {
        const slot = reads.get(bytes.readUInt32LE(12));
        if (!slot) return;
        if (slot.string) {
          let end = DATA_OFFSET;
          while (end < bytes.length && bytes[end] !== 0) end++;
          slot.value = bytes.toString('utf8', DATA_OFFSET, end).replace(/\u0000/g, '').trim();
          if (slot === titleSlot) onTitle(slot.value);
          else if (slot === liverySlot) onLivery(slot.value);
        } else if (bytes.length >= DATA_OFFSET + 8) {
          slot.value = bytes.readDoubleLE(DATA_OFFSET);
          if (slot === exec1 || slot === exec2) onExec();
          else if (slot === cduSlot) onCduOptions(slot.value);
        }
        return;
      }
      if (id === RECV_CLIENT_DATA && bytes.length >= DATA_OFFSET) {
        const defineId = bytes.readUInt32LE(20);
        const area = annunAreas.find(function (item) { return item.defineId === defineId; });
        if (!area || bytes.length < DATA_OFFSET + area.size) return;
        area.onData(bytes.subarray(DATA_OFFSET, DATA_OFFSET + area.size));
      }
    } catch (err) {
      say('Key bridge dispatch: ' + (err && err.message ? err.message : err));
    }
  }

  function defineSlot(datum, units, type, isString) {
    const id = nextReadId++;
    const hr = AddDef(handle, id, datum, units, type, 0, UNUSED);
    if (hr !== 0) return null;
    const slot = { id: id, string: isString, value: undefined };
    reads.set(id, slot);
    return slot;
  }

  function request(slot) {
    if (!handle || !slot) return;
    RequestType(handle, slot.id, slot.id, 0, 0);
  }

  let ngAnnun = false;
  let tripleAnnun = false;

  function subscribe() {
    titleSlot = defineSlot('TITLE', null, STRINGV, true);
    liverySlot = defineSlot('LIVERY NAME', null, STRINGV, true);
    const rotorHr = MapEvent(handle, 10, 'ROTOR_BRAKE');
    rotorOk = rotorHr === 0;
    if (!rotorOk) say('Key bridge could not map ROTOR_BRAKE');
    request(titleSlot);
    request(liverySlot);
  }

  function subscribeAnnun(name, clientId, defineId, requestId, offset, size, onData) {
    if (MapName(handle, name, clientId) !== 0) return;
    if (AddClientDef(handle, defineId, offset, size, 0, UNUSED) !== 0) return;
    if (RequestClient(handle, clientId, requestId, defineId, 2, 1, 0, 0, 0) !== 0) return;
    annunAreas.push({ defineId: defineId, size: size, onData: onData });
  }

  function ensureAtrExec() {
    if (exec1) return;
    exec1 = defineSlot('L:MSATR_MCDU1_EXEC_LT', 'Number', FLOAT64, false);
    exec2 = defineSlot('L:MSATR_MCDU2_EXEC_LT', 'Number', FLOAT64, false);
    request(exec1);
    request(exec2);
  }

  function ensureCduOptions() {
    if (cduSlot) return;
    cduSlot = defineSlot('L:cduOptions', 'Number', FLOAT64, false);
    request(cduSlot);
  }

  function ensureNgAnnun() {
    if (ngAnnun) return;
    ngAnnun = true;
    subscribeAnnun('PMDG_NG3_Data', 0x4E473331, 0x4E473332, 0x4E47333A, 543, 12, onPmdgAnnun);
  }

  function ensure777Annun() {
    if (tripleAnnun) return;
    tripleAnnun = true;
    subscribeAnnun('PMDG_777X_Data', 0x504D4447, 0x504D4448, 0x504D444B, 397, 16, onPmdg777Annun);
  }

  function onTitle(value) {
    if (!value) return;
    if (value === lastTitle) return;
    lastTitle = value;
    const title = String(value).toUpperCase();
    if (title.indexOf('PMDG') >= 0 && title.indexOf('737') >= 0) ensureNgAnnun();
    if (title.indexOf('PMDG') >= 0 && title.indexOf('777') >= 0) ensure777Annun();
    if (title.indexOf('PMDG') >= 0) ensureCduOptions();
    if (title.indexOf('ATR') >= 0) ensureAtrExec();
    if (typeof opts.onTitle === 'function') opts.onTitle(value);
  }

  function onLivery(value) {
    const next = String(value || '').trim();
    if (next === lastLivery) return;
    lastLivery = next;
    if (typeof opts.onLivery === 'function') opts.onLivery(next);
  }

  function onExec() {
    const next = {};
    let changed = false;
    [[1, exec1], [2, exec2]].forEach(function (pair) {
      const mcdu = pair[0];
      const slot = pair[1];
      if (!slot || typeof slot.value !== 'number') return;
      const lit = slot.value >= 0.5 ? 1 : 0;
      next[mcdu] = lit;
      if (execState[mcdu] !== lit) changed = true;
    });
    if (!changed) return;
    execState = next;
    if (typeof opts.onAtrExec === 'function') opts.onAtrExec(next);
  }

  function onCduOptions(value) {
    if (typeof value !== 'number') return;
    const mode = value >= 0.5 ? 1 : 0;
    if (mode === cduMode) return;
    cduMode = mode;
    if (typeof opts.onPmdgCduOptions === 'function') opts.onPmdgCduOptions(mode);
  }

  function emitAnnun(state) {
    const key = state.join(',');
    if (key === annunKey) return;
    annunKey = key;
    if (typeof opts.onPmdgAnnun !== 'function') return;
    opts.onPmdgAnnun({
      1: { exec: state[0], dspy: state[1], fail: state[2], msg: state[3], ofst: state[4] },
      2: { exec: state[5], dspy: state[6], fail: state[7], msg: state[8], ofst: state[9] },
    });
  }

  function onPmdgAnnun(payload) {
    function on(index) { return payload[index] ? 1 : 0; }
    emitAnnun([on(0), on(2), on(4), on(6), on(8), on(1), on(3), on(5), on(7), on(9)]);
  }

  function onPmdg777Annun(payload) {
    function on(index) { return payload[index] ? 1 : 0; }
    emitAnnun([on(0), on(3), on(6), on(9), on(12), on(1), on(4), on(7), on(10), on(13)]);
  }

  function writeDef(lvar) {
    const have = writeDefs.get(lvar);
    if (have) return have;
    const id = nextWriteDef++;
    const hr = AddDef(handle, id, 'L:' + lvar, 'Number', FLOAT64, 0, UNUSED);
    if (hr !== 0) return 0;
    writeDefs.set(lvar, id);
    return id;
  }

  function setLvar(lvar, value) {
    if (!handle) return false;
    const id = writeDef(lvar);
    if (!id) return false;
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    const hr = SetData(handle, id, 0, 0, 0, 8, buf);
    if (hr !== 0 && !writeFails.has(lvar)) {
      writeFails.add(lvar);
      say('Key bridge could not write ' + lvar);
    }
    return hr === 0;
  }

  function warnUnmapped(kind, key) {
    const id = kind + ':' + key;
    if (unmapped.has(id)) return;
    unmapped.add(id);
    say('Key bridge unmapped ' + kind + ' key ' + key);
  }

  function atrKey(mcdu, key) {
    const raw = String(key || '').trim();
    const longPress = /_Long$/i.test(raw) || raw === 'CLR_Long';
    const base = longPress ? raw.replace(/_Long$/i, '') : raw;
    return pressAtr(mcdu, base, longPress);
  }

  function pressAtr(mcdu, key, longPress) {
    const which = Number(mcdu) === 2 ? 2 : 1;
    const raw = String(key || '').trim();
    let suffix = null;
    if (longPress && LONG_MAP[raw]) suffix = LONG_MAP[raw];
    else suffix = KEY_MAP[raw] || KEY_MAP[raw.toUpperCase()];
    if (!suffix) {
      warnUnmapped('ATR', raw);
      return false;
    }
    const keyLvar = 'MSATR_MCDU' + which + '_' + suffix;
    setLvar(keyLvar, 1);
    setLvar('MSATR_MCDU' + which + '_INPUT', 1);
    const gen = (pulseGen.get(keyLvar) || 0) + 1;
    pulseGen.set(keyLvar, gen);
    setTimeout(function () {
      if (pulseGen.get(keyLvar) !== gen) return;
      setLvar(keyLvar, 0);
    }, 50);
    return true;
  }

  function rotor(base, phase, raw) {
    if (!handle || !rotorOk) return false;
    let flag = 1;
    if (phase === 'up') flag = 4;
    else if (String(raw || '').toUpperCase() === 'BRT_UP') flag = 2;
    const hr = Transmit(handle, 0, 10, base * 100 + flag, 1, EVENT_FLAG_GROUP_IS_PRIORITY);
    return hr === 0;
  }

  function pmdgKey(mcdu, key, phase) {
    const raw = String(key || '').trim();
    let base;
    if (/^\d{3,}$/.test(raw)) {
      base = parseInt(raw, 10);
      if (base < 534 || base > 677) {
        warnUnmapped('PMDG', raw);
        return false;
      }
    } else {
      base = PMDG_CDU_LEFT[raw.toUpperCase()];
      if (base == null) {
        warnUnmapped('PMDG', raw);
        return false;
      }
    }
    if (Number(mcdu) === 2) base += 72;
    return rotor(base, phase, raw);
  }

  function pmdg777Key(mcdu, key, phase) {
    const raw = String(key || '').trim().toUpperCase();
    const which = Number(mcdu) === 2 ? 2 : 1;
    let base;
    if (raw === 'FMCCOMM' && which === 2) base = PMDG777_RIGHT_FMCCOMM;
    else {
      base = PMDG777_LEFT[raw];
      if (base == null) {
        warnUnmapped('PMDG 777', raw);
        return false;
      }
      if (which === 2) base += PMDG777_RIGHT_OFFSET;
    }
    return rotor(base, phase, raw);
  }

  function bb757Key(mcdu, key, phase) {
    const raw = String(key || '').trim().toUpperCase();
    const suffix = BB757_KEY[raw];
    if (!suffix) {
      warnUnmapped('757', raw);
      return false;
    }
    const which = Number(mcdu) === 2 ? 2 : 1;
    setLvar('B757_CDU_' + which + '_' + suffix, phase === 'up' ? 0 : 1);
    return true;
  }

  function ascrjKey(mcdu, key) {
    const raw = String(key || '').trim().toUpperCase();
    const suffix = ASCRJ_KEY[raw];
    if (!suffix) {
      warnUnmapped('CRJ', raw);
      return false;
    }
    const which = Number(mcdu) === 2 ? 2 : 1;
    bumpLvar('ASCRJ_MCDU' + which + '_' + suffix);
    return true;
  }

  function bumpLvar(lvar) {
    if (!handle) return;
    let slot = crjReads.get(lvar);
    if (!slot) {
      slot = defineSlot('L:' + lvar, 'Number', FLOAT64, false);
      if (!slot) return;
      crjReads.set(lvar, slot);
    }
    slot.value = undefined;
    const gen = (slot.gen || 0) + 1;
    slot.gen = gen;
    request(slot);
    const started = Date.now();
    const wait = setInterval(function () {
      if (api.killed || slot.gen !== gen) {
        clearInterval(wait);
        return;
      }
      if (slot.value === undefined && Date.now() - started < 200) return;
      clearInterval(wait);
      const base = typeof slot.value === 'number' ? slot.value : (crjCount.get(lvar) || 0);
      const next = base + 1;
      crjCount.set(lvar, next);
      setLvar(lvar, next);
    }, 10);
  }

  function poll() {
    if (!opened) return;
    pollTick++;
    if (!lastTitle) {
      if (pollTick % 8 === 0) {
        request(titleSlot);
        request(liverySlot);
      }
      return;
    }
    request(titleSlot);
    request(liverySlot);
    request(exec1);
    request(exec2);
    request(cduSlot);
  }

  function dropConnection() {
    opened = false;
    rotorOk = false;
    titleSlot = null;
    liverySlot = null;
    exec1 = null;
    exec2 = null;
    cduSlot = null;
    lastTitle = '';
    lastLivery = '';
    ngAnnun = false;
    tripleAnnun = false;
    reads.clear();
    writeDefs.clear();
    crjReads.clear();
    annunAreas.length = 0;
    if (timer) clearInterval(timer);
    timer = null;
    if (handle) {
      try { Close(handle); } catch (_e) { /* already gone */ }
      handle = null;
    }
    if (callback) {
      try { koffi.unregister(callback); } catch (_e) { /* ignore */ }
      callback = null;
    }
    if (!api.killed) scheduleOpen();
  }

  function scheduleOpen() {
    if (retryTimer || api.killed) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      open();
    }, 3000);
  }

  function open() {
    if (api.killed || handle) return;
    const out = [null];
    let hr = 1;
    try {
      hr = Open(out, 'LiM-CDU-Keys', null, 0, null, 0);
    } catch (_e) {
      hr = 1;
    }
    if (hr !== 0 || !out[0]) {
      if (!waitingLogged) {
        waitingLogged = true;
        say('Key bridge waiting for the simulator');
      }
      scheduleOpen();
      return;
    }
    waitingLogged = false;
    handle = out[0];
    callback = koffi.register(onDispatch, koffi.pointer(Dispatch));
    timer = setInterval(function () {
      if (!handle || api.killed) return;
      try { CallDispatch(handle, callback, null); } catch (_e) { dropConnection(); }
    }, 16);
  }

  function stop() {
    if (api.killed) return;
    api.killed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    dropConnection();
  }

  pollTimer = setInterval(poll, 250);
  open();
  return api;
}

module.exports = { start };
