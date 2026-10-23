// Calls to the Mindmap Host routes. Failures throw with the Host's reason.
export const API = '/api/mindmap'
export const ASSET_PATH = '/dsh-mindmap-assets/'

export async function api(path, { method = 'GET', query, body } = {}) {
  const url = new URL(`${API}/${path}`, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`)
  return data
}

export function eventsUrl(query) {
  const url = new URL(`${API}/events`, window.location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}
