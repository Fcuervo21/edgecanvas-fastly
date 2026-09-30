import { createGame, dispatch, onLastDay } from '../game/engine';
import { COST } from '../game/rules';
import { BRUSH_MASKS } from '../game/targets';
import type { BrushShape, Command, Dataset, GameState, Tool } from '../game/types';
import { createCanvas } from './canvas';
import { createMotion } from './motion';
import type { RoomEffect, RoomView } from '../rooms/types';
import { escapeHTML } from './html';
import { teamColor } from '../rooms/colors';
import { paintAlert } from './paint-alert';

const icon = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
  brush: icon('<path d="m14 4 6 6M5 19l4-1L21 6a2.8 2.8 0 0 0-4-4L5 14l-1 5Z"/><path d="M4 20c-2 0-2-2-1-3"/>'),
  bomb: icon('<circle cx="11" cy="14" r="7"/><path d="m15 8 2-3 3 1M19 2v1M22 5h1M16 2l1 1M7 13a4 4 0 0 1 3-3"/>'),
  shield: icon('<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>'),
  drop: icon('<path d="M12 2S4 11 4 15a8 8 0 0 0 16 0c0-4-8-13-8-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>'),
  arrow: icon('<path d="M4 12h16m-6-6 6 6-6 6"/>'),
};
const fmt = (n: number) => n.toLocaleString('en-US');
const labels = { brush: 'Brush', bomb: 'Bomb', shield: 'Shield' };
const errors = {
  INSUFFICIENT_PAINT: 'Not enough paint. Advance to the next day to refill.',
  NO_ITEM: 'Buy this tool in the shop first.',
  NO_CHANGE: 'No pixels to change here. You keep your paint and tools.',
  OUT_OF_BOUNDS: 'Aim inside the canvas.', INVALID_TIME: 'Cannot advance to that time.', NO_MORE_DAYS: 'That was the last day with step data.', OK: '',
};

