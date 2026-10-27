/**
 * In-process CDU screen readers. They speak the same WinCtrl display JSON
 * the old Python scripts sent to :8320. The ATR screen stays in ms_atr_core.pyd;
 * this file only launches that module.
 */
'use strict';

const WebSocket = require('ws');
const koffi = require('koffi');
const { createClient } = require('./simconnect');

const COLS = 24;
const ROWS = 14;
const CELLS = COLS * ROWS;

const PMDG_COLORS = { 0: 'w', 1: 'c', 2: 'g', 3: 'm', 4: 'a', 5: 'r' };
const PMDG_SYMBOLS = {
  0xA1: '\u2190',
  0xA2: '\u2192',
  0xA3: '\u2191',
  0xA4: '\u2193',
  0xCA: '\u25A1',
};

function blankCells() {
  const data = new Array(CELLS);
  for (let i = 0; i < CELLS; i++) data[i] = [];
  return data;
}

function foldPmdgCode(code) {
  if (code >= 97 && code <= 122) return { code: code - 32, lower: true };
  // Python str.upper() maps ê (0xEA) to Ê (0xCA). PMDG sends the small box that way.
  if (code >= 0xE0 && code <= 0xFE && code !== 0xF7) return { code: code - 0x20, lower: true };
  return { code: code, lower: false };
}

function pmdgCells(buf) {
  const data = blankCells();
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      const src = (x * ROWS + y) * 3;
      const dst = y * COLS + x;
      if (src + 2 >= buf.length) continue;
      const color = buf[src + 1];
      const flags = buf[src + 2];
      const raw = buf[src];
      if (raw === 0 || raw === 0x20) continue;
      const folded = foldPmdgCode(raw);
      const symbol = PMDG_SYMBOLS[folded.code] || String.fromCharCode(folded.code);
      const colour = (flags & 0x04) ? 'e' : (PMDG_COLORS[color] || 'w');
      data[dst] = [symbol, colour, (folded.lower || (flags & 0x01)) ? 1 : 0, (flags & 0x02) ? 1 : 0];
    }
  }
  return data;
}

function sideSocket(port, urlPath, font) {
  let ws = null;
  let last = null;
  let stopped = false;
  function connect() {
    if (stopped) return;
    ws = new WebSocket('ws://127.0.0.1:' + port + urlPath);
    ws.on('open', function () {
      if (font) ws.send(JSON.stringify({ Target: 'Font', Data: font }));
      if (last) ws.send(last);
    });
    ws.on('close', function () {
      if (!stopped) setTimeout(connect, 2000);
    });
    ws.on('error', function () {});
  }
  connect();
  return {
    send: function (data) {
      last = JSON.stringify({ Target: 'Display', Data: data });
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(last);
    },
    stop: function () {
      stopped = true;
      try { if (ws) ws.close(); } catch (_e) { /* ignore */ }
    },
  };
}

function pmdgAreas(kind) {
  if (kind === 'pmdg777') {
    // Captain and FO only. The observer area shares the captain web side,
    // so subscribing it registers a second writer on that screen.
    return [
      { name: 'PMDG_777X_CDU_0', clientId: 0x4E477835, defineId: 0x4E477838, path: '/winwing/cdu-captain' },
      { name: 'PMDG_777X_CDU_1', clientId: 0x4E477836, defineId: 0x4E477839, path: '/winwing/cdu-co-pilot' },
    ];
  }
  return [
    { name: 'PMDG_NG3_CDU_0', clientId: 0x4E473335, defineId: 0x4E473338, path: '/winwing/cdu-captain' },
    { name: 'PMDG_NG3_CDU_1', clientId: 0x4E473336, defineId: 0x4E473339, path: '/winwing/cdu-co-pilot' },
  ];
}

function startPmdg(kind, port, log) {
  const sockets = {};
  const areas = pmdgAreas(kind);
  for (const area of areas) {
    sockets[area.defineId] = sideSocket(port, area.path, 'Boeing');
  }
  const client = createClient(log);
  for (const area of areas) {
    client.addArea({
      name: area.name,
      clientId: area.clientId,
      defineId: area.defineId,
      size: COLS * ROWS * 3,
      onData: function (buf) {
        sockets[area.defineId].send(pmdgCells(buf));
      },
    });
  }
  let timer = null;
  let stopped = false;
  function attempt() {
    if (stopped) return;
    try {
      client.start();
    } catch (err) {
      log('  [' + kind + '] ' + (err && err.message ? err.message : err));
      timer = setTimeout(attempt, 5000);
    }
  }
  attempt();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    client.stop();
    Object.keys(sockets).forEach(function (id) { sockets[id].stop(); });
  };
}

