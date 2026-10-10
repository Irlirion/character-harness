/** Credentials may only go to the local core or its fixed Compose service. */
function checkedUrl(value: string): URL {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const compose = url.hostname === 'core' && url.port === '3000';
  if (url.protocol !== 'http:' || !(local || compose) || url.username || url.password || url.hash) {
    throw new Error('Core URL must be local HTTP or http://core:3000');
  }
  return url;
}

export function coreBaseUrl(value: string): string {
  const url = checkedUrl(value);
  if (url.pathname !== '/' || url.search) throw new Error('Core URL must not contain a path or query');
  return url.origin;
}

export const coreFetch: typeof fetch = (input, init) => {
  checkedUrl(input instanceof Request ? input.url : String(input));
  // Reject all redirects, including same-host redirects to an unexpected service.
  return fetch(input, { ...init, redirect: 'error' });
};
