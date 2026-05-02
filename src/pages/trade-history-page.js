// Trade History Page — runs inside chrome-extension:// context
// Fetches from Steam API via service worker, renders locally

let allTrades = [];
let lastTradeId = '0';
let lastTradeTime = 0;
let hasMore = false;
let loading = false;

function getAccessToken() {
  return new Promise((resolve) => {
    // Get from storage (set by content script on Steam pages)
    chrome.storage.local.get('csboard_steam_access_token', (data) => {
      resolve(data.csboard_steam_access_token || null);
    });
  });
}

// Ask service worker to re-mint the Steam access token (bound to current IP).
// SW fetches a steamcommunity page with the user's cookies and re-reads loyalty_webapi_token.
function refreshAccessToken() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'REFRESH_STEAM_ACCESS_TOKEN' }, (resp) => {
      if (chrome.runtime.lastError || resp?.error) { resolve(null); return; }
      resolve(resp?.accessToken || null);
    });
  });
}

async function fetchTrades(maxTrades = 50) {
  loading = true;
  render();

  let accessToken = await getAccessToken();
  if (!accessToken) {
    accessToken = await refreshAccessToken();
  }
  if (!accessToken) {
    document.getElementById('trades').innerHTML = '<div class="error">No Steam access token. Open <a href="https://steamcommunity.com/" target="_blank">steamcommunity.com</a>, make sure you are logged in, then reload this page.</div>';
    loading = false;
    return;
  }

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_TRADE_HISTORY', data: { accessToken, maxTrades, startAfterTime: lastTradeTime, startAfterTradeId: lastTradeId } },
        (resp) => {
          if (chrome.runtime.lastError) { reject(chrome.runtime.lastError.message); return; }
          if (resp?.error) { reject(resp.error); return; }
          resolve(resp);
        }
      );
    });

    if (result.trades && result.trades.length > 0) {
      allTrades = allTrades.concat(result.trades);
      const last = result.trades[result.trades.length - 1];
      lastTradeId = last.steamTradeId || lastTradeId;
      lastTradeTime = last.timeInit || lastTradeTime;
      hasMore = result.hasMore;
    }

    document.getElementById('summary').textContent = `Total in Steam: ${result.totalTrades || '?'}`;
  } catch (err) {
    document.getElementById('trades').innerHTML = `<div class="error">Error: ${err}</div>`;
  }

  loading = false;
  render();
}

function getFilteredTrades() {
  const excludeEmpty = document.getElementById('excludeEmpty').checked;
  if (!excludeEmpty) return allTrades;
  return allTrades.filter(t => t.itemsGiven.length > 0 && t.itemsReceived.length > 0);
}

function render() {
  const container = document.getElementById('trades');
  const loadMoreBtn = document.getElementById('loadMoreBtn');

  if (loading && allTrades.length === 0) {
    container.innerHTML = '<div class="spinner">Loading trade history...</div>';
    return;
  }

  const trades = getFilteredTrades();

  // Summary
  let totalPL = 0;
  trades.forEach(t => { totalPL += t.profitLossUsd || 0; });
  const plSign = totalPL >= 0 ? '+' : '';
  const plClass = totalPL > 0.5 ? 'profit' : totalPL < -0.5 ? 'loss' : '';
  const summaryEl = document.getElementById('summary');
  summaryEl.innerHTML = `P/L: <span class="${plClass}">${plSign}$${totalPL.toFixed(2)}</span> in ${trades.length} trades`;

  // Trades
  let html = '';
  trades.forEach((trade, idx) => {
    const given = trade.itemsGiven || [];
    const received = trade.itemsReceived || [];
    const pl = trade.profitLossUsd || 0;
    const plStr = (pl >= 0 ? '+' : '') + '$' + pl.toFixed(2);
    const plCls = pl > 0.5 ? 'profit' : pl < -0.5 ? 'loss' : 'neutral';
    const givenTotal = (trade.totalGivenUsd || 0).toFixed(2);
    const receivedTotal = (trade.totalReceivedUsd || 0).toFixed(2);
    const pct = trade.totalGivenUsd > 0 ? ((pl / trade.totalGivenUsd) * 100).toFixed(1) : '0.0';

    const date = new Date(trade.timeInit * 1000);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    html += `<div class="trade">
      <div class="trade-header">
        <span class="index">#${idx + 1}</span>
        <span class="partner">Trade with <a href="https://steamcommunity.com/profiles/${trade.partnerSteamId}" target="_blank">${trade.partnerName || trade.partnerSteamId}</a></span>
        <span class="date">${dateStr} ${timeStr}</span>
      </div>
      <div class="trade-sides">
        <div>
          <div class="side-label given">Given ($${givenTotal})</div>
          <div class="items">${renderItems(given)}</div>
        </div>
        <div class="exchange">
          <div class="exchange-icon ${plCls}">${pl > 0.5 ? '\u2191' : pl < -0.5 ? '\u2193' : '\u2194'}</div>
          <div class="pl-value ${plCls}">${plStr}</div>
          <div class="pl-pct">${pct}%</div>
        </div>
        <div>
          <div class="side-label received">Received ($${receivedTotal})</div>
          <div class="items">${renderItems(received)}</div>
        </div>
      </div>
    </div>`;
  });

  if (trades.length === 0 && !loading) {
    html = '<div class="spinner">No trades found</div>';
  }

  container.innerHTML = html;

  // Load more
  loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
  if (loading && allTrades.length > 0) {
    loadMoreBtn.textContent = 'Loading...';
    loadMoreBtn.disabled = true;
  } else {
    loadMoreBtn.textContent = 'Load More...';
    loadMoreBtn.disabled = false;
  }
}

function renderItems(items) {
  return items.map(item => {
    const imgUrl = item.iconUrl
      ? `https://community.akamai.steamstatic.com/economy/image/${item.iconUrl}/96x96`
      : '';
    const price = item.priceUsd != null ? `$${item.priceUsd.toFixed(2)}` : '';
    const nameStyle = item.nameColor ? `color: #${item.nameColor}` : '';
    return `<div class="item">
      ${imgUrl ? `<img src="${imgUrl}" alt="">` : ''}
      <div class="item-info">
        <span class="item-name" style="${nameStyle}" title="${item.marketHashName || item.name}">${item.name || item.marketHashName}</span>
        <span class="item-price">${price}</span>
      </div>
    </div>`;
  }).join('');
}

// Init
document.getElementById('refreshBtn').addEventListener('click', () => {
  allTrades = [];
  lastTradeId = '0';
  lastTradeTime = 0;
  hasMore = false;
  fetchTrades(parseInt(document.getElementById('pageSize').value));
});

document.getElementById('loadMoreBtn').addEventListener('click', () => {
  fetchTrades(parseInt(document.getElementById('pageSize').value));
});

document.getElementById('excludeEmpty').addEventListener('change', render);
document.getElementById('pageSize').addEventListener('change', () => {
  allTrades = [];
  lastTradeId = '0';
  lastTradeTime = 0;
  hasMore = false;
  fetchTrades(parseInt(document.getElementById('pageSize').value));
});

// Store access token from Steam pages (content script saves it)
fetchTrades(50);
