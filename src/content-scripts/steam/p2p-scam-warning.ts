/*
  The page half of the scam warnings: the P2P "not your buyer" one and the
  buyout "not the buyout bot" one.

  The background decides which offers match (the rules and incidents are in
  `shared/p2p-scam-offers.ts` and `shared/buyout-scam-offers.ts`) and stores
  them under `p2p.scamOffers` and `buyout.scamOffers`. This module reads those
  lists and marks what they name: a red block and a two-click Accept on the
  offer's own page, a red frame and label on the offers list. It never judges
  an offer by the rule itself, and never touches one that is not listed.

  ── ONLY ON A LOSS ────────────────────────────────────────────────────────

  A listed offer is still left alone when the user provably comes out ahead or
  even (owner, 2026-09-28). That is decided here, where the prices are, with
  the offers list's own P/L maths (`shared/offer-valuation.ts`) and the same
  offer data the list prices from (the background's FETCH_STEAM_TRADE_OFFERS).
  No price, no offer data, no answer: the warning stays, because "cannot prove
  it is fair" is not "fair". See `scamWarningStands`.

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
  which neither rule flags.
*/

import { loadLocalePreference, resolveLocale, tFor, type Locale, type MessageKey } from '../../shared/i18n';
import { BUYOUT_SCAM_OFFERS_KEY } from '../../shared/buyout-scam-offers';
import { offerItemPrice, valueOffer, type OfferValue } from '../../shared/offer-valuation';
import { P2P_SCAM_OFFERS_KEY, readStoredScamFlags, scamWarningStands } from '../../shared/p2p-scam-offers';
import { priceEngine } from '../../shared/price-engine';
import { readSteamPageCredential } from '../../shared/steam-page-credential';

const WARNING_CLASS = 'csboard-scam-warning';
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

type ScamKind = 'p2p' | 'buyout';

/** Storage key and texts per kind. Buyout first: a stolen API key is the worse news. */
const KINDS: ReadonlyArray<{
  readonly kind: ScamKind;
  readonly key: string;
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly label: MessageKey;
}> = [
  { kind: 'buyout', key: BUYOUT_SCAM_OFFERS_KEY, title: 'buyoutScam.title', body: 'buyoutScam.body', label: 'buyoutScam.label' },
  { kind: 'p2p', key: P2P_SCAM_OFFERS_KEY, title: 'p2pScam.title', body: 'p2pScam.body', label: 'p2pScam.label' },
];

/** offerId → the kinds of warning it carries. */
type FlaggedOffers = Map<string, ScamKind[]>;

async function pageLocale(): Promise<Locale> {
  try {
    return resolveLocale(await loadLocalePreference());
  } catch {
    return 'en';
  }
}

function collectFlags(values: Readonly<Record<string, unknown>>): FlaggedOffers {
  const flagged: FlaggedOffers = new Map();
  for (const { kind, key } of KINDS) {
    for (const flag of readStoredScamFlags(values[key])) {
      flagged.set(flag.offerId, [...(flagged.get(flag.offerId) ?? []), kind]);
    }
  }
  return flagged;
}

async function readFlaggedOffers(): Promise<FlaggedOffers> {
  try {
    return collectFlags(await chrome.storage.local.get(KINDS.map(({ key }) => key)));
  } catch {
    // No list, no marks.
    return new Map();
  }
}

/** The background refreshes both lists each pass; a page left open follows them. */
function onFlaggedOffersChanged(apply: (flagged: FlaggedOffers) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!KINDS.some(({ key }) => changes[key])) return;
      void readFlaggedOffers().then(apply);
    });
  } catch {
    // Extension context gone (reloaded under an open tab): the page keeps what it drew.
  }
}

interface OffersResponse {
  readonly offers?: { readonly trade_offers_received?: ReadonlyArray<Record<string, unknown>> };
  readonly items?: ReadonlyArray<{ classid: string; instanceid: string; market_hash_name?: string; icon_url?: unknown }>;
}

/*
  What each listed offer is worth to each side, or nothing for an offer that
  could not be valued. The same read and the same maths as the list's P/L
  badge; asked for only when there is a listed offer on the page.
*/
async function valueReceivedOffers(offerIds: ReadonlySet<string>): Promise<Map<string, OfferValue>> {
  const values = new Map<string, OfferValue>();
  if (offerIds.size === 0) return values;
  let response: OffersResponse | null;
  try {
    await priceEngine.init();
    response = await new Promise<OffersResponse | null>((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'FETCH_STEAM_TRADE_OFFERS',
          data: { sent: 0, received: 1, ...(readSteamPageCredential() ?? {}) },
        },
        (reply) => {
          if (chrome.runtime.lastError || !reply || reply.error) resolve(null);
          else resolve(reply as OffersResponse);
        },
      );
    });
  } catch {
    response = null;
  }
  const items = response?.items ?? [];
  for (const offer of response?.offers?.trade_offers_received ?? []) {
    const offerId = offer['tradeofferid'];
    if (typeof offerId !== 'string' || !offerIds.has(offerId)) continue;
    values.set(offerId, valueOffer(
      offer as { items_to_give?: Array<{ classid: string; instanceid: string }>; items_to_receive?: Array<{ classid: string; instanceid: string }> },
      (item) => offerItemPrice(item, items, (name, phase) => priceEngine.getPrice(name, phase)),
    ));
  }
  return values;
}

