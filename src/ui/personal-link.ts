import { suggestUsername } from './username';

/** The code of a personal link. The fragment (`#code=`) is preferred because browsers never send it to a server. */
export function codeFromLocation(location: { hash?: string; search?: string }): string | null {
  const code = new URLSearchParams((location.hash ?? '').replace(/^#/, '')).get('code') ?? new URLSearchParams(location.search ?? '').get('code');
  return code && /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
}

/** Asks who a code belongs to (without using it up), so the page can greet them. `null` for any refusal or outage. */
export async function describeCode(code: string, request: typeof fetch = fetch): Promise<{ name: string; team: string; username: string } | null> {
  try {
    const response = await request('/api/auth/enrollment', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const { name, team } = await response.json();
    return typeof name === 'string' && typeof team === 'string' ? { name, team, username: suggestUsername(name) } : null;
  } catch { return null; }
}
