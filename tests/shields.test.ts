import { expect, test } from 'vitest';
import { shieldRegions } from '../src/ui/shields';
import type { Cell } from '../src/game/types';
const board = (): Cell[] => Array.from({length:10000},()=>({owner:null,shieldUntil:0}));
test('marks connected protected cells without filling gaps or including expired paint',()=>{
  const cells=board();
  for(const i of [101,102,202,204]) cells[i]={owner:'Amber Foxes',shieldUntil:120};
  cells[103]={owner:'Amber Foxes',shieldUntil:60};
  const regions=shieldRegions(cells,60);
  expect(regions.map(r=>r.cells.slice().sort((a,b)=>a-b))).toEqual([[101,102,202],[204]]);
  for(const region of regions) expect(region.cells).toContain(region.anchor);
  expect(shieldRegions(cells,120)).toEqual([]);
});
test('does not connect opposite row edges or different teams',()=>{
  const cells=board();
  cells[99]={owner:'Amber Foxes',shieldUntil:120};
  cells[100]={owner:'Amber Foxes',shieldUntil:120};
  cells[101]={owner:'OTHER',shieldUntil:120};
  expect(shieldRegions(cells,0).map(r=>r.cells)).toEqual([[99],[100],[101]]);
});
