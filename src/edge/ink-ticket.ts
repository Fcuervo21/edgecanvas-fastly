/**
 * A signed, short-lived ticket that lets a player publish live drawing previews without the server looking anything up:
 * it names the room, the player and the team, and expires. Previews are only visual, so this is enough; the
 * authoritative save still needs the full session. Tickets are handed out inside room views, which require a session.
 */
const encoder = new TextEncoder();
export interface InkClaims { room: string; player: string; team: string; exp: number }

const base64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesOf = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const signing = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(`edgecanvas-ink|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function issueInkTicket(secret: string, claims: InkClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify([claims.room, claims.player, claims.team, claims.exp])));
  return `${payload}.${base64url(await crypto.subtle.sign('HMAC', await signing(secret), encoder.encode(payload)))}`;
}

/** The claims of a genuine, unexpired ticket, or null. */
export async function readInkTicket(secret: string, ticket: unknown, now: number): Promise<InkClaims | null> {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await signing(secret), bytesOf(parts[1]), encoder.encode(parts[0])))) return null;
    const [room, player, team, exp] = JSON.parse(new TextDecoder().decode(bytesOf(parts[0])));
    if (typeof room !== 'string' || typeof player !== 'string' || typeof team !== 'string' || !Number.isFinite(exp) || exp <= now) return null;
    return { room, player, team, exp };
  } catch { return null; }
}
