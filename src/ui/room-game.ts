import { connectRoom, type RoomCallbacks, type RoomConnection } from '../rooms/client';
import { connectEdgeRoom } from '../rooms/edge-client';
import type { EdgeView } from '../edge/types';
import type { RoomInvite, RoomView } from '../rooms/types';
import { mountGame } from './game';
import { onLastDay } from '../game/engine';
import { COST } from '../game/rules';
import { escapeHTML as esc } from './html';
import { localTimeToUtcMinute, scheduleNote, utcMinuteToLocalTime } from './schedule';
import { scoreboard } from './scoreboard';

export function mountRoomGame(root: HTMLElement, initial: RoomView, session: RoomConnection, leave: () => void | Promise<void>, loadInvites?: () => Promise<{ invites: RoomInvite[] }>) {
    let view = initial;
    const callbacks: RoomCallbacks = {
      view(next, changed, local) { view = next; game.sync(next, changed, local); updateRoom(); updateSchedule(); },
      effect(fx) { game.effect(fx); },
      status(message, warning) {
        const status = root.querySelector<HTMLElement>('#room-status');
        if (status) { status.textContent = message; status.classList.toggle('warning', !!warning); }
        game.notice(message, !!warning);
      },
    };
    // All-Fastly rooms (views carrying tile versions) merge per-tile events; the Node authority sends revisions.
    const client = 'edge' in view && 'csrfToken' in session
      ? connectEdgeRoom(session, view as EdgeView, callbacks, fetch, { live: true })
      : connectRoom(session, view, callbacks, fetch, { live: true });
    const game = mountGame(root, view.dataset, view.state, () => true, true, { view, submit: command => client.submit(command) });
    const banner = document.createElement('section'); banner.className = 'room-banner';
    banner.innerHTML = `<div class="room-heading"><div><p class="eyebrow">SHARED PAINT PARTY</p><h2>${esc(view.name)} <span class="room-code">${esc(view.code)}</span></h2></div><div class="room-actions"><button id="room-invites" class="secondary" ${view.isHost && loadInvites ? '' : 'hidden'}>Personal invites</button><a class="secondary" href="?mode=rooms&leave=1">Leave room</a></div></div><p id="room-status" class="room-status" role="status">Connected · changes saved</p><div id="room-teams" class="scoreboard" aria-label="Team standings"></div><p class="room-help">${view.isHost ? 'You host this party.' : 'Your host controls the clock.'} Paint costs ${COST.brush} on empty pixels and ${COST.rival} on rivals. Blue shields block rival paint.${(view as EdgeView).days ? ' Each day goes to the team with the most pixels when it closes; the team that wins the most days is the champion, and a tie goes to whoever holds more pixels.' : ''}</p>`;
    root.querySelector('.game-layout')!.before(banner);
    if (loadInvites) {
    const invitesDialog = document.createElement('dialog'); invitesDialog.className = 'invites-dialog';
    invitesDialog.innerHTML = '<p class="eyebrow">HOST DESK</p><h2>Give everyone their color.</h2><p>Share the room code and each person’s own invite privately. An invite gives access to that player’s paint bucket. Keep the host invite for yourself.</p><div id="invite-list" class="invite-list"></div><button class="secondary" id="close-invites">Done</button>';
    root.append(invitesDialog);
    root.querySelector('#close-invites')!.addEventListener('click', () => invitesDialog.close());
    root.querySelector('#room-invites')!.addEventListener('click', async () => {
      const list = root.querySelector('#invite-list')!; list.textContent = 'Opening the guest list…'; invitesDialog.showModal();
      try {
        const { invites } = await loadInvites();
        list.innerHTML = invites.map(invite => `<label class="invite-row"><strong>${esc(invite.name)} <small>${esc(invite.team)}</small></strong><input readonly aria-label="Invite for ${esc(invite.name)}" value="${esc(invite.code)}"></label>`).join('');
        list.querySelectorAll('input').forEach(input => input.addEventListener('click', () => input.select()));
      } catch (error) { list.textContent = error instanceof Error ? error.message : 'Could not open invites.'; }
    });
    }
    // Automatic days (edge rooms only): everyone reads how days change; the host chooses a time or turns it off.
    const offset = new Date().getTimezoneOffset();
    const auto = document.createElement('div'); auto.className = 'auto-days';
    const edgeClient = 'schedule' in client ? client as ReturnType<typeof connectEdgeRoom> : undefined;
    const scheduler = edgeClient ? (at: number | null) => edgeClient.schedule(at) : undefined;
    auto.innerHTML = `<p class="clock-note" id="auto-days-note"></p>${scheduler && view.isHost ? `<div class="auto-days-controls"><label>Change the day at <input type="time" id="auto-time" value="21:00"></label><button class="secondary" id="auto-toggle" type="button"></button></div>` : ''}`;
    root.querySelector('.clock-note')?.after(auto);
    function updateSchedule() {
      const current = (view as EdgeView).autoAdvance;
      if ('edge' in view) root.querySelector('#auto-days-note')!.textContent = scheduleNote(current, offset);
      else auto.hidden = true;
      const toggle = root.querySelector<HTMLButtonElement>('#auto-toggle'), time = root.querySelector<HTMLInputElement>('#auto-time');
      if (!toggle || !time) return;
      toggle.textContent = current ? 'Back to manual days' : 'Turn on automatic days';
      if (current && document.activeElement !== time) time.value = utcMinuteToLocalTime(current.at, offset);
    }
    root.querySelector('#auto-toggle')?.addEventListener('click', async () => {
      const toggle = root.querySelector<HTMLButtonElement>('#auto-toggle')!, time = root.querySelector<HTMLInputElement>('#auto-time')!;
      const turningOn = !(view as EdgeView).autoAdvance, at = turningOn ? localTimeToUtcMinute(time.value, offset) : null;
      if (turningOn && at === null) { game.notice('Choose a time of day first.', true); return; }
      toggle.disabled = true;
      const done = await scheduler!(at);
      toggle.disabled = false;
      if (done) game.notice(at === null ? 'Days are manual again.' : `Days now change by themselves every day at ${time.value}.`);
    });
    const crown = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/></svg>';
    const px = (n: number) => `${n.toLocaleString('en-US')} px`;
    let announcedDays = ((view as EdgeView).days ?? []).length, freshUntil = 0;
    function updateRoom() {
      const days = (view as EdgeView).days;
      if (days && days.length > announcedDays) {
        const latest = days.at(-1)!;
        freshUntil = Date.now() + 15000;
        game.notice(latest.team ? `Day ${latest.day + 1} winner: ${latest.team} with ${px(latest.pixels)}.` : `Day ${latest.day + 1} closed with no winner.`);
      }
      if (days) announcedDays = days.length;
      const board = scoreboard({ members: view.members, cells: view.state.cells, days, team: view.state.team, lastDay: onLastDay(view.state, view.dataset) });
      const tile = (kind: string, label: string, name: string, detail: string, color?: string, extra = '') =>
        `<div class="score-tile ${kind} ${extra}"${color ? ` style="--crew-color:${color}"` : ''}><small>${label}</small><strong>${name}</strong><span>${detail}</span></div>`;
      const colorOf = (team: string | null) => board.rows.find(r => r.team === team)?.color;
      const tiles: string[] = [];
      tiles.push(board.leader
        ? tile('leading', 'LEADING NOW', board.leader.tied ? 'A tie at the top' : esc(board.leader.team), px(board.leader.pixels), board.leader.tied ? undefined : colorOf(board.leader.team))
        : tile('leading', 'LEADING NOW', 'Nobody yet', 'The board is empty'));
      if (board.lastDay) {
        const won = board.lastDay;
        tiles.push(tile('winner', `DAY ${won.day + 1} WINNER`, won.team ? `${crown}${esc(won.team)}` : 'No winner', won.team ? px(won.pixels) : won.pixels ? `Tied at ${px(won.pixels)}` : 'Nobody painted', colorOf(won.team), Date.now() < freshUntil ? 'fresh' : ''));
      }
      if (board.champion) tiles.push(tile('champion', board.champion.final ? 'FINAL RESULT IF TODAY ENDED' : 'OVERALL LEADER', esc(board.champion.team), `${board.champion.wins} ${board.champion.wins === 1 ? 'day' : 'days'} won`, colorOf(board.champion.team)));
      const rows = board.rows.map(row => {
        const people = view.members.filter(m => m.team === row.team);
        return `<li class="score-row ${row.mine ? 'your-team' : ''}" style="--crew-color:${row.color}" title="${esc(people.map(m => `${m.name}${m.joined ? ' (joined)' : ' (invited)'}`).join(', '))}"><span class="rank">${row.rank}</span><i></i><strong>${esc(row.team)}${row.mine ? ' <em>you</em>' : ''}</strong><span class="bar"><b style="width:${Math.max(row.pixels ? 3 : 0, Math.round(row.share * 100))}%"></b></span><span class="px">${px(row.pixels)}</span>${days ? `<span class="won">${row.wins ? `${crown}${row.wins}` : ''}</span>` : ''}</li>`;
      }).join('');
      const html = `<div class="score-tiles">${tiles.join('')}</div><ol class="score-rows">${rows}</ol>`;
      if (html !== teamsHTML) { teamsHTML = html; root.querySelector('#room-teams')!.innerHTML = html; }
    }
    let teamsHTML = '';
    updateRoom(); updateSchedule();
    // Use the in-memory session too, so leaving works when browser storage is unavailable.
    root.querySelectorAll<HTMLAnchorElement>('a[href="?mode=rooms&leave=1"]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault(); client.stop(); void leave();
      });
    });
    window.addEventListener('pagehide', () => client.stop(), { once: true });
}
