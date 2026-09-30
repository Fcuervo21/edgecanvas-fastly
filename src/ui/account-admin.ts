import { escapeHTML as esc } from './html';
type Request = <T>(path: string, body?: unknown, csrf?: string) => Promise<T>;
interface Member { id: string; username: string; playerId: string; organizer: boolean; disabled: boolean }
export async function mountAccountAdmin(root: HTMLElement, csrf: string, request: Request) {
  const members = await request<Member[]>('/admin/accounts');
  const card = (member: Member) => {
    const [team, ...rest] = member.playerId.split(':'), person = rest.join(':') || member.playerId;
    return `<section class="account-card"><div class="account-head"><h3>${esc(member.username)}</h3><span class="badge">${member.organizer ? 'Organizer' : 'Member'}</span><span class="badge ${member.disabled ? 'off' : 'on'}">${member.disabled ? 'Disabled' : 'Active'}</span></div><p class="account-person">${esc(person)} · ${esc(team)}</p>${member.disabled ? '' : `<form data-account="${esc(member.id)}"><label class="confirm"><input type="checkbox" required> I verified this account and the intended action.</label><div class="account-actions"><button type="submit" class="secondary" value="recovery">Recovery code</button><button type="submit" class="secondary" value="revoke-recovery">Revoke</button><button type="submit" class="secondary" value="disable">Disable</button></div></form>`}</section>`;
  };
  root.innerHTML = `<h2>Manage accounts</h2><p>Verify the recipient before issuing a recovery code. Codes last 15 minutes. A completed reset signs out all of that account’s sessions.</p><p id="admin-status" role="status"></p><div id="recovery-delivery"></div><div class="admin-list">${members.map(card).join('')}</div>`;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  root.querySelectorAll<HTMLFormElement>('form[data-account]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!action || !['recovery', 'revoke-recovery', 'disable'].includes(action.value)) return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => button.disabled = true);
    const delivery = root.querySelector('#recovery-delivery')!; delivery.replaceChildren(); clearTimeout(expiry);
    try {
      const result = await request<{ code?: string; expiresAt?: number }>(`/admin/accounts/${encodeURIComponent(form.dataset.account!)}/${action.value}`, {}, csrf);
      if (action.value === 'recovery' && result.code && result.expiresAt) {
        delivery.innerHTML = '<p>Deliver this code privately to the verified recipient. It is shown only here.</p><label>Recovery code<input readonly autocomplete="off"></label><button type="button" class="secondary">Done — hide code</button>';
        delivery.querySelector('input')!.value = result.code;
        delivery.querySelector('button')!.addEventListener('click', () => delivery.replaceChildren(), { once: true });
        expiry = setTimeout(() => delivery.replaceChildren(), Math.max(0, result.expiresAt - Date.now()));
      }
      root.querySelector('#admin-status')!.textContent = action.value === 'disable' ? 'Account disabled. Existing sessions have been revoked.' : action.value === 'recovery' ? 'Recovery code issued. Any previous code is invalid.' : 'Recovery code revoked.';
      if (action.value === 'disable') form.replaceWith(document.createTextNode('Disabled'));
      else form.reset();
    } catch (error) { root.querySelector('#admin-status')!.textContent = error instanceof Error ? error.message : 'Request failed. Reload to check the account before retrying.'; }
    finally { buttons.forEach(button => button.disabled = false); }
  }));
}
