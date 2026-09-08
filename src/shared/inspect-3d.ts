// ============================================================
// CSBOARD — 3D inspect, opened over the Steam page
// ============================================================
// Steam sends a `frame-src` allowlist with every community page, and no
// third-party viewer is on it — framing one directly renders a blank error
// box with nothing in the console. An extension's own resource is exempt from
// that allowlist, so the modal frames `pages/inspect-3d.html`, and that page
// frames the viewer. Anything that changes here has to keep that indirection.

import { cs2InspectToken } from './inspect-actions';

export const INSPECT_3D_PAGE = 'pages/inspect-3d.html';

/**
 * Only the inspect token crosses into the viewer page, never a whole URL —
 * the page re-validates it and rebuilds the Steam link itself.
 */
export function buildInspect3dHref(inspectLink: string, pageUrl: string): string | null {
  const token = cs2InspectToken(inspectLink);
  return token ? `${pageUrl}?token=${encodeURIComponent(token)}` : null;
}

/**
 * Open the viewer in a native `<dialog>`: it comes with the top layer, so it
 * cannot land behind Steam's own item popup, plus Escape and focus handling.
 * Closing removes the element, which is what stops the viewer's WebGL context.
 */
export function openInspect3dDialog(href: string, title: string): HTMLDialogElement {
  document.querySelectorAll('dialog.csboard-inspect3d').forEach((existing) => existing.remove());

  const dialog = document.createElement('dialog');
  dialog.className = 'csboard-inspect3d';

  const bar = document.createElement('header');
  bar.className = 'csboard-inspect3d__bar';

  const heading = document.createElement('span');
  heading.className = 'csboard-inspect3d__title';
  heading.textContent = title;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'csboard-inspect3d__close';
  close.setAttribute('aria-label', 'Close the 3D view');
  close.textContent = '✕';
  close.addEventListener('click', () => dialog.close());

  const frame = document.createElement('iframe');
  frame.className = 'csboard-inspect3d__frame';
  frame.title = `${title} in 3D`;
  frame.src = href;
  frame.allow = 'fullscreen; clipboard-write';

  bar.append(heading, close);
  dialog.append(bar, frame);

  // A click on the backdrop lands on the dialog itself, never on its children.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());

  document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}
