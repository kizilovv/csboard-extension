/*
  The page half of the incoming-offer scam warning.

  The background decides which offers are the scam (see
  `shared/p2p-scam-offers.ts` for the rule and the 2026-09 incident) and stores
  them under `p2p.scamOffers`. This module only reads that list and marks what
  it names: a red block and a two-click Accept on the offer's own page, a red
  label on the offers list. It never reads the network, never judges an offer
  itself, and never touches an offer that is not in the list.

  ── NOT BEHIND THE SITE SWITCH ────────────────────────────────────────────

  `trade-offer.ts` and `trade-offers.ts` start this BEFORE their own
  `whenSiteEnabled` gate. Turning off the price overlays on Steam is a choice
  about decorations; it is not a choice to lose a sold skin to a farm account,
  and a seller who switched them off is no less a target. Same reasoning as
  `p2p-send`, which keeps delivering with the switch off.

  ── AND OUT OF THE SEND FLOW'S WAY ────────────────────────────────────────

  `p2p-send.ts` shares the `/tradeoffer/*` pages: it sends from
  `/tradeoffer/new/` and cancels on `/tradeoffer/<id>/`. Neither can meet this:
  `new` has no offer id, and the offers it cancels are ones the seller SENT,
  which the rule never flags.
*/

import { loadLocalePreference, resolveLocale, tFor, type Locale } from '../../shared/i18n';
import { P2P_SCAM_OFFERS_KEY, readStoredScamFlags } from '../../shared/p2p-scam-offers';

const WARNING_ID = 'csboard-scam-warning';
const CONFIRM_HINT_CLASS = 'csboard-scam-confirm-hint';
const LIST_OFFER_CLASS = 'csboard-scam-offer';
const LIST_LABEL_CLASS = 'csboard-scam-offer-label';

/** Steam's Accept button on an offer page (it reads "Send Counter Offer" in counter mode). */
const ACCEPT_BUTTON_SELECTOR = '#trade_confirmbtn';

/*
  A second click that lands this soon after the first is the same double-click,
  not a decision. Without this, a reflexive double-click walks straight through
  the gate it was meant to stop.
*/
const SAME_GESTURE_MS = 700;

async function pageLocale(): Promise<Locale> {
  try {
    return resolveLocale(await loadLocalePreference());
  } catch {
    return 'en';
  }
}

async function readFlaggedOfferIds(): Promise<Set<string>> {
  try {
    const stored = await chrome.storage.local.get(P2P_SCAM_OFFERS_KEY);
    return new Set(readStoredScamFlags(stored?.[P2P_SCAM_OFFERS_KEY]).map((flag) => flag.offerId));
  } catch {
    // No list, no marks. The notification is the other channel.
    return new Set();
  }
}

/** The background refreshes the list each pass; a page left open follows it. */
function onFlaggedOfferIdsChanged(apply: (ids: Set<string>) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[P2P_SCAM_OFFERS_KEY];
      if (!change) return;
      apply(new Set(readStoredScamFlags(change.newValue).map((flag) => flag.offerId)));
    });
  } catch {
    // Extension context gone (reloaded under an open tab): the page keeps what it drew.
  }
}

/**
 * The offer's own page: `/tradeoffer/<id>/`.
 *
 * A flagged offer gets the warning above the trade area, and its Accept button
 * a second click: the first one is swallowed and says so. No `alert` or
 * `confirm`: a native dialog is exactly what a seller clicks through without
 * reading, and Steam's own confirmations have trained him to.
 */
export function guardScamOfferPage(): void {
  const offerId = /^\/tradeoffer\/([0-9]+)/.exec(window.location.pathname)?.[1];
  if (!offerId) return;

  let flagged = false;
  let locale: Locale = 'en';
  let armedAt: number | null = null;

  const render = (): void => {
    const existing = document.getElementById(WARNING_ID);
    if (!flagged) {
      existing?.remove();
      document.querySelectorAll(`.${CONFIRM_HINT_CLASS}`).forEach((hint) => hint.remove());
      armedAt = null;
      return;
    }
    if (existing) return;
    const block = document.createElement('div');
    block.id = WARNING_ID;
    block.className = 'csboard-scam-warning';
    block.setAttribute('role', 'alert');
    const title = document.createElement('strong');
    title.textContent = tFor(locale, 'p2pScam.title');
    const body = document.createElement('p');
    body.textContent = tFor(locale, 'p2pScam.body');
    block.append(title, body);
    const tradeArea = document.getElementById('trade_area');
    if (tradeArea?.parentElement) {
      tradeArea.insertAdjacentElement('beforebegin', block);
    } else {
      (document.getElementById('mainContent') ?? document.body).prepend(block);
    }
  };

  const showConfirmHint = (button: Element): void => {
    if (document.querySelector(`.${CONFIRM_HINT_CLASS}`)) return;
    const hint = document.createElement('div');
    hint.className = CONFIRM_HINT_CLASS;
    hint.setAttribute('role', 'alert');
    hint.textContent = tFor(locale, 'p2pScam.confirmAgain');
    button.insertAdjacentElement('beforebegin', hint);
  };

  /*
    Capture phase on the window, so this runs before any handler Steam put on
    the button or its ancestors, and before an inline `onclick` or a
    `javascript:` href. Only while the offer is flagged, only on the Accept
    button; every other click on the page is untouched.
  */
  window.addEventListener('click', (event) => {
    if (!flagged) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(ACCEPT_BUTTON_SELECTOR);
    if (!button) return;
    const now = Date.now();
    if (armedAt !== null && now - armedAt >= SAME_GESTURE_MS) {
      // The second, deliberate click: Steam takes it from here. The next
      // attempt, if this one is abandoned, asks again.
      armedAt = null;
      document.querySelectorAll(`.${CONFIRM_HINT_CLASS}`).forEach((hint) => hint.remove());
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (armedAt === null) armedAt = now;
    showConfirmHint(button);
  }, true);

  onFlaggedOfferIdsChanged((ids) => {
    flagged = ids.has(offerId);
    render();
  });
  void (async () => {
    locale = await pageLocale();
    flagged = (await readFlaggedOfferIds()).has(offerId);
    render();
  })();
}

/**
 * The offers list: a red frame and a label on each flagged offer. Accepting
 * from the list goes through the offer's own page, where the gate is.
 */
export function markScamOffersOnList(): void {
  let locale: Locale = 'en';

  const apply = (ids: Set<string>): void => {
    for (const offerEl of document.querySelectorAll<HTMLElement>('[id^="tradeofferid_"]')) {
      const flagged = ids.has(offerEl.id.slice('tradeofferid_'.length));
      offerEl.classList.toggle(LIST_OFFER_CLASS, flagged);
      const label = offerEl.querySelector(`:scope > .${LIST_LABEL_CLASS}`);
      if (flagged && !label) {
        const tag = document.createElement('div');
        tag.className = LIST_LABEL_CLASS;
        tag.textContent = tFor(locale, 'p2pScam.label');
        tag.title = tFor(locale, 'p2pScam.body');
        offerEl.insertAdjacentElement('afterbegin', tag);
      } else if (!flagged && label) {
        label.remove();
      }
    }
  };

  onFlaggedOfferIdsChanged(apply);
  void (async () => {
    locale = await pageLocale();
    apply(await readFlaggedOfferIds());
  })();
}
