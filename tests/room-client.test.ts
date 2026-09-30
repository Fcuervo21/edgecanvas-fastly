import { afterEach, expect, test, vi } from 'vitest';
import { connectRoom } from '../src/rooms/client';
import type { RoomView } from '../src/rooms/types';
const initial={revision:0,code:'ROOM'} as RoomView;
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>vi.useRealTimers());
test('serializes commands and retries an uncertain result using the same command ID',async()=>{
  vi.useFakeTimers();
  const requests: {id:string;command:{type:string}}[]=[];
  let first=true;
  const seen:number[]=[];
  const request=async (_url:unknown, init?:RequestInit)=>{
    if(init?.method!=='POST') return response({unchanged:true});
    const body=JSON.parse(init.body as string);requests.push(body);
    if(first){first=false;throw new TypeError('network lost after commit');}
    return response({view:{...initial,revision:requests.length-1},code:'OK',changed:[]});
  };
  const client=connectRoom({code:'ROOM',token:'secret'},initial,{view:v=>seen.push(v.revision),status:()=>{}},request as typeof fetch);
  client.submit({type:'buy',item:'bomb'});client.submit({type:'buy',item:'shield'});
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests).toHaveLength(3);
  expect(requests[0].id).toBe(requests[1].id);
  expect(requests[2].id).not.toBe(requests[0].id);
  expect(requests.map(r=>r.command)).toEqual([{type:'buy',item:'bomb'},{type:'buy',item:'bomb'},{type:'buy',item:'shield'}]);
  expect(seen).toEqual([1,2]);client.stop();
});
test('a delayed poll never replaces a newer acknowledged room revision',async()=>{
  let resolvePoll:(r:Response)=>void=()=>{};
  const seen:number[]=[];
  const request=(_url:unknown,init?:RequestInit)=> init?.method==='POST'
    ? Promise.resolve(response({view:{...initial,revision:2},code:'OK',changed:[1]}))
    : new Promise<Response>(resolve=>{resolvePoll=resolve;});
  const client=connectRoom({code:'ROOM',token:'secret'},initial,{view:v=>seen.push(v.revision),status:()=>{}},request as typeof fetch);
  const poll=client.poll();client.submit({type:'buy',item:'bomb'});
  await new Promise(resolve=>setTimeout(resolve,0));
  resolvePoll(response({...initial,revision:1}));await poll;
  expect(seen).toEqual([2]);client.stop();
});
test('expired sessions stop queued spending rather than retry forever',async()=>{
  vi.useFakeTimers();let calls=0;const messages:string[]=[];
  const client=connectRoom({code:'ROOM',token:'expired'},initial,{view:()=>{},status:m=>messages.push(m)},(async()=>{calls++;return response({error:'Session expired'},401);}) as typeof fetch);
  client.submit({type:'buy',item:'bomb'});client.submit({type:'buy',item:'shield'});
  await vi.advanceTimersByTimeAsync(4000);
  expect(calls).toBe(1);expect(messages.join(' ')).toMatch(/expired/i);expect(client.submit({type:'buy',item:'bomb'})).toBe(false);client.stop();
});
test('a successful poll clears a connection warning even when the revision is unchanged', async () => {
  let first = true; const statuses: {message:string; warning?:boolean}[] = [];
  const client = connectRoom({code:'ROOM',token:'secret'}, initial, {
    view:()=>{}, status:(message,warning)=>statuses.push({message,warning}),
  }, (async()=>{if(first){first=false;throw new TypeError('offline');}return response({unchanged:true});}) as typeof fetch);
  await client.poll(); await client.poll(); client.stop();
  expect(statuses[0].warning).toBe(true);
  expect(statuses.at(-1)?.message).toMatch(/connected/i);
  expect(statuses.at(-1)?.warning).not.toBe(true);
});
test('account connections send cookie credentials and CSRF without bearer credentials', async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ unchanged: true }));
  const client = connectRoom({ code: 'ROOM', csrfToken: 'csrf' }, initial, { view: () => {}, status: () => {} }, request);
  await client.poll();
  expect(request.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf' } });
  expect(new Headers(request.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  client.stop();
});
