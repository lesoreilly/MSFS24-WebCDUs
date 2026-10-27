/**
 * WinCtrl (MobiFlight / Winwing) Display → DM wt737/<planeTag> converter.
 * Spec: https://docs.mobiflight.com/game-controllers/winctrl/winctrl-cdu/dev-instructions/
 * MSFS only — X-Plane profiles are not registered here.
 */
'use strict';

const CDU_ROWS = 14;
const CDU_COLS = 24;
const CDU_CELLS = CDU_ROWS * CDU_COLS;

/** Official colour letter → CSS style token(s) for the 737-style WebCDU / SPAD parser. */
const COLOUR_TO_STYLES = {
  a: 'yellow', // amber → closest stock face colour
  w: 'white',
  c: 'cyan',
  g: 'green',
  m: 'magenta',
  r: 'red',
  y: 'yellow',
  o: 'blue', // official WinCtrl blue
  e: 'disabled',
  k: 'khaki',
};

/** Font Target Data → default planeTag when cfg is "auto". */
const FONT_TO_TAG = {
  Boeing: 'pmdg737',
  Collins: 'wt21',
  AirbusThales: 'fenix',
};

/** Known MSFS plane tags (protocol = wt737/<tag>). */
const PLANE_TAGS = {
  uns1: 'uns1',
  wt747: 'wt747',
  pmdg737: 'pmdg737',
  pmdg777: 'pmdg777',
  ifly737: 'ifly737',
  fenix: 'fenix',
  fbw: 'fbw',
  headwind: 'headwind',
  fslabs: 'fslabs',
  inia300: 'inia300',
  inia340: 'inia340',
  asa340: 'asa340',
  ascrj: 'ascrj',
  bb757: 'bb757',
  fa50: 'fa50',
  maddog: 'maddog',
  tfdimd11: 'tfdimd11',
  ec135: 'ec135',
  atr: 'atr',
  wt21: 'wt21',
  winctrl: 'winctrl',
};

const PATH_SIDE = {
  '/winwing/cdu-captain': 'left',
  '/winwing/cdu-co-pilot': 'right',
  '/winwing/cdu-observer': 'left',
};

function normalizePath(urlPath) {
  if (!urlPath) return '';
  try {
    // request.url may be "/winwing/cdu-captain" or full path with query
    const q = urlPath.indexOf('?');
    const p = q >= 0 ? urlPath.slice(0, q) : urlPath;
    return p.replace(/\/+$/, '') || '/';
  } catch (_e) {
    return '';
  }
}

function sideFromPath(urlPath) {
  const p = normalizePath(urlPath).toLowerCase();
  return PATH_SIDE[p] || null;
}

function isWinCtrlPath(urlPath) {
  return sideFromPath(urlPath) != null;
}

function normalizePlaneTag(tag) {
  const t = String(tag || '').trim().toLowerCase().replace(/^wt737\//, '');
  if (!t || t === 'auto') return 'winctrl';
  if (PLANE_TAGS[t]) return PLANE_TAGS[t];
  // Allow custom alphanumeric tags for future planes
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(t)) return t;
  return 'winctrl';
}

function protocolForTag(tag) {
  const t = normalizePlaneTag(tag);
  // Existing dedicated faces keep their exact protocol strings
  if (t === 'uns1') return 'wt737/uns1';
  if (t === 'wt747') return 'wt737/wt747';
  return 'wt737/' + t;
}

function tagFromFont(fontName) {
  const name = String(fontName || '').trim();
  if (FONT_TO_TAG[name]) return FONT_TO_TAG[name];
  return null;
}

function cellStyles(colourLetter, size, inverse) {
  const parts = [];
  const colour = COLOUR_TO_STYLES[String(colourLetter || 'w').toLowerCase()] || 'white';
  parts.push(colour);
  if (Number(size) === 1) parts.push('s-text');
  if (Number(inverse) === 1) parts.push('r-white');
  return parts.join(' ');
}