const CRJ_SUBS = { '@': '\u2610', a: '\u2191', b: '\u2193', c: '\u2192', d: '\u2190', e: '\u00b0' };
const CRJ_COLORS = { 0: 'e', 1: 'w', 2: 'r', 3: 'g', 4: 'o', 5: 'o', 6: 'm', 7: 'y' };

function crjCells(buf, startRow) {
  const origin = startRow || 0;
  const rows = Math.floor(buf.length / (COLS * 2));
  const data = new Array(rows * COLS);
  for (let i = 0; i < data.length; i++) data[i] = [];
  for (let local = 0; local < rows; local++) {
    const y = origin + local;
    for (let x = 0; x < COLS; x++) {
      const src = (local * COLS + x) * 2;
      const dst = local * COLS + x;
      if (src + 1 >= buf.length) continue;
      const code = buf[src];
      if (code === 0 || code === 0x20) continue;
      const raw = String.fromCharCode(code);
      const format = buf[src + 1];
      const color = format & 0x7f;
      // Row 13 is the scratchpad. The message line under it is its own row.
      const small = (format & 0x80) !== 0 || (y % 2 === 1 && y !== 13);
      data[dst] = [CRJ_SUBS[raw] || raw, CRJ_COLORS[color] || 'w', small ? 1 : 0];
    }
  }
  return data;
}

const A300_SPECIAL = {
  a: '\u2190', b: '\u2192', e: '\u2191', f: '\u2193', '!': '\u2610', d: '\u00b0', c: '\u0394', p: '\u25a0',
};
const A300_COLORS = { 0: 'w', 1: 'c', 2: 'a', 3: 'g', 4: 'e', 5: 'r', 6: 'y', 7: 'm' };

function a300Cells(buf) {
  const data = blankCells();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const dst = row * COLS + col;
      const src = dst * 3;
      if (src + 2 >= buf.length) continue;
      const code = buf[src];
      if (code === 0 || code === 0x20) continue;
      const raw = String.fromCharCode(code);
      data[dst] = [A300_SPECIAL[raw] || raw, A300_COLORS[buf[src + 1]] || 'w', (buf[src + 2] & 0x01) ? 1 : 0];
    }
  }
  return data;
}

function startClientData(label, port, log, areas, decode, font) {
  const sockets = {};
  for (const area of areas) {
    sockets[area.defineId] = sideSocket(port, area.path, font);
  }
  const client = createClient(function (msg) { log('  [' + label + '] ' + msg); });
  for (const area of areas) {
    client.addArea({
      name: area.name,
      clientId: area.clientId,
      defineId: area.defineId,
      size: area.size,
      onData: function (buf) { sockets[area.defineId].send(decode(buf)); },
    });
  }
  let timer = null;
  let stopped = false;
  function attempt() {
    if (stopped) return;
    try {
      client.start();
    } catch (err) {
      log('  [' + label + '] ' + (err && err.message ? err.message : err));
      timer = setTimeout(attempt, 5000);
    }
  }
  attempt();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    client.stop();
    Object.keys(sockets).forEach(function (id) { sockets[id].stop(); });
  };
}

