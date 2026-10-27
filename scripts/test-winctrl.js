/**
 * Fixture tests: WinCtrl Display → DM update:wt737/<planeTag>:
 * Run: node scripts/test-winctrl.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const winctrl = require(path.join(
  __dirname,
  '..',
  '1 - Src',
  'z-DementedMonkey-LiM-CDU',
  'web-cdu',
  'winctrl.js'
));

function blankCells() {
  const cells = [];
  for (let i = 0; i < winctrl.CDU_CELLS; i++) {
    cells.push([' ', 'w', 0, 0]);
  }
  return cells;
}

function writeText(cells, row, col, text, colour, size) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const idx = row * winctrl.CDU_COLS + col + i;
    if (idx >= 0 && idx < cells.length) {
      cells[idx] = [s.charAt(i), colour || 'w', size || 0, 0];
    }
  }
}

function testFenixFixture() {
  const data = blankCells();
  writeText(data, 0, 0, 'FENIX A320', 'g', 0);
  writeText(data, 1, 0, 'FROM', 'c', 1);
  writeText(data, 2, 0, 'EGLL', 'w', 0);
  // Row 3 col 0 (index 72) — inverse yellow, do not overwrite the title row
  data[3 * winctrl.CDU_COLS] = ['X', 'y', 0, 1];

  const msg = winctrl.displayToDmUpdate(
    { Target: 'Display', Data: data },
    { side: 'left', planeTag: 'fenix', aircraft: 'Fenix A320' }
  );
  assert.ok(msg, 'displayToDmUpdate returns a string');
  assert.ok(msg.indexOf('update:wt737/fenix:') === 0, 'protocol is wt737/fenix');

  const json = JSON.parse(msg.slice('update:wt737/fenix:'.length));
  assert.strictEqual(json.aircraft, 'Fenix A320');
  assert.ok(json.left, 'left screen present');
  assert.strictEqual(json.left.power, true);
  assert.strictEqual(json.left.lines.length, 14, '14 rows');
  for (let r = 0; r < 14; r++) {
    assert.strictEqual(json.left.lines[r].cols.length, 24, 'row ' + r + ' has 24 cols');
  }
  const title = json.left.lines[0].cols.slice(0, 10).map((c) => c.content).join('');
  assert.strictEqual(title, 'FENIX A320');
  assert.ok(/\bgreen\b/.test(json.left.lines[0].cols[0].styles), 'green colour');
  assert.ok(/\bs-text\b/.test(json.left.lines[1].cols[0].styles), 'small text');
  assert.ok(/\br-white\b/.test(json.left.lines[0].cols.length && json.left.lines[3]
    ? json.left.lines[3].cols[0].styles : ''), 'inverse');
  console.log('ok fenix fixture → update:wt737/fenix: 14×24');
}

function testWt21Tag() {
  const data = blankCells();
  writeText(data, 0, 0, 'HAWKER', 'w', 0);
  const msg = winctrl.displayToDmUpdate(
    { Target: 'Display', Data: data },
    { side: 'left', planeTag: 'wt21', aircraft: 'Hawker 800XP' }
  );
  assert.ok(msg.indexOf('update:wt737/wt21:') === 0);
  console.log('ok wt21 tag → update:wt737/wt21:');
}

function testFontHints() {
  assert.strictEqual(winctrl.tagFromFont('Boeing'), 'pmdg737');
  assert.strictEqual(winctrl.tagFromFont('Collins'), 'wt21');
  assert.strictEqual(winctrl.tagFromFont('AirbusThales'), 'fenix');
  assert.strictEqual(winctrl.tagFromFont('Unknown'), null);
  console.log('ok Font → planeTag hints');
}

function testPaths() {
  assert.strictEqual(winctrl.sideFromPath('/winwing/cdu-captain'), 'left');
  assert.strictEqual(winctrl.sideFromPath('/winwing/cdu-co-pilot'), 'right');
  assert.strictEqual(winctrl.sideFromPath('/winwing/cdu-observer'), 'left');
  assert.ok(winctrl.isWinCtrlPath('/winwing/cdu-captain'));
  assert.ok(!winctrl.isWinCtrlPath('/other'));
  console.log('ok WinCtrl paths');
}

function testParse() {
  const d = winctrl.parseWinCtrlMessage(JSON.stringify({
    Target: 'Display',
    Data: blankCells(),
  }));
  assert.strictEqual(d.kind, 'display');
  const f = winctrl.parseWinCtrlMessage(JSON.stringify({
    Target: 'Font',
    Data: 'Collins',
  }));
  assert.strictEqual(f.kind, 'font');
  assert.strictEqual(f.font, 'Collins');
  console.log('ok parseWinCtrlMessage');
}

function testNormalize() {
  assert.strictEqual(winctrl.normalizePlaneTag('Fenix'), 'fenix');
  assert.strictEqual(winctrl.normalizePlaneTag('wt737/pmdg777'), 'pmdg777');
  assert.strictEqual(winctrl.protocolForTag('uns1'), 'wt737/uns1');
  assert.strictEqual(winctrl.protocolForTag('wt747'), 'wt737/wt747');
  console.log('ok normalize / protocolForTag');
}

testFenixFixture();
testWt21Tag();
testFontHints();
testPaths();
testParse();
testNormalize();
console.log('All WinCtrl fixture tests passed.');
