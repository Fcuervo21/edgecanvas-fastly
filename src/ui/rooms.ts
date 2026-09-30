import { mountRoomGame } from './room-game';
import type { RoomEntry, RoomInvite, RoomRoster, RoomSession, RoomView } from '../rooms/types';
import { escapeHTML as esc } from './html';

const SESSION_KEY = 'edgecanvas.room-session.v1';
async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The room server is unavailable. Start the local room server and try again.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Unable to open this room.');
  return data as T;
}
function remember(session: RoomSession | null) {
  try { if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else sessionStorage.removeItem(SESSION_KEY); } catch { /* A blocked store only disables refresh recovery. */ }
}
async function leaveRoom(root: HTMLElement, session: RoomSession | null) {
  root.innerHTML = '<main class="recovery"><p class="eyebrow">TEAM PLAYGROUND</p><h1>Leaving the room…</h1></main>';
  try {
    if (session) {
      const result = await api<{ signedOut: boolean }>(`/rooms/${encodeURIComponent(session.code)}/logout`, {}, session.token);
      if (result.signedOut !== true) throw new Error('Logout was not acknowledged.');
    }
  } catch {
    root.innerHTML = '<main class="recovery"><p class="eyebrow">TEAM PLAYGROUND</p><h1>We could not confirm you have left.</h1><p>Your progress is saved. Please retry to finish signing out.</p><button class="primary" id="retry-leave">Try leaving again</button></main>';
    root.querySelector('#retry-leave')!.addEventListener('click', () => { void leaveRoom(root, session); }, { once: true });
    return;
  }
  remember(null);
  // A fresh document also disposes the canvas listeners and animations.
  location.replace('?mode=rooms');
}

