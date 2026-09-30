import { expect, test } from 'vitest';
import { createGame, dispatch } from '../src/game/engine';
import { previewTargets } from '../src/game/targets';
import type { Command, Dataset } from '../src/game/types';
import { COST } from '../src/game/rules';
const data: Dataset = { dates: ['2026-07-01'], players: [{id:'p', name:'Player', team:'T', dailyGoal:3000,totalSteps:10000,days:{'2026-07-01':10000}}] };
const start = () => createGame(data, 'p');
test('a continuous stroke charges each new cell once in path order', () => {
  const state = start();
  const result = dispatch(state, {type:'stroke', points:[{x:1,y:2},{x:2,y:2},{x:1,y:2},{x:3,y:2}]} as Command, data);
  expect(result.code).toBe('OK');
  expect(result.changed).toEqual([201,202,203]);
  expect(result.state.balance).toBe(10000 - 3 * COST.brush);
  expect(state.cells[201].owner).toBeNull();
  const again = dispatch(result.state, {type:'stroke', points:[{x:2,y:2},{x:4,y:2}]} as Command, data);
  expect(again.changed).toEqual([204]);
  expect(again.state.balance).toBe(10000 - 4 * COST.brush);
});
test('a stroke stops at the last affordable pixel and cannot overspend', () => {
  const state={...start(), balance:2 * COST.brush + 5, spent:10000 - (2 * COST.brush + 5)};
  const result=dispatch(state,{type:'stroke',points:[{x:0,y:0},{x:1,y:0},{x:2,y:0}]} as Command,data);
  expect(result.changed).toEqual([0,1]);
  expect(result.state.balance).toBe(5);
  expect(result.state.spent).toBe(9995);
  expect(dispatch(result.state,{type:'stroke',points:[{x:2,y:0}]} as Command,data).code).toBe('INSUFFICIENT_PAINT');
});
test('invalid stroke coordinates reject the whole segment without spending', () => {
  const state=start();
  expect(dispatch(state,{type:'stroke',points:[{x:0,y:0},{x:100,y:0}]} as Command,data)).toMatchObject({code:'OUT_OF_BOUNDS',state});
});
test.each(['circle','star','heart'] as const)('%s stamps match their preview and charge only new pixels', shape => {
  const state = start();
  const result = dispatch(state,{type:'apply',tool:'brush',shape,x:50,y:50} as Command,data);
  expect(result.changed.length).toBeGreaterThan(1);
  expect(result.changed).toEqual(previewTargets(state,'brush',50,50,shape));
  expect(result.state.balance).toBe(10000-result.changed.length*COST.brush);
  const repeat=dispatch(result.state,{type:'apply',tool:'brush',shape,x:50,y:50} as Command,data);
  expect(repeat.code).toBe('NO_CHANGE');
  expect(repeat.state).toBe(result.state);
  const overlap=dispatch(result.state,{type:'apply',tool:'brush',shape,x:51,y:50} as Command,data);
  expect(overlap.state.balance).toBe(result.state.balance-overlap.changed.length*COST.brush);
});
test('stamps clip at the edge, and unaffordable stamps remain whole', () => {
  const state=start();
  const edge=dispatch(state,{type:'apply',tool:'brush',shape:'heart',x:0,y:0} as Command,data);
  expect(edge.changed.length).toBeGreaterThan(1);
  expect(edge.changed.every(i=>i>=0 && i<10000)).toBe(true);
  const poor={...state,balance:COST.brush,spent:10000-COST.brush};
  expect(dispatch(poor,{type:'apply',tool:'brush',shape:'heart',x:50,y:50} as Command,data)).toMatchObject({state:poor,code:'INSUFFICIENT_PAINT',changed:[]});
});
