// Trade History Page — runs inside chrome-extension:// context
// Fetches from Steam API via service worker, renders locally

let allTrades = [];
let lastTradeId = '0';
let lastTradeTime = 0;
let hasMore = false;
let loading = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchTrades(maxTrades = 50) {
  loading = true;
  render();

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_TRADE_HISTORY', data: { maxTrades, startAfterTime: lastTradeTime, startAfterTradeId: lastTradeId } },
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
      lastTradeId = last.tradeId || lastTradeId;
      lastTradeTime = last.occurredAt || lastTradeTime;
    }
    hasMore = result.hasMore === true;

    document.getElementById('summary').textContent = `Total in Steam: ${result.totalTrades || '?'}`;
  } catch (err) {
    document.getElementById('trades').innerHTML =
      `<div class="error">Error: ${escapeHtml(err)}</div>`;
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

  // Prices are today's market values at the user's chosen source, so the P/L
  // shown is "what this trade would be worth now", not a realised result. The
  // label says so rather than dropping the number, which is what people
  // actually use this page for.
  const totalPL = trades.reduce((sum, trade) => sum + (trade.profitLossUsd || 0), 0);
  const plClass = totalPL > 0.5 ? 'profit' : totalPL < -0.5 ? 'loss' : 'neutral';
  const summaryEl = document.getElementById('summary');
  summaryEl.innerHTML =
    `P/L at today's prices: <span class="${plClass}">${totalPL >= 0 ? '+' : '-'}$${Math.abs(totalPL).toFixed(2)}</span>` +
    ` in ${trades.length} trades`;

  // Trades
  let html = '';
  trades.forEach((trade, idx) => {
    const given = trade.itemsGiven || [];
    const received = trade.itemsReceived || [];
    const date = new Date(Number(trade.occurredAt) * 1000);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const partnerSteamId = /^7656119\d{10}$/.test(String(trade.partnerSteamId ?? ''))
      ? String(trade.partnerSteamId)
      : '';
    const partner = partnerSteamId
      ? `<a href="https://steamcommunity.com/profiles/${partnerSteamId}" target="_blank" rel="noopener noreferrer">${partnerSteamId}</a>`
      : 'Unknown partner';

    const pl = trade.profitLossUsd || 0;
    const plStr = `${pl >= 0 ? '+' : '-'}$${Math.abs(pl).toFixed(2)}`;
    const plCls = pl > 0.5 ? 'profit' : pl < -0.5 ? 'loss' : 'neutral';
    const givenTotal = (trade.totalGivenUsd || 0).toFixed(2);
    const receivedTotal = (trade.totalReceivedUsd || 0).toFixed(2);
    // Percentage only means something against a non-zero basis; an unpriced
    // give side would otherwise render as a confident 0.0%.
    const pct = trade.totalGivenUsd > 0
      ? `${((pl / trade.totalGivenUsd) * 100).toFixed(1)}%`
      : '';

    html += `<div class="trade">
      <div class="trade-header">
        <span class="index">#${idx + 1}</span>
        <span class="partner">Trade with ${partner}</span>
        <span class="date">${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</span>
      </div>
      <div class="trade-sides">
        <div>
          <div class="side-label given">Given (${given.length}) \u00b7 $${givenTotal}</div>
          <div class="items">${renderItems(given)}</div>
        </div>
        <div class="exchange">
          <div class="exchange-icon ${plCls}">${pl > 0.5 ? '\u2191' : pl < -0.5 ? '\u2193' : '\u2194'}</div>
          <div class="pl-value ${plCls}">${plStr}</div>
          <div class="pl-pct">${pct}</div>
        </div>
        <div>
          <div class="side-label received">Received (${received.length}) \u00b7 $${receivedTotal}</div>
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
    const name = item.marketHashName || 'Unknown CS2 item';
    const quantity = /^\d{1,4}$/.test(String(item.amount ?? '1'))
      ? String(item.amount ?? '1')
      : '1';
    const price = typeof item.priceDisplay === 'string' ? item.priceDisplay : '';
    // The worker resolves icons to an absolute Steam CDN URL and rejects
    // anything that is not a plain economy-image path, so nothing here can
    // point the <img> at another origin.
    // Validated as a bare hex colour by the worker before it gets here.
    const nameColor = /^#[0-9a-fA-F]{6}$/.test(String(item.nameColor ?? ''))
      ? ` style="color: ${item.nameColor}"`
      : '';
    const icon = typeof item.iconUrl === 'string' && item.iconUrl.startsWith('https://')
      ? `<img class="item-icon" src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy">`
      : '';
    return `<div class="item">
      ${icon}
      <div class="item-info">
        <span class="item-name"${nameColor} title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="item-price">${escapeHtml(price)}</span>
      </div>
      ${quantity === '1' ? '' : `<span class="item-qty">\u00d7${quantity}</span>`}
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
