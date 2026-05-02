// ============================================================
// CSBOARD — Inventory Data Extractor (injected into page context)
// ============================================================
// Loaded via <script src="chrome-extension://..."> to bypass Steam CSP.
// Reads inventory data from g_rgAppContextData (the reliable source)
// because g_ActiveInventory.m_rgAssets can be empty on initial load.
// Posts item data to content script via window.postMessage.

(function() {
  'use strict';

  var POLL_INTERVAL = 500;
  var MAX_ATTEMPTS = 40;
  var attempts = 0;
  var lastSentCount = 0;

  function extractFromAppContextData() {
    if (typeof g_rgAppContextData === 'undefined' || !g_rgAppContextData) return null;

    var cs2 = g_rgAppContextData['730'];
    if (!cs2 || !cs2.rgContexts) return null;

    var items = {};
    var totalCount = 0;

    // Iterate all contexts (2 = Inventory, 16 = Trade-protected, etc.)
    for (var ctxId in cs2.rgContexts) {
      if (!cs2.rgContexts.hasOwnProperty(ctxId)) continue;
      var ctx = cs2.rgContexts[ctxId];
      if (!ctx.inventory || !ctx.inventory.m_rgAssets) continue;

      var assets = ctx.inventory.m_rgAssets;
      var assetProps = ctx.inventory.m_rgAssetProperties || {};
      for (var assetId in assets) {
        if (!assets.hasOwnProperty(assetId)) continue;
        var asset = assets[assetId];
        var desc = asset.description || asset;
        if (!desc.market_hash_name && !desc.market_name && !desc.name) continue;

        // Extract float/paintseed from properties
        var propArr = [];
        try {
          var rawProp = assetProps[assetId];
          if (rawProp) {
            for (var pk in rawProp) {
              if (!rawProp.hasOwnProperty(pk)) continue;
              var p = rawProp[pk];
              if (p) propArr.push({propertyid:p.propertyid,int_value:p.int_value||null,float_value:p.float_value||null});
            }
          }
        } catch(e) {}

        items[assetId] = {
          assetid: String(assetId),
          market_hash_name: desc.market_hash_name || desc.market_name || desc.name || '',
          classid: String(desc.classid || asset.classid || ''),
          instanceid: String(desc.instanceid || asset.instanceid || '0'),
          name: desc.name || '',
          appid: String(desc.appid || asset.appid || '730'),
          icon_url: desc.icon_url || '',
          name_color: desc.name_color || '',
          marketable: desc.marketable || 0,
          tradable: desc.tradable || 0,
          contextid: String(ctxId),
          tags: desc.tags || [],
          descriptions: desc.descriptions || [],
          owner_descriptions: desc.owner_descriptions || [],
          properties: propArr.length > 0 ? propArr : null,
        };
        totalCount++;
      }
    }

    return totalCount > 0 ? items : null;
  }

  // Fallback: try g_ActiveInventory directly
  function extractFromActiveInventory() {
    if (typeof g_ActiveInventory === 'undefined' || !g_ActiveInventory) return null;
    if (!g_ActiveInventory.m_rgAssets || Object.keys(g_ActiveInventory.m_rgAssets).length === 0) return null;

    var items = {};
    var assets = g_ActiveInventory.m_rgAssets;
    for (var assetId in assets) {
      if (!assets.hasOwnProperty(assetId)) continue;
      var asset = assets[assetId];
      var desc = asset.description || asset;
      items[assetId] = {
        market_hash_name: desc.market_hash_name || desc.market_name || desc.name || '',
        classid: String(desc.classid || asset.classid || ''),
        instanceid: String(desc.instanceid || asset.instanceid || '0'),
        name: desc.name || '',
        appid: String(desc.appid || asset.appid || '730'),
        icon_url: desc.icon_url || '',
        name_color: desc.name_color || '',
        marketable: desc.marketable || 0,
        tradable: desc.tradable || 0,
      };
    }

    return Object.keys(items).length > 0 ? items : null;
  }

  function sendData() {
    var items = extractFromAppContextData() || extractFromActiveInventory();
    if (!items) return false;

    var count = Object.keys(items).length;
    // Avoid sending duplicate data
    if (count === lastSentCount && count > 0) return true;
    lastSentCount = count;

    window.postMessage({
      type: 'CSBOARD_INVENTORY_DATA',
      items: items
    }, '*');
    console.log('[CSBOARD] Inventory data extracted:', count, 'items');
    return true;
  }

  function waitForInventory() {
    if (sendData()) {
      hookInventoryChanges();
      return;
    }

    if (++attempts < MAX_ATTEMPTS) {
      setTimeout(waitForInventory, POLL_INTERVAL);
    } else {
      console.log('[CSBOARD] Inventory data not found after', MAX_ATTEMPTS, 'attempts');
    }
  }

  function hookInventoryChanges() {
    // Hook SelectInventory to detect game/context switches
    if (typeof window.SelectInventory === 'function' && !window.__csb_h_selectinv) {
      var origSelectInventory = window.SelectInventory;
      window.__csb_h_selectinv = true;
      window.SelectInventory = function() {
        var result = origSelectInventory.apply(this, arguments);
        var retries = 0;
        var reCheck = function() {
          if (sendData() || ++retries > 10) return;
          setTimeout(reCheck, 500);
        };
        setTimeout(reCheck, 500);
        return result;
      };
      console.log('[CSBOARD] SelectInventory hooked');
    }

    // Listen for csboard_allItemsLoaded attribute (set after LoadMoreAssets completes)
    // This re-extracts data after ALL pages are loaded (both ctx 2 + 16)
    var bodyObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === 'csboard_allitemsloaded' || mutations[i].attributeName === 'csboard_allItemsLoaded') {
          console.log('[CSBOARD] LoadMoreAssets done, re-extracting...');
          // Small delay to let Steam finish DOM updates
          setTimeout(function() {
            lastSentCount = 0; // Force re-send even if count is same
            sendData();
          }, 500);
        }
      }
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['csboard_allitemsloaded', 'csboard_allItemsLoaded'] });
  }

  waitForInventory();
})();
