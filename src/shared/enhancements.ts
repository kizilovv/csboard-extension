/*
  The one gate every on-page enhancement passes through.

  `enhancementsEnabled` is the user's master switch: off, this extension draws
  nothing anywhere. It is read here rather than inside each script so there is a
  single place to grep for "what does the off switch actually turn off", and so
  a script that forgets the check is visible by the absence of one line.

  Two content scripts deliberately do NOT use this: `p2p-send`, which delivers
  and cancels sales the seller has already committed to, and
  `page-credential-bridge`, which keeps the Steam read session alive that the
  delivery tracking depends on. Muting the decorations must not quietly stop a
  seller fulfilling his orders.
*/

import { getSettings } from './storage';

export async function areEnhancementsEnabled(): Promise<boolean> {
  try {
    return (await getSettings()).enhancementsEnabled !== false;
  } catch {
    // Storage unreadable is not consent to go quiet: the extension has always
    // drawn by default, and failing closed here would look like it broke.
    return true;
  }
}

/** Start a content script only if the master switch is on. */
export function whenEnhancementsEnabled(start: () => void): void {
  void areEnhancementsEnabled().then((enabled) => {
    if (enabled) start();
  });
}
