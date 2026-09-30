import { mountAccountAdmin } from './account-admin';
import type { RoomView } from '../rooms/types';
import { mountRoomGame } from './room-game';
import { COST } from '../game/rules';
import { escapeHTML as esc } from './html';
import { passphrase } from './passphrase';
import { codeFromLocation, describeCode } from './personal-link';
interface Profile { account: { username: string; organizer: boolean }; csrfToken: string }
class AccountError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, body?: unknown, csrf?: string): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The account server is unavailable.');
  const data = await response.json();
  if (!response.ok) throw new AccountError(data.error ?? 'Request failed. Please retry.', response.status);
  return data as T;
}
export async function signOut(root: HTMLElement, csrf: string) {
  root.innerHTML = '<main class="recovery"><h1>Signing out…</h1></main>';
  try {
    const result = await api<{ signedOut: boolean }>('/auth/logout', {}, csrf);
    if (!result.signedOut) throw new Error('Logout was not acknowledged.');
    location.replace('/');
  } catch {
    root.innerHTML = '<main class="recovery"><h1>We could not confirm sign-out.</h1><p>Please retry to finish signing out.</p><button id="retry-signout" class="primary">Try again</button></main>';
    root.querySelector('#retry-signout')!.addEventListener('click', () => { void signOut(root, csrf); }, { once: true });
  }
}
export async function mountAccounts(root: HTMLElement) {
  root.innerHTML = '<main class="recovery"><h1>Opening your playground…</h1></main>';
  let profile: Profile;
  try { profile = await api<Profile>('/account'); }
  catch (error) {
    if (error instanceof AccountError && error.status === 401) { login(root); return; }
    root.innerHTML = '<main class="recovery"><h1>Sign-in is unavailable.</h1><p>Please try again when the account server is available.</p><a class="primary" href="/">Try again</a></main>'; return;
  }
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('welcome')) { welcome(root, profile); return; }
  try {
    const rooms = await api<{ code: string; name: string }[]>('/rooms');
    root.innerHTML = `<header class="site-header"><a class="brand" href="/">edge<span>canvas</span></a><span class="header-actions"><a class="secondary" href="/?welcome">How it works</a><button id="signout" class="secondary">Sign out</button></span></header><main class="workspace lobby"><section class="intro"><div><p class="eyebrow">YOUR TEAM PLAYGROUND</p><h1>Welcome, ${esc(profile.account.username)}.</h1><p>Pick your room and bring your color to the canvas.</p></div></section><p id="account-status" role="status"></p><div class="lobby-forms"><section class="card"><h2>Your rooms</h2>${rooms.length ? rooms.map(room => `<button class="primary" data-room="${esc(room.code)}">${esc(room.name)}</button>`).join(' ') : '<p>Your organizer has not created a room yet.</p>'}</section>${profile.account.organizer ? '<section class="card"><h2>Start the paint party.</h2><form id="create-room"><label for="room-name">Room name</label><input id="room-name" name="name" required maxlength="80" value="The Great Splash"><button class="primary">Create room</button></form></section>' : ''}</div>${profile.account.organizer ? '<section class="card" id="account-admin"><button id="manage-accounts" class="secondary">Manage accounts</button></section>' : ''}</main>`;
    root.querySelector('#manage-accounts')?.addEventListener('click', async () => {
      try { await mountAccountAdmin(root.querySelector<HTMLElement>('#account-admin')!, profile.csrfToken, api); }
      catch (error) { root.querySelector('#account-status')!.textContent = error instanceof Error ? error.message : 'Please retry.'; }
    });
    root.querySelector('#signout')!.addEventListener('click', () => { void signOut(root, profile.csrfToken); });
    const enter = (view: RoomView) => mountRoomGame(root, view, { code: view.code, csrfToken: profile.csrfToken }, () => signOut(root, profile.csrfToken));
    async function open(path: string, body: unknown) {
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => button.disabled = true);
      try { enter(await api<RoomView>(path, body, profile.csrfToken)); }
      catch (error) { root.querySelector('#account-status')!.textContent = error instanceof Error ? error.message : 'Please retry.'; buttons.forEach(button => button.disabled = false); }
    }
    root.querySelectorAll<HTMLButtonElement>('[data-room]').forEach(button => button.addEventListener('click', () => { void open(`/rooms/${encodeURIComponent(button.dataset.room!)}/join`, {}); }));
    root.querySelector<HTMLFormElement>('#create-room')?.addEventListener('submit', event => { event.preventDefault(); void open('/rooms', { name: new FormData(event.currentTarget as HTMLFormElement).get('name') }); });
    // Players with a single room skip the lobby and land straight in the game (organizers keep it to manage things).
    if (!profile.account.organizer && rooms.length === 1 && !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('lobby'))) {
      root.querySelector('#account-status')!.textContent = 'Opening your room…';
      void open(`/rooms/${encodeURIComponent(rooms[0].code)}/join`, {});
    }
  } catch {
    root.innerHTML = '<main class="recovery"><h1>Unable to open your rooms.</h1><a href="/" class="primary">Try again</a></main>';
  }
}
const steps = [
  ['1', 'Open your personal link', 'Your organizer sends you a link on Slack made only for you. It fills in your code and greets you by name.'],
  ['2', 'Choose a password', 'Keep the suggested username, then type a password of 15+ characters or press “Suggest a password”. Save it when your browser asks.'],
  ['3', 'Play', 'You land straight in the room, with your own name, team and steps. Next time, just sign in with your username and password.'],
];
const basics = [
  ['👟', 'Steps become paint', 'One step is one paint. Each day’s steps are added when your host moves the shared calendar to the next day.'],
  ['🎨', 'Paint the canvas', `An empty pixel costs ${COST.brush} paint. Taking a rival’s pixel costs ${COST.rival}. Painting over your own team is free.`],
  ['🛡️', 'Bombs and shields', `A bomb (${COST.bomb}) splashes up to 25 pixels. A shield (${COST.shield}) protects up to 9 of your pixels for two hours.`],
  ['📅', 'One day at a time', 'Your host walks the calendar forward through every recorded day. When the steps run out, keep walking and wait for the next update.'],
];
const questions = [
  ['Do I need to install anything?', 'No. Any modern browser on a computer, tablet or phone works.'],
  ['Who can see my steps?', 'Only you. Everyone can see the teams and the canvas, but your daily steps stay private.'],
  ['My link does not work.', 'Each link works once and lasts a few days. If you already created your account, sign in instead; otherwise ask your organizer for a fresh link.'],
  ['I forgot my password.', 'Ask your organizer for a recovery code, then use “Forgot your password?” at the bottom of this page.'],
  ['The page looks stuck.', 'Refresh it. Your progress is saved on the server, so nothing is lost.'],
];
/** The welcome page content, shared by the signed-out home page and the signed-in "How it works" page. */
const introHTML = `<section class="intro"><div><p class="eyebrow">ONE TEAM PLAYGROUND</p><h1>Your steps.<br><em>Your splash.</em></h1><p class="intro-copy">Every step you walked this summer is paint. Bring your team to one big canvas, claim your corner and defend it.</p></div><div class="lobby-sticker" aria-hidden="true">✳<span>LET’S<br>PAINT!</span></div></section>
    <div class="lobby-facts"><span>🎨 One canvas for every team</span><span>👟 Your steps are your paint</span><span>📅 Played one day at a time</span><span>🔒 Only you see your steps</span></div>`;
