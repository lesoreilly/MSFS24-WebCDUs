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

    // index.html uses cdu.js for its own routing — do not fight it.
    if (here === 'index.html') return false;

    // Hub maps "/" to a face page without changing the URL, so `here` can be "".
    // Still navigate to the dedicated page (e.g. 747.html) so protocol matches.
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
})(window);
