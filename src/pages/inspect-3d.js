// Runs in the chrome-extension:// context, framed by the modal on the Steam
// page. See shared/inspect-3d.ts for why the indirection exists at all.

// The vendor's own embed guide (3dview.cs2inspects.com/info) passes the bare
// inspect token, not a wrapped steam:// link.
const VIEWER_URL = 'https://3dview.cs2inspects.com/';
// Kept deliberately narrow: this page turns a query parameter into a
// cross-origin URL, so it re-checks the token instead of trusting the opener.
const TOKEN_RE = /^(?:[SM]\d+A\d+D\d+|[0-9A-Fa-f]{16,900})$/;

const status = document.getElementById('status');
const viewer = document.getElementById('viewer');
const token = new URLSearchParams(window.location.search).get('token') ?? '';

if (!TOKEN_RE.test(token)) {
  status.textContent = 'This item has no inspect link, so there is nothing to render.';
} else {
  viewer.addEventListener('load', () => {
    status.hidden = true;
    viewer.hidden = false;
  });
  viewer.addEventListener('error', () => {
    status.textContent = 'The 3D viewer did not respond. Try again in a moment.';
  });
  viewer.src = `${VIEWER_URL}?inspectlink=${encodeURIComponent(token)}`;
}
