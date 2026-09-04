/*
  English is the source dictionary, not just one of the translations.

  Every other locale is typed against these keys, so a key that exists here and
  nowhere else fails `tsc` instead of silently rendering a raw key id in a
  popup. English is also the runtime fallback for a missing string, which is why
  no entry here may be empty.
*/

export const en = {
  // Header
  'lang.label': 'Language',
  'lang.auto': 'Auto',
  'status.checking': 'Checking…',
  'status.connected': 'Connected',
  'status.signedOut': 'Signed out',
  'status.offline': 'Offline',

  // Account strip
  'account.signIn': 'Sign in',
  'account.open': 'Open csboard',
  'account.premium': 'Premium',
  'account.signedOut': 'Not signed in',
  'account.offline': 'csboard unreachable',

  // Sites + notifications
  'sites.eyebrow': 'Show csboard on',
  'sites.steam': 'Steam',
  'sites.csfloat': 'CSFloat',
  'sites.buff': 'Buff163',
  'notifications.sales': 'Sale alerts',

  // Prices
  'prices.title': 'Prices',
  'prices.pull': 'Sync',
  'prices.currency': 'Currency',
  'prices.source': 'Source',
  'prices.follow': 'Follow csboard settings',
  'prices.refresh': 'Refresh',
  'prices.refreshing': 'Refreshing…',
  'prices.cache': '{count} prices',
  'prices.cacheEmpty': 'No prices cached',
  'prices.cacheUnknown': 'Cache unavailable',
  'prices.updated': 'updated {ago}',
  'prices.updatedNever': 'never fetched',
  'sync.off': 'Off — local values are kept',
  'sync.syncing': 'Syncing…',
  'sync.following': 'Following csboard',
  'sync.followingAgo': 'Following csboard · synced {ago}',
  'sync.warning': 'Synced with a warning: {code}',
  'sync.error': 'Sync failed — last values kept',
  'sync.signedOut': 'Sign in to csboard to sync',
  'sync.unavailable': 'Unavailable in this build',

  // CSFolder portfolio
  'portfolio.eyebrow': 'CSFolder',
  'portfolio.title': 'Portfolio sync',
  'portfolio.badge.checking': 'Checking',
  'portfolio.badge.unavailable': 'Unavailable',
  'portfolio.badge.unpaired': 'Unpaired',
  'portfolio.badge.paired': 'Paired',
  'portfolio.badge.enabled': 'Enabled',
  'portfolio.badge.revoked': 'Revoked',
  'portfolio.badge.mismatch': 'Mismatch',
  'portfolio.badge.error': 'Error',
  'portfolio.state.checking': 'Checking pairing…',
  'portfolio.state.unavailable': 'Unavailable in this build. Nothing is uploaded.',
  'portfolio.state.unpaired': 'Not paired. Installing never enables uploads.',
  'portfolio.state.pairedOff': 'Paired. Uploads are off.',
  'portfolio.state.pairedOn': 'Enabled sources sync automatically about once per hour.',
  'portfolio.state.paused': 'Paused by the connector. Retry manually.',
  'portfolio.state.revoked': 'Device revoked. Unpair, then pair again.',
  'portfolio.state.mismatch': 'Active Steam account is not the paired one. Sync blocked.',
  'portfolio.state.error': 'Connection error: {code}',
  'portfolio.pairLink': 'Pair in your CSFolder portfolio',
  'portfolio.steamId': 'Steam ID {id}',
  'portfolio.enable': 'Upload portfolio',
  'portfolio.sources.legend': 'Portfolio data sources',
  'portfolio.sources.inventory': 'Inventory',
  'portfolio.sources.tradeHistory': 'Trade history',
  'portfolio.src.off': 'Off',
  'portfolio.src.ready': 'Ready',
  'portfolio.src.queued': 'Queued',
  'portfolio.src.running': 'Syncing',
  'portfolio.src.synced': 'Synced',
  'portfolio.src.error': 'Error',
  'portfolio.src.on': 'On',
  'portfolio.src.unavailable': 'Not available',
  'portfolio.metric.lastOk': 'Last ok',
  'portfolio.metric.lastTry': 'Last try',
  'portfolio.metric.queued': 'Queued',
  'portfolio.syncNow': 'Sync now',
  'portfolio.syncing': 'Syncing…',
  'portfolio.unpair': 'Unpair',
  'portfolio.unpairConfirm': 'Unpair this browser from CSFolder? Queued data will not upload.',
  'portfolio.disclosure.summary': 'What gets uploaded',
  'portfolio.disclosure.body': 'Uploaded when you switch it on: inventory facts and up to 100 most recent Steam trades from the sources you pick, plus, for accepted offers from the last 30 days, a completed trade ID and an optional Buff163 or CSFloat hint. Never uploaded: active offers, raw Steam notes, Steam Market history, Steam credentials. Automatic sync runs about once per hour.',

  // Notices
  'notice.saveFailed': 'Could not save. Previous value restored.',
  'notice.reloadTab': 'Saved. Reload an open tab to apply.',
  'notice.notifyOn': 'You will be notified when a sale needs you.',
  'notice.notifyOff': 'Notifications off. The icon still shows the count.',
  'notice.prefsSynced': 'csboard price preferences synced.',
  'notice.pricesLoaded': 'Loaded {count} price rows.',
  'notice.pricesFailed': 'Refresh failed. Cached prices kept.',
  'notice.uploadsOn': 'Portfolio uploads enabled.',
  'notice.uploadsOff': 'Portfolio uploads paused.',
  'notice.unpaired': 'Device unpaired. Uploads disabled.',
  'notice.unpairFailed': 'Could not unpair. Nothing was deleted locally.',
  'notice.syncDone': 'Portfolio sync finished.',
  'notice.syncPartial': 'Some Steam sources were unavailable. The rest uploaded.',
  'notice.syncTruncated': 'Trade history partially synced — newest records only.',
  'notice.syncOversized': 'Finished, but oversized records were skipped.',
  'notice.syncWarning': 'Finished with a source warning. Check the source status.',
  'notice.syncFailed': 'Sync did not finish{cause}. Queued records will retry.',

  // Relative time
  'time.never': 'Never',
  'time.now': 'just now',
  'time.seconds': '{n}s ago',
  'time.minutes': '{n}m ago',
  'time.hours': '{n}h ago',
  'time.days': '{n}d ago',

  // Sanitized status codes the background reports
  'code.STEAM_SESSION_REQUIRED': 'sign in to Steam, or open a signed-in Steam tab',
  'code.STEAM_ACCOUNT_MISMATCH': 'active Steam account is not the paired one',
  'code.STEAM_RATE_LIMITED': 'Steam rate limit reached, retry later',
  'code.STEAM_UNAVAILABLE': 'Steam is temporarily unavailable',
  'code.STEAM_RESPONSE_INVALID': 'Steam returned an unsupported response',
  'code.STEAM_READ_FAILED': 'Steam read failed',
  'code.TRADE_HISTORY_TRUNCATED': 'partial, newest records only',
  'code.OVERSIZED_RECORDS_DROPPED': 'oversized records were skipped',
} as const;

export type MessageKey = keyof typeof en;
