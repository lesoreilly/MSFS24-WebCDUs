/**
 * Small SimConnect client for CDU client-data areas.
 * Loads SimConnect.dll shipped in server/native. No MobiFlight WASM module.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

const RECV_OPEN = 2;
const RECV_QUIT = 3;
const RECV_EXCEPTION = 1;
const RECV_CLIENT_DATA = 16;
const DATA_OFFSET = 40; // SIMCONNECT_RECV + request/object/define/flags/entry/outof/count
const EXC_NAME = {
  1: 'ERROR',
  3: 'UNRECOGNIZED_ID',
  7: 'NAME_UNRECOGNIZED',
  9: 'EVENT_ID_DUPLICATE',
  25: 'ILLEGAL_OPERATION',
  26: 'ALREADY_SUBSCRIBED',
  29: 'DUPLICATE_ID',
  32: 'ALREADY_CREATED',
};

const DLL_CANDIDATES = [
  path.join(__dirname, 'native', 'SimConnect.dll'),
];

function loadDll() {
  for (const file of DLL_CANDIDATES) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error('SimConnect.dll not found in server/native');
}

function createClient(log) {
  const say = typeof log === 'function' ? log : function () {};
  const dllPath = loadDll();
  const lib = koffi.load(dllPath);
  const Open = lib.func('int32 SimConnect_Open(_Out_ void **phSimConnect, const char *szName, void *hWnd, uint32 UserEventWin32, void *hEventHandle, uint32 ConfigIndex)');
  const Close = lib.func('int32 SimConnect_Close(void *hSimConnect)');
  const CallDispatch = lib.func('int32 SimConnect_CallDispatch(void *hSimConnect, void *cb, void *ctx)');
  const MapName = lib.func('int32 SimConnect_MapClientDataNameToID(void *hSimConnect, const char *name, uint32 id)');
  const AddDef = lib.func('int32 SimConnect_AddToClientDataDefinition(void *hSimConnect, uint32 defineId, uint32 offset, uint32 size, float epsilon, uint32 datumId)');
  const Request = lib.func('int32 SimConnect_RequestClientData(void *hSimConnect, uint32 clientId, uint32 requestId, uint32 defineId, uint32 period, uint32 flags, uint32 origin, uint32 interval, uint32 limit)');

  const Dispatch = koffi.proto('void LiMReaderDispatch(void *pData, uint32 cbData, void *ctx)');
  let handle = null;
  let callback = null;
  let timer = null;
  let stopped = false;
  const areas = [];
  let opened = false;
  let subscribed = false;
  const seenExceptions = {};

  function readPacket(pData, cbData) {
    const dwSize = koffi.decode(pData, 'uint32');
    const size = Math.max(0, Math.min(dwSize || 0, cbData || dwSize || 0, 16384));
    if (size < 12) return null;
    const bytes = Buffer.from(koffi.decode(pData, koffi.array('uint8', size)));
    return bytes;
  }

  function onDispatch(pData, cbData) {
    try {
      const bytes = readPacket(pData, cbData);
      if (!bytes) return;
      const id = bytes.readUInt32LE(8);
      if (id === RECV_OPEN) {
        opened = true;
        subscribeAll();
        return;
      }
      if (id === RECV_QUIT) {
        say('SimConnect quit');
        stop();
        return;
      }
      if (id === RECV_EXCEPTION) {
        const code = bytes.readUInt32LE(12);
        if (!seenExceptions[code]) {
          seenExceptions[code] = true;
          say('SimConnect exception ' + (EXC_NAME[code] || code));
        }
        return;
      }
      if (id !== RECV_CLIENT_DATA || bytes.length < DATA_OFFSET + 4) return;
      const defineId = bytes.readUInt32LE(20);
      const area = areas.find(function (a) { return a.defineId === defineId; });
      if (!area) return;
      const payload = bytes.subarray(DATA_OFFSET, DATA_OFFSET + area.size);
      if (payload.length < area.size) return;
      area.onData(Buffer.from(payload));
    } catch (err) {
      say('SimConnect dispatch: ' + (err && err.message ? err.message : err));
    }
  }

  function subscribeAll() {
    if (!handle || subscribed) return;
    subscribed = true;
    for (const area of areas) {
      const mapHr = area.skipMap ? 0 : MapName(handle, area.name, area.clientId);
      const defHr = AddDef(handle, area.defineId, area.offset || 0, area.size, 0, 0);
      const requestId = area.requestId != null ? area.requestId : area.clientId;
      const reqHr = Request(handle, area.clientId, requestId, area.defineId, 2, 1, 0, 0, 0);
      if (mapHr !== 0 || defHr !== 0 || reqHr !== 0) {
        say('SimConnect subscribe ' + area.name + ' map=' + mapHr + ' def=' + defHr + ' req=' + reqHr);
      } else {
        say('SimConnect subscribed ' + area.name);
      }
    }
  }

  function start() {
    const out = [null];
    const hr = Open(out, 'LiM-CDU', null, 0, null, 0);
    if (hr !== 0 || !out[0]) {
      throw new Error('SimConnect_Open failed (' + hr + '). Is the sim running?');
    }
    handle = out[0];
    callback = koffi.register(onDispatch, koffi.pointer(Dispatch));
    timer = setInterval(function () {
      if (!handle || stopped) return;
      try { CallDispatch(handle, callback, null); } catch (_e) { /* sim closed */ }
    }, 16);
    if (opened) subscribeAll();
  }

  function addArea(area) {
    areas.push(area);
    if (opened) subscribeAll();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (handle) {
      try { Close(handle); } catch (_e) { /* already gone */ }
    }
    handle = null;
    if (callback) {
      try { koffi.unregister(callback); } catch (_e) { /* ignore */ }
      callback = null;
    }
  }

  return { start, addArea, stop };
}

module.exports = { createClient };