export function mountGame(root: HTMLElement, dataset: Dataset, initial: GameState,
  save: (state: GameState) => boolean, initialSaved: boolean, remote?: { view: RoomView; submit(command: Command): boolean },
  /** Solo only: builds a fresh game. The solo player lives in the local entry so hosted builds never carry a name. */
  restart?: () => GameState) {
  let state = initial;
  let tool: Tool = 'brush';
  let shape: BrushShape = 'pixel';
  let saved = initialSaved;
  const player = dataset.players.find(p => p.id === state.playerId)!;
  root.style.setProperty('--team-color', teamColor(state.team));
  root.innerHTML = `
    <header class="site-header">
      <a class="brand" href="#" aria-label="EdgeCanvas, home"><span class="brand-mark"><i></i><i></i><i></i><i></i><i></i><i></i></span>edge<span>canvas</span></a>
      <div class="header-center"><span class="live-dot"></span> CODECAPSULES 2026 <span class="header-divider">/</span> THE PLAYGROUND <a class="rooms-link" href="?mode=rooms${remote ? '&leave=1' : ''}">${remote ? 'Leave room' : 'Play with teams ↗'}</a></div>
      <div class="profile"><span class="avatar">${escapeHTML(player.name.split(/\s+/).slice(0,2).map(part => part[0]).join(''))}</span><div><strong>${escapeHTML(player.name)}</strong><small><span class="team-dot"></span> ${escapeHTML(state.team)}</small></div></div>
    </header>
    <main class="workspace">
      <section class="intro"><div><p class="eyebrow">WALK. PAINT. MAKE YOUR MARK.</p><h1>Small steps.<br><em>Big splashes.</em></h1><p class="intro-copy">Walk a little. Make a mess. This is your paint playground.</p></div><div class="intro-side"><div class="intro-art" aria-hidden="true"><svg viewBox="0 0 160 150" fill="none"><path d="M36 43C17 14 55 7 70 28C83 1 116 14 110 40C144 23 155 53 134 72C166 89 142 119 118 111C120 144 87 148 75 123C50 148 24 125 35 102C2 104 0 72 29 66C14 50 21 38 36 43Z" fill="#ff655c" stroke="#fff" stroke-width="5"/><ellipse cx="65" cy="66" rx="5" ry="8" fill="#30304d"/><ellipse cx="97" cy="66" rx="5" ry="8" fill="#30304d"/><path d="M69 87Q81 99 94 85" stroke="#30304d" stroke-width="4" stroke-linecap="round"/><ellipse cx="50" cy="81" rx="8" ry="4" fill="#ffaaa0"/><ellipse cx="111" cy="81" rx="8" ry="4" fill="#ffaaa0"/><path d="m135 8 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" fill="#8d6ac9"/><circle cx="13" cy="121" r="7" fill="#62b99d"/><circle cx="147" cy="131" r="5" fill="#edc34d"/></svg></div><div class="mode-pill"><span class="live-dot"></span> ${remote ? 'Shared room' : 'Local simulation'} <span>${remote ? 'Team battle' : '01 player'}</span></div></div></section>
      <div class="game-layout">
        <section class="studio" aria-label="Painting studio">
          <div class="canvas-top"><div class="canvas-label"><span class="mini-grid">▦</span><strong>THE SPLASH ZONE</strong><span>001</span></div><div class="canvas-meta"><span>100 × 100</span><span class="small-dot"></span><span>No time limit</span></div></div>
          <div class="paint-alert" id="paint-alert" role="alert" hidden><strong id="paint-alert-title"></strong><span id="paint-alert-body"></span></div>
          <div class="frame"><div class="mat"><div class="canvas-wrap">
            <canvas id="canvas" width="1000" height="1000" tabindex="0" role="img" aria-label="Painting canvas. Use arrow keys to aim and Enter to paint." aria-describedby="canvas-instructions"></canvas>
            <div class="empty-canvas" id="empty"><span class="empty-splash">✳</span><h2>Ready, set,<br>splash!</h2><p>Hold, drag, and leave your first mark.</p><span class="empty-tag">YOUR COLOR: ${escapeHTML(state.team)} <i></i></span></div>
          </div></div></div>
          <div class="protection-legend">${icons.shield}<span>Blue shields protect paint · Team color stays at the edges</span></div>
          <div class="canvas-bottom"><span><i class="team-dot"></i> <strong id="painted">0</strong> pixels painted <span class="muted" id="coverage">/ 10,000</span></span><span id="position">X — &nbsp; Y —</span></div>
          <div class="tools-panel"><div class="tools-heading"><span class="eyebrow">PICK YOUR PLAY</span><span id="tool-hint">One click. One mark.</span></div><div class="tools">
            <button class="tool active" data-tool="brush" aria-pressed="true"><span class="tool-icon">${icons.brush}</span><span><strong>Brush</strong><small>${fmt(COST.brush)} paint / pixel</small></span><span class="tool-shortcut">01</span></button>
            <button class="tool" data-tool="bomb" aria-pressed="false"><span class="tool-icon">${icons.bomb}</span><span><strong>Bomb</strong><small id="bomb-stock">0 available</small></span><span class="tool-shortcut">02</span></button>
            <button class="tool" data-tool="shield" aria-pressed="false"><span class="tool-icon">${icons.shield}</span><span><strong>Shield</strong><small id="shield-stock">0 available</small></span><span class="tool-shortcut">03</span></button>
          </div><div class="brush-options" id="brush-options"><div class="shape-heading"><strong>BRUSH & STAMPS</strong><span id="shape-note">Hold & drag to draw</span></div><div class="shape-buttons" role="group" aria-label="Brush shape">${(['pixel','circle','star','heart'] as const).map(name => `<button data-shape="${name}" aria-pressed="${name === 'pixel'}"><span class="shape-preview" style="--mask-size:${BRUSH_MASKS[name].length}" aria-hidden="true">${BRUSH_MASKS[name].join('').split('').map(cell => `<i class="${cell === '1' ? 'filled' : ''}"></i>`).join('')}</span><span>${name === 'pixel' ? 'Freehand' : name[0].toUpperCase() + name.slice(1)}</span></button>`).join('')}</div></div></div>
          <div class="feedback" id="feedback" role="status" aria-live="polite">Your first refill is ready. Pick a spot and paint.</div>
          <p class="canvas-instructions" id="canvas-instructions">Hold & drag to draw · Click once to stamp, bomb, or shield · Arrow keys + Enter also work. New pixels cost ${fmt(COST.brush)} paint each.${remote ? ` Rival pixels cost ${fmt(COST.rival)}. Shielded rivals cannot be painted.` : ''}</p>
        </section>
        <aside class="sidebar">
          <section class="wallet card"><div class="card-eyebrow"><span>YOUR PAINT</span><span class="wallet-drop">${icons.drop}</span></div><div class="balance-line"><strong id="balance">6,373</strong><span>available</span></div><p>Pocket full of steps. Bucket full of paint.</p><div class="wallet-bottom"><span>1 step = 1 paint</span><span class="wallet-swatch"></span></div></section>
          <section class="clock-card card"><div class="card-eyebrow"><span>YOU SET THE PACE</span><span class="clock-symbol">◷</span></div><div class="day-line"><h2 id="day">Day 01</h2><span id="clock">00:00</span></div><p class="source-day" id="source-day"></p><div class="daily-credit"><span>Steps for this day</span><strong id="daily-steps"></strong></div><div class="goal-track"><div id="goal-progress"></div></div><div class="goal-caption"><span id="goal-label"></span><span id="goal-percent"></span></div><div class="time-actions"><button class="secondary" id="minutes">+10 min</button><button class="primary" id="next-day">Next day ${icons.arrow}</button></div><p class="clock-note">Advance to refill your paint. Real time does not affect the game.</p></section>
          <section class="shop card"><div class="card-eyebrow"><span>THE GOODIE SHOP</span><span class="tiny-label">PAY WITH STEPS</span></div><div class="shop-item"><span class="shop-icon bomb-icon">${icons.bomb}</span><div class="shop-detail"><h3>Paint bomb</h3><p>Up to 25 pixels in one splash.</p><button id="buy-bomb">Buy · ${fmt(COST.bomb)} ${icons.drop}</button></div></div><div class="shop-item"><span class="shop-icon shield-icon">${icons.shield}</span><div class="shop-detail"><h3>Blue shield</h3><p>Protect up to 9 pixels · 2 hrs.</p><button id="buy-shield">Buy · ${fmt(COST.shield)} ${icons.drop}</button></div></div><p class="shop-note" id="shield-status">Paint first. Then protect your mark.</p></section>
          <section class="activity card"><div class="card-eyebrow"><span>RECENT MOVES</span><span>↗</span></div><ol id="activity"></ol></section>
        </aside>
      </div>
      <section class="history-strip"><div><span class="eyebrow">THE MOVEMENT BEHIND THE COLOR</span><h3>Your story, step by step.</h3><p><strong>${fmt(player.totalSteps)}</strong> recorded steps · ${dataset.dates[0]} to ${dataset.dates.at(-1)}</p></div><div class="history-chart" id="history" aria-label="Your daily step history"></div><div class="history-legend"><span><i></i> Simulated day</span><span>${dataset.dates.length} days of real steps</span></div></section>
      <footer class="footer"><span id="save-status"><i class="live-dot"></i> Progress saved in this browser</span><span>${escapeHTML(state.team)} <span class="footer-cross">×</span> CODECAPSULES</span>${remote ? '<a href="?mode=rooms&leave=1">Leave room ↗</a>' : '<button id="reset">Reset simulation ↺</button><a href="?mode=rooms">Play with teams ↗</a>'}</footer>
    </main>
    <dialog id="reset-dialog"><span class="eyebrow">A FRESH CANVAS</span><h2>Back to the first step?</h2><p>This clears the painted canvas, purchases, and simulation progress. You will start again with 6,373 paint from the first day.</p><div><button class="secondary" id="cancel-reset">Keep my canvas</button><button class="primary" id="confirm-reset">Yes, start over</button></div></dialog>`;

  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const motion = createMotion(root);
  const balanceChange = document.createElement('span');
  balanceChange.id = 'balance-change';
  balanceChange.setAttribute('aria-hidden', 'true');
  root.querySelector('.balance-line')!.append(balanceChange);
  const text = (id: string, value: string) => { el(id).textContent = value; };
  const setFeedback = (message: string, warning = false) => {
    text('feedback', message); el('feedback').classList.toggle('warning', warning);
  };
  const canvas = createCanvas(el<HTMLCanvasElement>('canvas'), (x, y) => execute({ type: 'apply', tool, shape, x, y }), (point, count, price) => {
    text('position', point ? `X ${String(point.x).padStart(2, '0')}  ·  Y ${String(point.y).padStart(2, '0')}` : 'X —  ·  Y —');
    const tail = tool === 'brush' ? `${fmt(price)} paint` : '1 inventory item';
    text('tool-hint', point ? `${count} ${count === 1 ? 'pixel' : 'pixels'} · ${count ? tail : 'no cost'}`
      : tool === 'brush' ? shape === 'pixel' ? 'Hold & drag to draw.' : 'Aim to see the exact stamp cost.' : tool === 'bomb' ? 'Paint a 5 × 5 block.' : 'Protect your paint for 2 simulated hours.');
  }, points => execute({ type: 'stroke', points }));
  let historyFor = -1, activityKey = '', wasOut = false;
  function render(changed: number[] = [], local?: number[]) {
    const day = Math.floor(state.minute / 1440), index = day % dataset.dates.length;
    const date = dataset.dates[index], daily = player.days[date];
    const dateLabel = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
    text('balance', fmt(state.balance));
    const alert = paintAlert(state.balance, { shared: !!remote, finished: onLastDay(state, dataset) });
    el('paint-alert').hidden = !alert;
    if (alert) { text('paint-alert-title', alert.title); text('paint-alert-body', alert.body); }
    if (alert && !wasOut) { setFeedback(alert.title, true); motion.error(); }
    wasOut = !!alert;
    text('day', `Day ${String(day + 1).padStart(2, '0')}`);
    text('clock', `${String(Math.floor(state.minute % 1440 / 60)).padStart(2, '0')}:${String(state.minute % 60).padStart(2, '0')}`);
    // Shared rooms end with the recorded steps: no replay, just an invitation to keep walking.
    const finished = onLastDay(state, dataset), canAdvance = !remote || remote.view.isHost;
    el<HTMLButtonElement>('minutes').disabled = !canAdvance || (!!state.competitive && state.minute + 10 >= dataset.dates.length * 1440);
    const nextDay = el<HTMLButtonElement>('next-day');
    nextDay.disabled = !canAdvance || finished;
    if (finished) {
      nextDay.textContent = 'Keep walking!';
      nextDay.title = 'No more days with step data yet. New steps will be added soon.';
      root.querySelector('.clock-note')!.textContent = 'You have reached the last day with step data. Keep walking and wait for the next steps update.';
    }
    text('source-day', `${day >= dataset.dates.length ? `Cycle ${Math.floor(day / dataset.dates.length) + 1} · replaying ` : 'Record from '}${dateLabel}`);
    text('daily-steps', daily === null ? 'No record' : fmt(daily));
    const percent = daily !== null && player.dailyGoal > 0 ? Math.round(daily / player.dailyGoal * 100) : null;
    el('goal-progress').style.width = `${Math.min(percent ?? 0, 100)}%`;
    text('goal-label', `Daily goal: ${fmt(player.dailyGoal)}`);
    text('goal-percent', percent === null ? '—' : `${percent}%`);
    const painted = state.cells.filter(c => c.owner === state.team).length;
    text('painted', fmt(painted));
    text('coverage', `/ 10,000 · ${(painted / 100).toFixed(2)}%`);
    el('empty').hidden = state.cells.some(c => c.owner !== null);
    const shielded = state.cells.filter(c => c.owner === state.team && c.shieldUntil > state.minute);
    const remaining = shielded.length ? Math.max(...shielded.map(c => c.shieldUntil)) - state.minute : 0;
    text('shield-status', shielded.length ? `${shielded.length} protected pixels · up to ${remaining} min remaining.` : 'Paint first. Then protect your mark.');
    for (const item of ['bomb', 'shield'] as const) {
      text(`${item}-stock`, `${state.inventory[item]} ${state.inventory[item] === 1 ? 'available' : 'available'}`);
      const buy = el<HTMLButtonElement>(`buy-${item}`);
      buy.disabled = state.balance < COST[item];
      buy.title = buy.disabled ? `You need ${fmt(COST[item] - state.balance)} more paint` : `Add ${labels[item].toLowerCase()} to inventory`;
    }
    root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
      const active = button.dataset.tool === tool;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    el('brush-options').hidden = tool !== 'brush';
    root.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.shape === shape)));
    const stampSize = BRUSH_MASKS[shape].join('').split('').filter(c => c === '1').length;
    text('shape-note', remote ? `${fmt(COST.brush)} empty · ${fmt(COST.rival)} rival / pixel` : shape === 'pixel' ? `Hold & drag · ${fmt(COST.brush)} / new pixel` : `Click to stamp · up to ${fmt(stampSize * COST.brush)} paint`);
    const recent = state.messages.slice(0, 3);
    if (recent.join('\n') !== activityKey) {
      activityKey = recent.join('\n');
      el('activity').replaceChildren(...recent.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
    }
    const max = Math.max(1, ...Object.values(player.days).map(n => n ?? 0));
    // The step-history strip only changes when the day does; rebuilding it on every stroke update was wasted work.
    if (historyFor !== index) el('history').replaceChildren(...dataset.dates.map((date, i) => {
      const bar = document.createElement('span');
      bar.style.height = `${Math.max(4, ((player.days[date] ?? 0) / max) * 100)}%`;
      bar.className = i === index ? 'current' : '';
      bar.title = `${date}: ${player.days[date] === null ? 'No record' : fmt(player.days[date]!)} steps`;
      return bar;
    }));
    historyFor = index;
    text('save-status', remote ? `● Saved to room · revision ${remote.view.revision}` : saved ? '● Progress saved in this browser' : 'Temporary progress: could not save');
    el('save-status').classList.toggle('unsaved', !saved);
    canvas.update(state, tool, changed, shape, local);
  }
  function execute(command: Command) {
    if (remote) return remote.submit(command);
    const result = dispatch(state, command, dataset);
    if (result.code !== 'OK') {
      if (command.type === 'stroke' && result.code === 'NO_CHANGE') return true;
      setFeedback(errors[result.code], true); motion.error(); return false;
    }
    const difference = result.state.balance - state.balance;
    state = result.state;
    saved = save(state);
    setFeedback(command.type === 'advance' && command.toMinute % 1440 !== 0 ? 'Clock advanced. Shields follow simulated time.' : state.messages[0]);
    render(result.changed);
    motion.action(command, difference);
    if (command.type === 'stroke' && state.balance < COST.brush) {
      setFeedback('Not enough paint for another pixel. Advance to the next day to refill.', true);
      return false;
    }
    return true;
  }
  root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.addEventListener('click', () => {
    tool = button.dataset.tool as Tool;
    setFeedback(tool === 'brush' ? `Hold & drag with Freehand, or choose a stamp. Each new pixel costs ${fmt(COST.brush)} paint.`
      : state.inventory[tool] ? `${labels[tool]} ready. Aim at the canvas to use one.` : `You have no ${tool === 'bomb' ? 'bombs' : 'shields'} yet. Buy some in the shop.`);
    render();
    motion.select(button);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(button => button.addEventListener('click', () => {
    shape = button.dataset.shape as BrushShape;
    render();
    setFeedback(shape === 'pixel' ? 'Hold & drag to draw. Your own paint is free to cross.' : `${shape[0].toUpperCase() + shape.slice(1)} stamp ready. Aim for the exact cost, then click once.`);
    motion.select(button);
  }));
  el('minutes').addEventListener('click', () => execute({ type: 'advance', toMinute: state.minute + 10 }));
  el('next-day').addEventListener('click', () => execute({ type: 'advance', toMinute: (Math.floor(state.minute / 1440) + 1) * 1440 }));
  for (const item of ['bomb', 'shield'] as const) el(`buy-${item}`).addEventListener('click', () => execute({ type: 'buy', item }));
  const dialog = el<HTMLDialogElement>('reset-dialog');
  el('reset')?.addEventListener('click', () => { dialog.showModal(); motion.openDialog(); });
  el('cancel-reset').addEventListener('click', () => dialog.close());
  el('confirm-reset').addEventListener('click', () => {
    if (remote || !restart) return;
    state = restart(); tool = 'brush'; shape = 'pixel'; saved = save(state); dialog.close();
    render(); setFeedback('Fresh canvas. Your 6,373 paint is ready.');
  });
  if (state.spent > 0 || state.minute > 0) setFeedback('Your canvas was waiting. Pick up where you left off.');
  if (remote) {
    for (const id of ['minutes', 'next-day']) el<HTMLButtonElement>(id).disabled = !remote.view.isHost;
    root.querySelector('.clock-note')!.textContent = remote.view.isHost
      ? 'You are the host. Advance the day to refill every player from their own step history.'
      : 'Your host controls the shared clock. Everyone refills together from their own step history.';
    root.querySelector('.clock-card .card-eyebrow span')!.textContent = 'ONE ROOM. ONE CLOCK.';
    setFeedback('Your team shares territory. Your paint and tools belong to you.');
  }
  render();
  motion.enter();
  return {
    sync(view: RoomView, changed: number[] = [], local?: number[]) {
      if (!remote) return;
      const difference = view.state.balance - state.balance;
      remote.view = view; state = view.state;
      render(changed, local);
      if (difference) motion.action({ type: 'stroke', points: [] }, difference);
    },
    notice: setFeedback,
    effect: (fx: RoomEffect) => canvas.effect(fx),
  };
}