/*
  Values are asked for once per offer per page: an offer's items do not change,
  and the list refreshes every pass. An offer the read did not value is asked
  about again on the next change — maybe the credential is there by then.
*/
function createValuer(): (offerIds: Iterable<string>) => Promise<Map<string, OfferValue>> {
  const known = new Map<string, OfferValue>();
  return async (offerIds) => {
    const missing = new Set([...offerIds].filter((id) => !known.has(id)));
    for (const [id, value] of await valueReceivedOffers(missing)) known.set(id, value);
    return known;
  };
}

/**
 * The offer's own page: `/tradeoffer/<id>/`.
 *
 * A listed offer that is a loss (or cannot be valued) gets the warning above
 * the trade area, and its Accept button a second click: the first one is
 * swallowed and says so. No `alert` or `confirm`: a native dialog is exactly
 * what a user clicks through without reading, and Steam's own confirmations
 * have trained him to.
 */
export function guardScamOfferPage(): void {
  const offerId = /^\/tradeoffer\/([0-9]+)/.exec(window.location.pathname)?.[1];
  if (!offerId) return;

  let kinds: ScamKind[] = [];
  /*
    `undefined` while the valuation is still coming. The Accept gate holds in
    that window (a listed offer is guilty until priced); the red block waits,
    so a profitable offer does not flash a warning and take it back.
  */
  let stands: boolean | undefined;
  let locale: Locale = 'en';
  let armedAt: number | null = null;
  const valueOf = createValuer();

  const guarded = (): boolean => kinds.length > 0 && stands !== false;

  const render = (): void => {
    document.querySelectorAll(`.${WARNING_CLASS}`).forEach((block) => block.remove());
    if (!guarded()) {
      document.querySelectorAll(`.${CONFIRM_HINT_CLASS}`).forEach((hint) => hint.remove());
      armedAt = null;
      return;
    }
    if (stands !== true) return;
    const tradeArea = document.getElementById('trade_area');
    for (const kind of kinds) {
      const texts = KINDS.find((entry) => entry.kind === kind);
      if (!texts) continue;
      const block = document.createElement('div');
      block.className = WARNING_CLASS;
      block.setAttribute('role', 'alert');
      const title = document.createElement('strong');
      title.textContent = tFor(locale, texts.title);
      const body = document.createElement('p');
      body.textContent = tFor(locale, texts.body);
      block.append(title, body);
      if (tradeArea?.parentElement) {
        tradeArea.insertAdjacentElement('beforebegin', block);
      } else {
        (document.getElementById('mainContent') ?? document.body).prepend(block);
      }
    }
  };

  const apply = async (flagged: FlaggedOffers): Promise<void> => {
    kinds = flagged.get(offerId) ?? [];
    if (kinds.length === 0) {
      render();
      return;
    }
    render();
    const values = await valueOf([offerId]);
    stands = scamWarningStands(values.get(offerId) ?? null);
    render();
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
    `javascript:` href. Only while the offer is guarded, only on the Accept
    button; every other click on the page is untouched.
  */
  window.addEventListener('click', (event) => {
    if (!guarded()) return;
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

  onFlaggedOffersChanged((flagged) => { void apply(flagged); });
  void (async () => {
    locale = await pageLocale();
    await apply(await readFlaggedOffers());
  })();
}

/**
 * The offers list: a red frame and a label on each listed offer that is a
 * loss or cannot be valued. Accepting from the list goes through the offer's
 * own page, where the gate is.
 */
export function markScamOffersOnList(): void {
  let locale: Locale = 'en';
  const valueOf = createValuer();

  const apply = async (flagged: FlaggedOffers): Promise<void> => {
    const offerEls = [...document.querySelectorAll<HTMLElement>('[id^="tradeofferid_"]')];
    const idOf = (el: HTMLElement): string => el.id.slice('tradeofferid_'.length);
    const listedHere = offerEls.map(idOf).filter((id) => flagged.has(id));
    const values = listedHere.length > 0 ? await valueOf(listedHere) : new Map<string, OfferValue>();

    for (const offerEl of offerEls) {
      const offerId = idOf(offerEl);
      const kinds = flagged.get(offerId) ?? [];
      const marked = kinds.length > 0 && scamWarningStands(values.get(offerId) ?? null);
      offerEl.classList.toggle(LIST_OFFER_CLASS, marked);
      offerEl.querySelector(`:scope > .${LIST_LABEL_CLASS}`)?.remove();
      const texts = KINDS.find((entry) => entry.kind === kinds[0]);
      if (!marked || !texts) continue;
      const tag = document.createElement('div');
      tag.className = LIST_LABEL_CLASS;
      tag.textContent = tFor(locale, texts.label);
      tag.title = tFor(locale, texts.body);
      offerEl.insertAdjacentElement('afterbegin', tag);
    }
  };

  onFlaggedOffersChanged((flagged) => { void apply(flagged); });
  void (async () => {
    locale = await pageLocale();
    await apply(await readFlaggedOffers());
  })();
}
