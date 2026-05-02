// Injected into CSFloat page context to intercept API responses
// Dispatches 'csboard_api' CustomEvent with parsed JSON data

(function() {
  // Override fetch
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url || '';
      if (url.includes('/v1/') && !url.match(/\.(js|css|svg|png|jpg)$/)) {
        const clone = response.clone();
        clone.json().then(function(data) {
          document.dispatchEvent(new CustomEvent('csboard_api', {
            detail: { url: url, data: data }
          }));
        }).catch(function() {});
      }
    } catch(e) {}
    return response;
  };

  // Override XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.addEventListener('load', function() {
      try {
        if (typeof url === 'string' && url.includes('/v1/') && !url.match(/\.(js|css|svg|png|jpg)$/)) {
          const data = JSON.parse(this.responseText);
          document.dispatchEvent(new CustomEvent('csboard_api', {
            detail: { url: url, data: data }
          }));
        }
      } catch(e) {}
    });
    return origOpen.apply(this, [method, url, ...rest]);
  };
})();