function startCrj(port, log) {
  const pageBytes = COLS * ROWS * 2;
  const msgBytes = COLS * 2;
  const sides = [
    { name: 'ASCRJ CDU1 Data', clientId: 21, pageDef: 22, pageReq: 31, msgDef: 26, msgReq: 32, path: '/winwing/cdu-captain' },
    { name: 'ASCRJ CDU2 Data', clientId: 23, pageDef: 24, pageReq: 33, msgDef: 27, msgReq: 34, path: '/winwing/cdu-co-pilot' },
  ];
  const sockets = {};
  const page = {};
  const message = {};
  sides.forEach(function (side) {
    sockets[side.path] = sideSocket(port, side.path, 'Collins');
    page[side.path] = crjCells(Buffer.alloc(pageBytes), 0);
    message[side.path] = crjCells(Buffer.alloc(msgBytes), ROWS);
  });
  function publish(path) {
    sockets[path].send(page[path].concat(message[path]));
  }
  const client = createClient(function (msg) { log('  [crj] ' + msg); });
  sides.forEach(function (side) {
    client.addArea({
      name: side.name,
      clientId: side.clientId,
      defineId: side.pageDef,
      requestId: side.pageReq,
      offset: 0,
      size: pageBytes,
      onData: function (buf) {
        page[side.path] = crjCells(buf, 0);
        publish(side.path);
      },
    });
    client.addArea({
      name: side.name,
      clientId: side.clientId,
      defineId: side.msgDef,
      requestId: side.msgReq,
      offset: pageBytes,
      size: msgBytes,
      skipMap: true,
      onData: function (buf) {
        message[side.path] = crjCells(buf, ROWS);
        publish(side.path);
      },
    });
  });
  let timer = null;
  let stopped = false;
  function attempt() {
    if (stopped) return;
    try {
      client.start();
    } catch (err) {
      log('  [crj] ' + (err && err.message ? err.message : err));
      timer = setTimeout(attempt, 5000);
    }
  }
  attempt();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    client.stop();
    Object.keys(sockets).forEach(function (id) { sockets[id].stop(); });
  };
}

function startA300(port, log) {
  // Screen passthrough. This 1.1.5 aircraft never creates iniAirbusMCDU_1, and
  // requesting it is SimConnect exception 25. The MCDU is drawn inside
  // inibuilds-A300.wasm. The A300 bezel is deferred; do not subscribe.
  log('  [inia300] screen passthrough only. A300 bezel is deferred, and this aircraft does not publish iniAirbusMCDU_1.');
  return function stop() {};
}

const FENIX_SUBS = { '#': '\u2610', '\u00A4': '\u2191', '\u00A5': '\u2193', '\u00A2': '\u2192', '\u00A3': '\u2190', '&': '\u0394' };
const FENIX_REPLACE = { '\u00A3': 1, '\u00A2': 1, '\u00A5': 1, '\u00A4': 1, '#': 1, '&': 1 };
const FENIX_FORMAT = { s: 1, l: 1, a: 1, c: 1, y: 1, w: 1, g: 1, m: 1 };

function fenixLine(text) {
  const cells = [];
  let size = 0;
  let formatting = 'w';
  const chars = text == null ? '' : String(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars.charAt(i);
    if (FENIX_FORMAT[ch] && (ch === 's' || ch === 'l' || 'acywgm'.indexOf(ch) >= 0)) {
      if (ch === 's') size = 1;
      else if (ch === 'l') size = 0;
      else formatting = ch;
      continue;
    }
    if (FENIX_REPLACE[ch]) cells.push([FENIX_SUBS[ch], formatting, size]);
    else if (ch !== ' ') cells.push([ch, formatting, size]);
    else cells.push([]);
  }
  while (cells.length < COLS) cells.push([]);
  return cells.slice(0, COLS);
}

function fenixCells(xml) {
  const data = [];
  const re = />([^<]*)</g;
  let match;
  let rows = 0;
  while ((match = re.exec(String(xml || ''))) && rows < ROWS) {
    if (!match[1].length) continue;
    data.push.apply(data, fenixLine(match[1]));
    rows += 1;
  }
  while (data.length < CELLS) data.push([]);
  return data.slice(0, CELLS);
}

function startFenix(port, log) {
  const left = sideSocket(port, '/winwing/cdu-captain', 'AirbusThales');
  const right = sideSocket(port, '/winwing/cdu-co-pilot', 'AirbusThales');
  let stopped = false;
  let ws = null;
  const query = 'subscription OnDataRefChanged($names: [String!]!) { dataRefs(names: $names) { name value } }';

  function connect() {
    if (stopped) return;
    ws = new WebSocket('ws://127.0.0.1:8083/graphql/');
    ws.on('open', function () {
      ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    });
    ws.on('message', function (buf) {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch (_e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            operationName: 'OnDataRefChanged',
            query: query,
            variables: { names: ['aircraft.mcdu1.display', 'aircraft.mcdu2.display'] },
          },
        }));
        return;
      }
      if (msg.type !== 'next' && msg.type !== 'data') return;
      const body = (msg.payload && msg.payload.data) || msg.payload || {};
      const ref = body.dataRefs;
      if (!ref) return;
      const cells = fenixCells(ref.value);
      if (ref.name === 'aircraft.mcdu1.display') left.send(cells);
      else if (ref.name === 'aircraft.mcdu2.display') right.send(cells);
    });
    ws.on('close', function () {
      if (!stopped) setTimeout(connect, 5000);
    });
    ws.on('error', function (err) {
      log('  [fenix] ' + (err && err.message ? err.message : err));
    });
  }
  connect();
  return function stop() {
    stopped = true;
    try { if (ws) ws.close(); } catch (_e) { /* ignore */ }
    left.stop();
    right.stop();
  };
}

