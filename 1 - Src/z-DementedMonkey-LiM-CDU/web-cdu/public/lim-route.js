(function (global) {
  function is747Classic(aircraft) {
    const name = String(aircraft || '').toUpperCase();
    if (/B748|AC_MODEL_B748|\b748\b/.test(name)) return false;
    return /B744|AC_MODEL_B744|\b744\b|LCF|GST|BLCF|WTBLCF|WTB744/.test(name);
  }

  function is737FamilyProtocol(fmcType) {
    const t = String(fmcType || '');
    if (t === 'wt737') return true;
    if (t.indexOf('wt737/') !== 0) return false;
    // Dedicated faces — not the generic 737 bezel
    if (t === 'wt737/wt747' || t === 'wt737/uns1' || t === 'wt737/atr' || t === 'wt737/pmdg737' || t === 'wt737/pmdg777' || t === 'wt737/ascrj' || t === 'wt737/bb757') return false;
    return true;
  }

  function pageForProtocol(fmcType, aircraft) {
    if (fmcType === 'wt737/wt747') {
      return is747Classic(aircraft) ? '747-400.html' : '747.html';
    }
    if (fmcType === 'wt737/uns1') return 'uns.html';
    if (fmcType === 'wt737/atr') return 'atr.html';
    if (fmcType === 'wt737/ascrj') return 'crj.html';
    if (fmcType === 'wt737/bb757') return '757.html';
    if (fmcType === 'wt737/pmdg737') return 'pmdg737.html';
    if (fmcType === 'wt737/pmdg777') return 'pmdg777.html';
    // iFly 737 MAX uses the FANS 2/B legend set on 737.html
    // (DEP ARR, ATC, VNAV, FIX, HOLD, FMC COMM, MENU, N1 LIMIT).
    // pmdg737.html boots in FANS 1/A (CLB / CRZ / DES) and follows L:cduOptions.
    if (fmcType === 'wt737/ifly737') return '737.html';
    // Native 737 and WinCtrl-ingested wt737/<planeTag> (fenix, …)
    if (is737FamilyProtocol(fmcType)) return '737.html';
    if (fmcType === 'wt21') {
      const name = String(aircraft || '').toUpperCase();
      if (/H25B|H25|HAWKER|800XP/.test(name)) return 'hawker.html';
      if (/C750/.test(name)) return 'c750.html';
      if (/P180|PIAGGIO/.test(name)) return 'p180.html';
      if (/C90|KINGAIR|KING AIR/.test(name)) return 'c90.html';
      return 'wt21.html';
    }
    return '';
  }

  function currentPage() {
    const path = String(location.pathname || '').replace(/\\/g, '/');
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  function screenParam(fallback) {
    if (fallback) return fallback;
    try {
      return new URLSearchParams(location.search).get('screen') || '';
    } catch (_) {
      return '';
    }
  }

  /**
   * If this update belongs on another dedicated face page, navigate there.
   * Returns true when a redirect was started.
   */
  function maybeRedirect(raw, opts) {
    opts = opts || {};
    try {
      if (new URLSearchParams(location.search).get('preview') === '1') return false;
    } catch (_) { /* ignore */ }
    const text = String(raw || '');
    if (text.indexOf('update:') !== 0) return false;
    const colon = text.indexOf(':', 7);
    if (colon < 0) return false;
    const fmcType = text.slice(7, colon);
    let aircraft = '';
    try {
      const payload = JSON.parse(text.slice(colon + 1));
      aircraft = payload && payload.aircraft;
    } catch (_) { /* ignore */ }

    const page = pageForProtocol(fmcType, aircraft);
    if (!page) return false;

    const here = currentPage();
    if (here === page) return false;

    // Hub maps "/" through index.html to a face. Empty path still navigates
    // to the dedicated page (e.g. 747.html) so protocol matches.
    const params = new URLSearchParams(location.search);
    const screen = screenParam(opts.screen);
    if (screen) params.set('screen', screen);
    params.delete('face');
    const qs = params.toString();
    location.replace(page + (qs ? '?' + qs : ''));
    return true;
  }

  global.LIM_pageForProtocol = pageForProtocol;
  global.LIM_is737FamilyProtocol = is737FamilyProtocol;
  global.LIM_maybeRedirect = maybeRedirect;

  function limClickVolume() {
    var n = Number('__LIM_CLICK_VOLUME__');
    if (!isFinite(n)) return 0.45;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function limClickStyle() {
    var text = String('__LIM_CLICK_STYLE__').trim().toLowerCase().replace(/_/g, '-');
    if (text === 'single' || text === 'one' || text === 'click') return 'single';
    return 'press-release';
  }

  function limClickSoundName() {
    var text = String('__LIM_CLICK_SOUND__').trim().toLowerCase();
    if (text === 'press' || text === 'buttonpress' || text === 'button-press') return 'press';
    if (text === 'release' || text === 'buttonrelease' || text === 'button-release') return 'release';
    return 'click';
  }

  var SOUND_URL = {
    click: 'button-click.wav?v=20261114-1',
    press: 'ButtonPress.wav?v=20261114-1',
    release: 'ButtonRelease.wav?v=20261114-1',
  };
  var POOL_SIZE = 4;
  var soundPools = Object.create(null);
  var soundIx = Object.create(null);

  function soundPool(name) {
    var key = SOUND_URL[name] ? name : 'click';
    if (soundPools[key]) return soundPools[key];
    var url = SOUND_URL[key];
    var pool = [];
    for (var i = 0; i < POOL_SIZE; i++) {
      var clip = new Audio(url);
      clip.preload = 'auto';
      clip.volume = limClickVolume();
      pool.push(clip);
    }
    soundPools[key] = pool;
    soundIx[key] = 0;
    return pool;
  }

  function playNamed(name) {
    var key = SOUND_URL[name] ? name : 'click';
    var pool = soundPool(key);
    var ix = soundIx[key] || 0;
    var clip = pool[ix];
    soundIx[key] = (ix + 1) % pool.length;
    if (!clip) return;
    clip.volume = limClickVolume();
    try { clip.currentTime = 0; } catch (_e) { /* not loaded yet */ }
    var pending = clip.play();
    if (pending && pending.catch) pending.catch(function () { /* gesture unlocks audio */ });
  }

  function limPlayKeyDown() {
    if (limClickStyle() === 'single') playNamed(limClickSoundName());
    else playNamed('press');
  }

  function limPlayKeyUp() {
    if (limClickStyle() === 'single') return;
    playNamed('release');
  }

  /** One-shot for faces that still fire on click or keydown without a matching up. */
  function limPlayClick() {
    if (limClickStyle() === 'single') {
      playNamed(limClickSoundName());
      return;
    }
    playNamed('press');
    setTimeout(function () { playNamed('release'); }, 45);
  }

  global.limClickVolume = limClickVolume;
  global.limClickStyle = limClickStyle;
  global.limPlayKeyDown = limPlayKeyDown;
  global.limPlayKeyUp = limPlayKeyUp;
  global.limPlayClick = limPlayClick;
})(window);