export async function mountRooms(root: HTMLElement) {
  root.innerHTML = '<main class="recovery"><p class="eyebrow">TEAM PLAYGROUND</p><h1>Opening the paint party…</h1></main>';
  let session: RoomSession | null = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (saved && typeof saved.code === 'string' && typeof saved.token === 'string') session = saved;
  } catch { /* Open the lobby if this tab has no usable session. */ }
  if (new URLSearchParams(location.search).has('leave')) { await leaveRoom(root, session); return; }
  let resumeError = '';
  if (session) {
    try { enter({ session, view: await api<RoomView>(`/rooms/${encodeURIComponent(session.code)}`, undefined, session.token) }); return; }
    catch (error) { resumeError = `${error instanceof Error ? error.message : 'Connection interrupted.'} Rejoin below or reload to retry your saved session.`; }
  }
  let roster: RoomRoster;
  try { roster = await api<RoomRoster>('/roster'); }
  catch (error) {
    root.innerHTML = `<main class="recovery"><p class="eyebrow">TEAM PLAYGROUND</p><h1>The party is offline.</h1><p>${esc(error instanceof Error ? error.message : 'Please retry.')}</p><a class="primary" href="?mode=rooms">Try again</a> <a class="secondary" href="/">Solo playground</a></main>`; return;
  }
  const teams = [...new Set(roster.members.map(member => member.team))];
  root.innerHTML = `
    <header class="site-header"><a class="brand" href="/">edge<span>canvas</span></a><a class="secondary" href="/">Solo playground ↗</a></header>
    <main class="workspace lobby">
      <section class="intro"><div><p class="eyebrow">MORE FRIENDS. MORE SPLASHES.</p><h1>Your crew.<br><em>One big canvas.</em></h1><p class="intro-copy">Bring your steps. Pick a side. Make a beautiful mess together.</p></div><div class="lobby-sticker" aria-hidden="true">✳<span>LET’S<br>PAINT!</span></div></section>
      <div class="lobby-facts"><span>🎨 ${teams.length} teams</span><span>👟 ${roster.members.length} named players</span><span>✦ Up to ${roster.maxTeamSize} per team</span><span>∞ No time limit</span></div>
      <p id="lobby-status" class="feedback${resumeError ? ' warning' : ''}" role="status">${esc(resumeError || 'Your team is already on the guest list. Your host has your personal invite.')}</p>
      <div class="lobby-forms">
        <section class="card join-card"><p class="eyebrow">GOT AN INVITE?</p><h2>Jump into the splash.</h2><p>One room code, one personal invite. Your name, team, and paint are waiting inside.</p>
          <form id="join-room"><label for="room-code">Room code</label><input id="room-code" name="roomCode" required maxlength="16" placeholder="e.g. A7K9PX4B2D6F" autocomplete="off" spellcheck="false" class="code-input">
          <label for="invite-code">Your personal invite</label><input id="invite-code" name="inviteCode" required maxlength="128" placeholder="Paste the invite from your host" autocomplete="off" spellcheck="false">
          <button class="primary" type="submit">Let me paint ↗</button></form>
        </section>
        <section class="card create-card"><p class="eyebrow">LOCAL ORGANIZER SETUP</p><h2>Start the paint party.</h2><p>Create a fresh room for the CSV roster. You control the simulation clock and hand out the personal invites.</p>
          <form id="create-room"><label for="room-name">Room name</label><input id="room-name" name="name" required maxlength="60" value="The Great Splash" autocomplete="off">
          <label for="host-player">Play as the host</label><select id="host-player" name="hostId">${teams.map(team => `<optgroup label="${esc(team)}">${roster.members.filter(m => m.team === team).map(m => `<option value="${esc(m.id)}" ${m.id === 'Amber Foxes:Alex Rivera' ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select>
          <button class="primary" type="submit">Create a room ✦</button></form>
          <p class="local-note">Local prototype: organizer setup is open on this computer. Hosted access controls come in the next stage.</p>
        </section>
      </div>
      <section class="lobby-roster"><p class="eyebrow">THE GUEST LIST · FROM YOUR CSV</p><h2>Different colors. Same playground.</h2><div class="team-cards">${teams.map(team => {
        const members = roster.members.filter(m => m.team === team);
        return `<article class="team-card" style="--crew-color:${members[0].color}"><div class="team-card-title"><i></i><h3>${esc(team)}</h3><span>${members.length}/${roster.maxTeamSize}</span></div><ul>${members.map(m => `<li>${esc(m.name)}</li>`).join('')}</ul>${members.length < roster.maxTeamSize ? `<p>${roster.maxTeamSize - members.length} roster ${members.length === 2 ? 'place' : 'places'} to confirm</p>` : ''}</article>`;
      }).join('')}</div></section>
      <p class="lobby-footnote">Shared territory · Individual paint buckets · The host advances the day for everyone</p>
    </main>`;
  function notice(message: string) { const el = root.querySelector('#lobby-status')!; el.textContent = message; el.classList.add('warning'); }
  for (const kind of ['join', 'create'] as const) {
    root.querySelector<HTMLFormElement>(`#${kind}-room`)!.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[type=submit]')]; buttons.forEach(b => b.disabled = true);
      try {
        const entry = kind === 'create'
          ? await api<RoomEntry>('/rooms', { name: String(data.get('name')).trim(), hostId: data.get('hostId') })
          : await api<RoomEntry>(`/rooms/${encodeURIComponent(String(data.get('roomCode')).trim().toUpperCase())}/join`, { inviteCode: String(data.get('inviteCode')).trim() });
        remember(entry.session); enter(entry);
      } catch (error) { notice(error instanceof Error ? error.message : 'Unable to join. Try again.'); buttons.forEach(b => b.disabled = false); }
    });
  }
  function enter(entry: RoomEntry) {
    mountRoomGame(root, entry.view, entry.session, () => leaveRoom(root, entry.session),
      () => api<{ invites: RoomInvite[] }>(`/rooms/${encodeURIComponent(entry.session.code)}/invites`, undefined, entry.session.token));
  }
}
