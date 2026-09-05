// Desktop requests must use the same network stack as the launcher window.
// Node's fetch ignores Chromium's system proxy configuration and sends a
// non-browser signature, which some download edges reject with HTTP 403.
export function installDesktopHttp({ net, target = globalThis }) {
  const nodeFetch = target.fetch.bind(target);
  target.fetch = (input, options = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!/^https?:\/\//i.test(url || '')) return nodeFetch(input, options);
    return net.fetch(input, { credentials: 'omit', ...options, bypassCustomProtocolHandlers: true });
  };
}