const stepsHTML = `<section class="howto"><p class="eyebrow">NEW HERE? IT TAKES A MINUTE</p><h2>Get in with three steps.</h2><div class="howto-grid">${steps.map(([n, title, copy]) => `<article class="howto-card"><span class="howto-number">${n}</span><h3>${title}</h3><p>${copy}</p></article>`).join('')}</div></section>`;
const infoHTML = `<section class="howto"><p class="eyebrow">THE GAME IN A MINUTE</p><h2>Paint. Defend. Repeat.</h2><div class="howto-grid four">${basics.map(([icon, title, copy]) => `<article class="howto-card"><span class="howto-icon" aria-hidden="true">${icon}</span><h3>${title}</h3><p>${copy}</p></article>`).join('')}</div></section>
    <section class="howto"><p class="eyebrow">GOOD TO KNOW</p><h2>Quick answers.</h2><div class="faq">${questions.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></section>`;
/** Signed-in view of the same page, so anyone can reread how the challenge works. */
function welcome(root: HTMLElement, profile: Profile) {
  root.innerHTML = `<header class="site-header"><a class="brand" href="/">edge<span>canvas</span></a><a class="secondary" href="/">My rooms →</a></header><main class="workspace lobby">${introHTML}
    <section class="card join-card"><p class="eyebrow">YOU ARE IN</p><h2>Signed in as ${esc(profile.account.username)}.</h2><p>Your account is ready. Pick your room and start painting with your team.</p><a class="primary" href="/">Go to my rooms</a></section>
    ${stepsHTML}${infoHTML}</main>`;
}
/** A personal link: fill in the code, greet its owner, propose a username and take them to the right card. */
async function greet(root: HTMLElement, code: string) {
  root.querySelector<HTMLInputElement>('#register-enrollment')!.value = code;
  history.replaceState(null, '', location.pathname); // keep the code out of the address bar and the history entry
  const owner = await describeCode(code), note = root.querySelector<HTMLElement>('#code-greeting')!;
  note.hidden = false;
  if (!owner) {
    note.classList.add('warning');
    note.textContent = 'This link has expired or was already used. If you already created your account, sign in below. Otherwise ask your organizer for a new link.';
    root.querySelector('#sign-in')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  root.querySelector<HTMLInputElement>('#register-username')!.value = owner.username;
  note.textContent = `Welcome, ${owner.name}! You are joining ${owner.team}. Choose a password and you are in.`;
  root.querySelector('.create-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  root.querySelector<HTMLInputElement>('#register-password')?.focus({ preventScroll: true });
}
function login(root: HTMLElement) {
  const field = (kind: string, name: string, label: string, extra = '') => `<label for="${kind}-${name}">${label}</label><input id="${kind}-${name}" name="${name}" ${extra}>`;
  const password = (kind: 'login' | 'register') => `${field(kind, 'password', 'Password', `type="password" required ${kind === 'register' ? 'minlength="15"' : ''} maxlength="128" autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}"`)}<label class="show-password"><input type="checkbox" data-show="${kind}-password"> Show password</label>`;
  const username = (kind: string) => field(kind, 'username', 'Username', 'required minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" autocomplete="username" autocapitalize="none" spellcheck="false"');
  root.innerHTML = `<header class="site-header"><a class="brand" href="/">edge<span>canvas</span></a><a class="secondary" href="#sign-in">Sign in ↓</a></header><main class="workspace lobby">
    ${introHTML}
    <p id="account-status" class="feedback" role="status"></p>
    ${stepsHTML}
    <div class="lobby-forms">
      <section class="card create-card"><p class="eyebrow">STEP 2 · FIRST TIME</p><h2>Create your account</h2><form id="register"><p id="code-greeting" class="greeting" role="status" hidden></p>${field('register', 'enrollment', 'Registration code', 'required maxlength="43" autocomplete="off" spellcheck="false" placeholder="Paste the code from Slack"')}<p>This connects you to your own name, team and steps.</p>${username('register')}${password('register')}<button type="button" class="secondary" id="suggest-password">Suggest a password</button><p>At least 15 characters. Press the button for an easy one, and let your browser save it. Common passwords are blocked.</p><button class="primary" type="submit">Create account</button></form></section>
      <section class="card join-card" id="sign-in"><p class="eyebrow">STEP 3 · EVERY TIME AFTER</p><h2>Sign in</h2><form id="login">${username('login')}${password('login')}<button class="primary" type="submit">Sign in</button></form></section>
    </div>
    ${infoHTML}
    <div class="faq"><details><summary>Forgot your password? Use a recovery code</summary><p>Ask your organizer to verify your identity and issue a recovery code.</p><form id="recover"><label for="recovery-code">Recovery code</label><input id="recovery-code" name="code" required maxlength="43" autocomplete="off" spellcheck="false"><label for="recovery-password">New password</label><input id="recovery-password" name="password" type="password" required minlength="15" maxlength="128" autocomplete="new-password"><p>Use a unique password of at least 15 characters.</p><button class="primary">Reset password</button></form></details></div>
  </main>`;
  root.querySelectorAll<HTMLInputElement>('[data-show]').forEach(box => box.addEventListener('change', () => { root.querySelector<HTMLInputElement>(`#${box.dataset.show}`)!.type = box.checked ? 'text' : 'password'; }));
  root.querySelector<HTMLButtonElement>('#suggest-password')?.addEventListener('click', () => {
    const field = root.querySelector<HTMLInputElement>('#register-password')!, box = root.querySelector<HTMLInputElement>('[data-show="register-password"]');
    field.value = passphrase(); field.type = 'text'; if (box) box.checked = true; field.focus();
  });
  const personalCode = typeof location === 'undefined' ? null : codeFromLocation(location);
  if (personalCode) void greet(root, personalCode);
  for (const kind of ['login', 'register', 'recover']) root.querySelector<HTMLFormElement>(`#${kind}`)!.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => button.disabled = true);
    const input = Object.fromEntries(new FormData(form));
    try { await api(`/auth/${kind}`, input); form.reset();
      if (kind === 'recover') { login(root); root.querySelector('#account-status')!.textContent = 'Password reset. Sign in with your new password.'; }
      else await mountAccounts(root); }
    catch (error) { root.querySelector('#account-status')!.textContent = (error instanceof Error ? error.message : 'Please retry.') + (kind === 'recover' ? ' If the response was interrupted, try signing in with your new password before requesting another code.' : ''); buttons.forEach(button => button.disabled = false); }
    finally { input.password = ''; }
  });
}
