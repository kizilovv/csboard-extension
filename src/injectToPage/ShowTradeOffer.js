// Override Steam's ShowTradeOffer so trade-offer links open in a popup window
// (sized like the original Steam window) instead of a new tab. Steam recently
// changed its built-in behaviour to default to a tab; passing explicit
// width/height feature flags forces popup-window behaviour in Chromium.
function ShowTradeOffer(tradeOfferID, rgParams) {
  var strParams = '';
  if (rgParams && typeof window.$J !== 'undefined' && typeof window.$J.param === 'function') {
    strParams = '?' + window.$J.param(rgParams);
  }

  var strKey = (tradeOfferID === 'new')
    ? ('NewTradeOffer' + (rgParams && rgParams.partner ? rgParams.partner : ''))
    : ('TradeOffer' + tradeOfferID);

  var url = 'https://steamcommunity.com/tradeoffer/' + tradeOfferID + '/' + strParams;
  // Explicit width/height makes Chromium treat this as a popup window
  // instead of a tab, which is what the user expects from Steam's UI.
  var features = 'menubar=yes,location=yes,resizable=yes,scrollbars=yes,status=yes,width=1136,height=860';

  var winOffer = window.open(url, strKey, features);
  if (winOffer && typeof winOffer.focus === 'function') winOffer.focus();
}
