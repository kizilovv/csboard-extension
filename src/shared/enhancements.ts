/*
  The one gate every on-page enhancement passes through.

  What the extension draws is decided per site: `showOnSteam`,
  `showCsboardPricesOnCsfloat` and `showBetterBuffOnBuff`, each ANDed with the
  legacy `enhancementsEnabled` master. The master no longer has a control in the
  popup — migration 4 folded a stored "off" into the three site flags — but it
  is still read here so an old profile that never ran that migration stays
  muted rather than lighting up unasked.

  It is read in this module rather than inside each script so there is a single
  place to grep for "what does the off switch actually turn off", and so a
  script that forgets the check is visible by the absence of one line.

  Two content scripts deliberately do NOT use this: `p2p-send`, which delivers
  and cancels sales the seller has already committed to, and
  `page-credential-bridge`, which keeps the Steam read session alive that the
  delivery tracking depends on. Muting the decorations must not quietly stop a
  seller fulfilling his orders.
*/

import { getSettings } from './storage';

export type EnhancementSite = 'steam' | 'csfloat' | 'buff';

const SITE_SETTING_KEYS = {
  steam: 'showOnSteam',
  csfloat: 'showCsboardPricesOnCsfloat',
  buff: 'showBetterBuffOnBuff',
} as const;

/*
  Buff is the one site that has to be asked for.

  Its enhancements rewrite a marketplace UI rather than annotate it, so an
  install that has never seen the toggle must leave buff.163.com alone. Steam
  and CSFloat have drawn by default since 1.0 and an absent key there means the
  profile predates the switch, not that the user declined.
*/
const SITE_DEFAULTS: Readonly<Record<EnhancementSite, boolean>> = {
  steam: true,
  csfloat: true,
  buff: false,
};

export async function isSiteEnabled(site: EnhancementSite): Promise<boolean> {
  try {
    const settings = await getSettings();
    if (settings.enhancementsEnabled === false) return false;
    const stored = settings[SITE_SETTING_KEYS[site]];
    return typeof stored === 'boolean' ? stored : SITE_DEFAULTS[site];
  } catch {
    // Storage unreadable is not consent to go quiet on the sites that have
    // always drawn: failing closed there would look like the extension broke.
    return SITE_DEFAULTS[site];
  }
}

/** Start a content script only if its site is switched on. */
export function whenSiteEnabled(site: EnhancementSite, start: () => void): void {
  void isSiteEnabled(site).then((enabled) => {
    if (enabled) start();
  });
}