const FBW_COLOURS = {
  amber: 'a', cyan: 'c', green: 'g', inop: 'e', magenta: 'm', red: 'r', white: 'w', yellow: 'y',
};
const FBW_CHARS = {
  '\u2190': '\u2190', '\u2192': '\u2192', '\u2191': '\u2191', '\u2193': '\u2193',
  _: '\u2610', '\u00b0': '\u00b0', '&': '\u0394', '\u00a0': ' ',
  '{': '\u2190', '}': '\u2192', '|': '/',
};
const FBW_TAG = /\{(end|sp|left|right|small|big|amber|cyan|green|inop|magenta|red|white|yellow|)\}/g;

function fbwSegment(segment, labelLine) {
  const normal = [];
  const left = [];
  const right = [];
  const stack = [];
  let last = 0;
  const text = segment == null ? '' : String(segment);
  FBW_TAG.lastIndex = 0;
  let match;
  function colour() {
    for (let i = 0; i < stack.length; i++) if (FBW_COLOURS[stack[i]]) return FBW_COLOURS[stack[i]];
    return 'w';
  }
  function size() {
    for (let i = 0; i < stack.length; i++) {
      if (stack[i] === 'small') return 1;
      if (stack[i] === 'big') return 0;
    }
    return labelLine ? 1 : 0;
  }
  function align() {
    for (let i = 0; i < stack.length; i++) if (stack[i] === 'left' || stack[i] === 'right') return stack[i];
    return '';
  }
  function bucket() {
    const a = align();
    if (a === 'left') return left;
    if (a === 'right') return right;
    return normal;
  }
  function pushChars(chunk) {
    const dest = bucket();
    for (let i = 0; i < chunk.length; i++) {
      const ch = FBW_CHARS[chunk.charAt(i)] || chunk.charAt(i);
      dest.push([ch, colour(), size()]);
    }
  }
  while ((match = FBW_TAG.exec(text))) {
    pushChars(text.slice(last, match.index));
    last = match.index + match[0].length;
    const tag = match[1];
    if (tag === 'end') stack.shift();
    else if (tag === 'sp') bucket().push([]);
    else if (tag) stack.unshift(tag);
  }
  pushChars(text.slice(last));
  if (normal.length > COLS) {
    const diff = normal.length - COLS;
    const start = Math.floor(diff / 2);
    normal.splice(0, start);
    normal.length = COLS;
  }
  return [normal, left.slice(0, COLS), right.slice(0, COLS)];
}

function blankCell(cell) {
  return !cell || !cell.length || cell[0] === ' ';
}

function place(row, parts, column) {
  parts[1].forEach(function (cell, i) { if (!blankCell(cell)) row[i] = cell; });
  parts[2].forEach(function (cell, i) {
    if (!blankCell(cell)) row[COLS - parts[2].length + i] = cell;
  });
  parts[0].forEach(function (cell, i) {
    if (!blankCell(cell) && column + i < COLS) row[column + i] = cell;
  });
}

function emptyRow() {
  const row = new Array(COLS);
  for (let i = 0; i < COLS; i++) row[i] = [];
  return row;
}

