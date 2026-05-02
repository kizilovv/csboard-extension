// Visits all inventory pages to force Steam to create DOM elements
// Injected as <script src="..."> to bypass CSP
(function() {
  'use strict';

  var totalItems = 0;
  try {
    var ctxIds = [2, 16];
    for (var c = 0; c < ctxIds.length; c++) {
      try {
        var inv = UserYou.getInventory(730, ctxIds[c]);
        if (inv && inv.m_rgAssets) totalItems += Object.keys(inv.m_rgAssets).length;
      } catch(e) {}
    }
  } catch(e) {}

  var totalPages = Math.ceil(totalItems / 25) || 1;
  if (totalPages <= 2) {
    document.body.setAttribute('csboard_pagesVisited', 'skip');
    return;
  }

  console.log('[CSBOARD] Visiting ' + totalPages + ' pages to create DOM...');

  // Find next/prev page controls
  var nextBtn = document.getElementById('pagebtn_next');
  if (!nextBtn) {
    // Try other selectors
    var spans = document.querySelectorAll('#inventories .pagebtn');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].id && spans[i].id.indexOf('next') !== -1) { nextBtn = spans[i]; break; }
    }
  }

  var prevBtn = document.getElementById('pagebtn_previous');
  if (!prevBtn) {
    var spans2 = document.querySelectorAll('#inventories .pagebtn');
    for (var j = 0; j < spans2.length; j++) {
      if (spans2[j].id && spans2[j].id.indexOf('previous') !== -1) { prevBtn = spans2[j]; break; }
    }
  }

  if (!nextBtn) {
    console.log('[CSBOARD] No next button found, skipping page visit');
    document.body.setAttribute('csboard_pagesVisited', 'no_btn');
    return;
  }

  // Hide inventory during flip
  var inventoriesEl = document.getElementById('inventories');
  if (inventoriesEl) {
    inventoriesEl.style.opacity = '0';
    inventoriesEl.style.pointerEvents = 'none';
  }

  var fwd = 0;
  function goForward() {
    if (fwd >= totalPages - 1) {
      goBackward();
      return;
    }
    nextBtn.click();
    fwd++;
    setTimeout(goForward, 50);
  }

  var back = 0;
  function goBackward() {
    if (back >= totalPages - 1 || !prevBtn) {
      finish();
      return;
    }
    prevBtn.click();
    back++;
    setTimeout(goBackward, 30);
  }

  function finish() {
    if (inventoriesEl) {
      inventoriesEl.style.opacity = '';
      inventoriesEl.style.pointerEvents = '';
    }
    var holders = document.querySelectorAll('#inventories .itemHolder').length;
    console.log('[CSBOARD] Page visit done, holders: ' + holders);
    document.body.setAttribute('csboard_pagesVisited', String(holders));
  }

  goForward();
})();
