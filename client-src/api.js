// The official Electron shell serves the shared API over its private dsh-app
// carrier: plugin routes there live under /api even though the browser route
// keeps its own prefix. Choose once, before sending.
const ENDPOINT = typeof window !== 'undefined' && window.location && window.location.protocol === 'dsh-app:'
  ? '/api/remote-agent/api/rpc'
  : '/remote-agent/api/rpc';

export async function rpc(method, params = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ method, params }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'HTTP' });
  }
  if (!payload || payload.ok !== true) {
    const error = payload && payload.error ? payload.error : {};
    throw Object.assign(new Error(error.message || `HTTP ${response.status}`), { code: error.code || 'ERROR' });
  }
  return payload.value;
}

export function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT'));
}
