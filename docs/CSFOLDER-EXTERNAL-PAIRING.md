# CSFolder external pairing contract

CSFolder may call exactly two bounded mutating extension messages from the
canonical production origin `https://csfolder.com`: fresh pairing and
idempotent reactivation of an already-paired device. The manifest does not grant the
extension host access to CSFolder, and CSFolder cannot call any internal popup,
Steam, unpair or manual-sync message.

## Browser call

The CSFolder client needs the published Chrome Web Store extension ID in a
public build variable (recommended name:
`NEXT_PUBLIC_CSBOARD_EXTENSION_ID`). An unpacked development build has a
different ID unless Chrome is given the Store public key, so production pairing
must use the ID of the reviewed Store listing.

```ts
chrome.runtime.sendMessage(
  extensionId,
  {
    version: 1,
    type: "PAIR_AND_ENABLE_PORTFOLIO_SYNC",
    requestId: crypto.randomUUID(),
    code: "CSF-2345-6789-ABCD-EFGH",
  },
  (response) => {
    // Always inspect chrome.runtime.lastError before response.
  },
);
```

The request has exactly four top-level keys. `requestId` is a UUID v4 or 1–64
characters from `[A-Za-z0-9_-]`. `code` is the existing 23-character,
five-minute, single-use CSFolder code. Unknown fields, wrong casing, non-HTTPS
origins and requests over 2 KiB are rejected before any storage or network
handler runs.

When CSFolder already has a durable device binding, it first sends the exact
three-key request below. It carries no pairing code, sources, Steam identity or
other caller-controlled options:

```ts
chrome.runtime.sendMessage(extensionId, {
  version: 1,
  type: "REACTIVATE_PORTFOLIO_SYNC",
  requestId: crypto.randomUUID(),
}, callback);
```

The extension accepts it only when its gateway controller still has a local
registration. Otherwise it returns `NOT_PAIRED` without changing settings.
Successful reactivation clears scheduler residue, enables exactly Inventory +
Trade History, opens the existing upload fence and hands one run to the same
fenced sync path as the popup. Replays are idempotent, and fresh pairing and
reactivation share one in-flight guard.

## Success

```json
{
  "version": 1,
  "requestId": "same-request-id",
  "ok": true,
  "data": {
    "paired": true,
    "portfolioSyncEnabled": true,
    "enabledSources": ["inventory", "tradeHistory"],
    "syncTriggered": true
  }
}
```

`syncTriggered` means the request was handed to the extension's existing
fenced sync path. The CSFolder status endpoint remains the source of truth for
record counts and completion; the extension response intentionally exposes no
inventory, Steam identity, credentials or transport internals.

## Failure

```json
{
  "version": 1,
  "requestId": "same-request-id-or-null",
  "ok": false,
  "error": { "code": "PAIRING_FAILED" }
}
```

Public error codes are:

- `UNAUTHORIZED_ORIGIN`
- `INVALID_MESSAGE`
- `UNSUPPORTED_VERSION`
- `ACTION_IN_PROGRESS`
- `NOT_PAIRED`
- `PAIRING_FAILED`
- `ACTIVATION_FAILED`
- `SYNC_TRIGGER_FAILED`

Pair failure never enables uploads. If source activation or sync handoff fails,
the extension raises its local upload fence and restores the disabled source
baseline. Internal network, storage and Steam errors are never returned to the
page.

`GET_EXTENSION_STATUS` remains separately available only to
`https://csboard.com` and `https://csboard.trade` with its existing version-1
response contract.