function fbwCells(content) {
  const lines = [];
  for (let i = 0; i < ROWS; i++) lines.push(emptyRow());
  const src = content || {};
  const arrows = Array.isArray(src.arrows) ? src.arrows : [false, false, false, false];
  if (src.titleLeft != null) place(lines[0], fbwSegment(src.titleLeft, false), 0);
  if (src.title != null) {
    const title = fbwSegment(src.title, false);
    place(lines[0], title, Math.floor((COLS - title[0].length) / 2));
  }
  if (arrows[2]) lines[0][COLS - 2] = ['\u2190', 'w', 0];
  if (arrows[3]) lines[0][COLS - 1] = ['\u2192', 'w', 0];
  if (src.page != null) {
    const page = fbwSegment(src.page, true);
    place(lines[0], page, COLS - page[0].length);
  }
  const body = Array.isArray(src.lines) ? src.lines : [];
  let labelLine = false;
  for (let i = 0; i < body.length && i < ROWS - 1; i++) {
    const row = lines[i + 1];
    labelLine = i % 2 === 0;
    const segs = body[i] || [];
    for (let s = 0; s < 3 && s < segs.length; s++) {
      if (!segs[s]) continue;
      const chars = fbwSegment(segs[s], labelLine);
      if (s === 0) place(row, chars, 0);
      else if (s === 1) place(row, chars, COLS - chars[0].length);
      else place(row, chars, Math.floor((COLS - chars[0].length) / 2));
    }
  }
  if (src.scratchpad != null) place(lines[ROWS - 1], fbwSegment(src.scratchpad, labelLine), 0);
  if (arrows[0]) lines[ROWS - 1][COLS - 2] = ['\u2191', 'w', 0];
  if (arrows[1]) lines[ROWS - 1][COLS - 1] = ['\u2193', 'w', 0];
  const data = [];
  for (let r = 0; r < ROWS; r++) data.push.apply(data, lines[r]);
  return data;
}

function startFbw(port, log) {
  const left = sideSocket(port, '/winwing/cdu-captain', null);
  const right = sideSocket(port, '/winwing/cdu-co-pilot', null);
  let stopped = false;
  let ws = null;
  let lastLeft = '';
  let lastRight = '';
  function connect() {
    if (stopped) return;
    ws = new WebSocket('ws://127.0.0.1:8380/interfaces/v1/mcdu');
    ws.on('open', function () { ws.send('requestUpdate'); });
    ws.on('message', function (buf) {
      const text = String(buf);
      if (text.indexOf('update:') !== 0) return;
      let body;
      try { body = JSON.parse(text.slice(text.indexOf(':') + 1)); } catch (_e) { return; }
      ['left', 'right'].forEach(function (side) {
        const mcdu = body[side];
        const encoded = JSON.stringify(mcdu == null ? {} : mcdu);
        if (side === 'left') {
          if (encoded === lastLeft) return;
          lastLeft = encoded;
          left.send(fbwCells(mcdu || {}));
        } else {
          if (encoded === lastRight) return;
          lastRight = encoded;
          right.send(fbwCells(mcdu || {}));
        }
      });
    });
    ws.on('close', function () { if (!stopped) setTimeout(connect, 5000); });
    ws.on('error', function (err) {
      log('  [fbw] ' + (err && err.message ? err.message : err));
    });
  }
  connect();
  return function stop() {
    stopped = true;
    try { if (ws) ws.close(); } catch (_e) { /* ignore */ }
    left.stop();
    right.stop();
  };
}

const IFLY_NG = 'iFly737NG_SDK2_FileMappingObject';
const IFLY_MAX = 'iFly737MAX_SDK_FileMappingObject';
const IFLY_COLOR = { 0: 'w', 1: 'g', 2: 'c', 3: 'm', 4: 'e', 5: 'w', 6: 'w', 7: 'e', 8: 'm', 9: 'w', 10: 'w' };

function iflySymbol(color, ch) {
  if (color === 5) return '\u2610';
  if (color === 9) return '\u2190';
  if (color === 10) return '\u2192';
  if (color === 6 || color === 7 || color === 8) return '\u00B0';
  return ch;
}

function iflyCellsFromNg(buf, cdu) {
  const data = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = (cdu * ROWS + row) * COLS + col;
      const code = buf.readUInt16LE(idx * 2);
      const small = buf.readInt32LE(1344 + idx * 4);
      const color = buf.readInt32LE(4032 + idx * 4);
      const ch = code === 0 ? '\0' : String.fromCharCode(code);
      if (color === 0 && (ch === ' ' || ch === '\0')) data.push([]);
      else data.push([iflySymbol(color, ch === '\0' ? ' ' : ch), IFLY_COLOR[color] || 'w', small ? 1 : 0]);
    }
  }
  return data;
}

function iflyCellsFromMax(buf, cdu) {
  const data = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = (cdu * ROWS + row) * COLS + col;
      const code = buf[1068 + idx];
      const small = buf[1740 + idx];
      const color = buf[2412 + idx];
      const ch = code === 0 ? '\0' : String.fromCharCode(code);
      if (color === 0 && (ch === ' ' || ch === '\0')) data.push([]);
      else data.push([iflySymbol(color, ch === '\0' ? ' ' : ch), IFLY_COLOR[color] || 'w', small ? 1 : 0]);
    }
  }
  return data;
}

