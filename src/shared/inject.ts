// ============================================================
// CSBOARD — Page Injection Utilities (cs2trader pattern)
// ============================================================
// Synchronous script injection using onreset event handler trick.
// This is the EXACT same approach as cs2trader's injection.js.
//
// Key insight: Using onreset on a temp div executes script in
// page context SYNCHRONOUSLY, then we read results back from
// body attributes. No async postMessage needed.

/**
 * Inject a script into the page context and optionally read back a result.
 * Uses the onreset trick from cs2trader: creates a temp div with onreset handler,
 * dispatches reset event, then reads result from body attribute.
 *
 * @param scriptString - JavaScript code to execute in page context
 * @param _toRemove - Unused, kept for API compatibility with cs2trader
 * @param _id - Unused, kept for API compatibility
 * @param executeAndReturn - Body attribute name to read result from (null = fire-and-forget)
 * @returns The attribute value, or null
 */
export const injectScript = (
  scriptString: string,
  _toRemove?: boolean,
  _id?: string,
  executeAndReturn?: string | null,
): string | null => {
  try {
    const tempEl = document.createElement('div');
    tempEl.setAttribute('onreset', `${scriptString};`);
    tempEl.dispatchEvent(new CustomEvent('reset'));
    tempEl.removeAttribute('onreset');
    tempEl.remove();

    if (executeAndReturn) {
      const result = document.querySelector('body')?.getAttribute(executeAndReturn) ?? null;
      if (result !== null) {
        document.querySelector('body')?.removeAttribute(executeAndReturn);
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Inject a script file from the extension's web_accessible_resources.
 * Asynchronous — the script loads after this function returns.
 */
export const injectScriptAsFile = (
  scriptName: string,
  id: string,
  params?: Record<string, unknown>,
): void => {
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const toInject = document.createElement('script');
  toInject.id = id;
  if (params) toInject.dataset.params = JSON.stringify(params);
  toInject.src = chrome.runtime.getURL(`injectToPage/${scriptName}.js`);
  (document.head || document.documentElement).appendChild(toInject);
};

/**
 * Inject a CSS style block into the page.
 */
export const injectStyle = (styleString: string, elementID: string): void => {
  const existing = document.getElementById(elementID);
  if (existing) return;

  const style = document.createElement('style');
  style.id = elementID;
  style.innerHTML = styleString;
  document.querySelector('body')?.appendChild(style);
};