function parseCell(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return { content: ' ', styles: 'white' };
  }
  const ch = raw[0] == null || raw[0] === '' ? ' ' : String(raw[0]);
  const content = ch.length ? ch.charAt(0) : ' ';
  const colour = raw[1] != null ? String(raw[1]) : 'w';
  const size = raw[2] != null ? Number(raw[2]) : 0;
  const inverse = raw[3] != null ? Number(raw[3]) : 0;
  return { content, styles: cellStyles(colour, size, inverse) };
}

/**
 * Convert WinCtrl Display Data (336 cells) to a DM screen object.
 * @param {unknown[]} data
 * @returns {{ lines: Array<{rowStyle:string,cols:Array<{content:string,styles:string}>}>, power: boolean, exec: boolean }}
 */
function displayDataToScreen(data) {
  const cells = Array.isArray(data) ? data : [];
  const lines = [];
  const rowCount = Math.max(CDU_ROWS, Math.floor(cells.length / CDU_COLS));
  for (let r = 0; r < rowCount; r++) {
    const cols = [];
    let anySmall = false;
    for (let c = 0; c < CDU_COLS; c++) {
      const idx = r * CDU_COLS + c;
      const cell = parseCell(cells[idx]);
      if (/\bs-text\b/.test(cell.styles)) anySmall = true;
      cols.push(cell);
    }
    const rowStyle = anySmall && r % 2 === 1 && r !== CDU_ROWS - 1
      ? 'fmc-row s-text'
      : 'fmc-row d-text';
    lines.push({ rowStyle, cols });
  }
  return { lines, power: true, exec: false };
}

/**
 * Build a full DM update string from a WinCtrl Display frame.
 * @param {{ Data?: unknown[] }} frame
 * @param {{ side: 'left'|'right', planeTag: string, aircraft?: string }} opts
 * @returns {string|null}
 */
function displayToDmUpdate(frame, opts) {
  if (!frame || !Array.isArray(frame.Data)) return null;
  const side = opts.side === 'right' ? 'right' : 'left';
  const planeTag = normalizePlaneTag(opts.planeTag);
  const protocol = protocolForTag(planeTag);
  const screen = displayDataToScreen(frame.Data);
  const payload = {
    aircraft: String(opts.aircraft || planeTag || 'WinCtrl').trim() || 'WinCtrl',
  };
  payload[side] = screen;
  return 'update:' + protocol + ':' + JSON.stringify(payload);
}

function powerOffDmUpdate(planeTag, aircraft) {
  const protocol = protocolForTag(planeTag);
  const blank = { lines: [], power: false, exec: false };
  return 'update:' + protocol + ':' + JSON.stringify({
    aircraft: String(aircraft || planeTag || 'WinCtrl'),
    left: blank,
    right: blank,
  });
}

/**
 * Parse an inbound WinCtrl JSON text message.
 * @returns {{ kind: 'display'|'font'|'other', frame?: object, font?: string }|null}
 */
function parseWinCtrlMessage(text) {
  let frame;
  try {
    frame = JSON.parse(String(text || ''));
  } catch (_e) {
    return null;
  }
  if (!frame || typeof frame !== 'object') return null;
  const target = String(frame.Target || '');
  if (target === 'Display') {
    return { kind: 'display', frame };
  }
  if (target === 'Font') {
    return { kind: 'font', font: String(frame.Data || ''), frame };
  }
  return { kind: 'other', frame };
}

module.exports = {
  CDU_ROWS,
  CDU_COLS,
  CDU_CELLS,
  PLANE_TAGS,
  COLOUR_TO_STYLES,
  FONT_TO_TAG,
  normalizePath,
  sideFromPath,
  isWinCtrlPath,
  normalizePlaneTag,
  protocolForTag,
  tagFromFont,
  displayDataToScreen,
  displayToDmUpdate,
  powerOffDmUpdate,
  parseWinCtrlMessage,
};