function startIfly(port, log) {
  const k32 = koffi.load('kernel32.dll');
  const OpenFileMappingW = k32.func('void *OpenFileMappingW(uint32 access, int inherit, str16 name)');
  const MapViewOfFile = k32.func('void *MapViewOfFile(void *handle, uint32 access, uint32 hi, uint32 lo, uintptr size)');
  const UnmapViewOfFile = k32.func('int UnmapViewOfFile(void *view)');
  const CloseHandle = k32.func('int CloseHandle(void *handle)');
  const left = sideSocket(port, '/winwing/cdu-captain', 'Boeing');
  const right = sideSocket(port, '/winwing/cdu-co-pilot', 'Boeing');
  let stopped = false;
  let handle = null;
  let view = null;
  let kind = '';
  let timer = null;

  function closeMap() {
    if (view) { try { UnmapViewOfFile(view); } catch (_e) { /* ignore */ } }
    if (handle) { try { CloseHandle(handle); } catch (_e) { /* ignore */ } }
    view = null;
    handle = null;
    kind = '';
  }

  function openMap() {
    closeMap();
    const maxHandle = OpenFileMappingW(4, 0, IFLY_MAX);
    if (maxHandle) {
      const maxView = MapViewOfFile(maxHandle, 4, 0, 0, 3096);
      if (maxView) {
        const state = koffi.decode(maxView, 'int32');
        if (state === 1) {
          handle = maxHandle;
          view = maxView;
          kind = 'max';
          return true;
        }
        UnmapViewOfFile(maxView);
      }
      CloseHandle(maxHandle);
    }
    const ngHandle = OpenFileMappingW(4, 0, IFLY_NG);
    if (ngHandle) {
      const ngView = MapViewOfFile(ngHandle, 4, 0, 0, 6772);
      if (ngView) {
        const bytes = Buffer.from(koffi.decode(ngView, koffi.array('uint8', 6772)));
        if (bytes.readInt32LE(6768) === 1) {
          handle = ngHandle;
          view = ngView;
          kind = 'ng';
          return true;
        }
        UnmapViewOfFile(ngView);
      }
      CloseHandle(ngHandle);
    }
    return false;
  }

  function tick() {
    if (stopped) return;
    if (!view && !openMap()) {
      timer = setTimeout(tick, 5000);
      return;
    }
    try {
      const size = kind === 'ng' ? 6772 : 3096;
      const buf = Buffer.from(koffi.decode(view, koffi.array('uint8', size)));
      if (kind === 'ng' && buf.readInt32LE(6768) === 0) {
        left.send(blankCells());
        right.send(blankCells());
      } else if (kind === 'max' && buf.readInt32LE(0) === 0) {
        left.send(blankCells());
        right.send(blankCells());
      } else if (kind === 'ng') {
        const powered0 = buf.readInt32LE(6720);
        const powered1 = buf.readInt32LE(6724);
        left.send(powered0 === 0 ? blankCells() : iflyCellsFromNg(buf, 0));
        right.send(powered1 === 0 ? blankCells() : iflyCellsFromNg(buf, 1));
      } else {
        left.send(iflyCellsFromMax(buf, 0));
        right.send(iflyCellsFromMax(buf, 1));
      }
    } catch (err) {
      log('  [ifly737] ' + (err && err.message ? err.message : err));
      closeMap();
    }
    timer = setTimeout(tick, 100);
  }
  tick();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    closeMap();
    left.stop();
    right.stop();
  };
}

function start(name, opts) {
  const port = opts && opts.port ? opts.port : 8320;
  const log = opts && opts.log ? opts.log : console.log;
  if (name === 'pmdg737' || name === 'pmdg777') return startPmdg(name, port, log);
  if (name === 'crj') return startCrj(port, log);
  if (name === 'inia300') return startA300(port, log);
  if (name === 'fenix') return startFenix(port, log);
  if (name === 'fbw') return startFbw(port, log);
  if (name === 'ifly737') return startIfly(port, log);
  throw new Error('No node reader for ' + name);
}

module.exports = {
  start,
  pmdgCells,
  fenixCells,
  fbwCells,
};

if (require.main === module) {
  const name = process.argv[2];
  const port = Number(process.argv[3]) || 8320;
  try {
    const stop = start(name, {
      port: port,
      log: function (msg) { console.log(msg); },
    });
    function shutdown() {
      try { stop(); } catch (_e) { /* already stopped */ }
      process.exit(0);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
