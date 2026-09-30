import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindPainting } from '../src/ui/pointer';
import type { Point } from '../src/game/types';
class Surface extends EventTarget {
  captured: number | null = null;
  getBoundingClientRect() { return {left:0,top:0,width:100,height:100}; }
  focus() {}
  setPointerCapture(id:number) { this.captured=id; }
  hasPointerCapture(id:number) { return this.captured===id; }
  releasePointerCapture() { this.captured=null; }
}
let canvas: Surface;
let cells: Point[];
let stamps: Point[];
let continuous: boolean;
let permit: boolean;
const pointer=(type:string,x:number,y:number,extras={}) => canvas.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),{clientX:x+.5,clientY:y+.5,pointerId:1,isPrimary:true,button:0,buttons:type==='pointerup'?0:1,...extras}));
beforeEach(()=>{
  vi.useFakeTimers();
  vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));
  canvas=new Surface(); cells=[]; stamps=[]; continuous=true; permit=true;
  bindPainting(canvas as unknown as HTMLCanvasElement,{
    continuous:()=>continuous, apply:p=>stamps.push(p), stroke:ps=>{cells.push(...ps); return permit;}, hover:()=>{},
  });
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
test('hold and drag interpolates a complete path, batches moves, and finishes on release',()=>{
  pointer('pointerdown',1,2);
  expect(cells).toEqual([{x:1,y:2}]);
  pointer('pointermove',5,2);
  expect(cells).toHaveLength(1);
  vi.advanceTimersByTime(50);
  expect(cells).toEqual([1,2,3,4,5].map(x=>({x,y:2})));
  pointer('pointermove',8,2);
  pointer('pointerup',8,2);
  expect(cells).toEqual([1,2,3,4,5,6,7,8].map(x=>({x,y:2})));
  vi.advanceTimersByTime(500);
  expect(cells).toHaveLength(8);
  expect(canvas.captured).toBeNull();
});
test('holding still does not repeatedly paint or spend',()=>{
  pointer('pointerdown',2,2); vi.advanceTimersByTime(1000);
  pointer('pointermove',2,2); vi.advanceTimersByTime(1000);
  pointer('pointerup',2,2);
  expect(cells).toEqual([{x:2,y:2}]);
});
test('stamps and inventory tools apply only once per press, even while dragging',()=>{
  continuous=false;
  pointer('pointerdown',2,2); pointer('pointermove',9,9); vi.advanceTimersByTime(1000); pointer('pointerup',9,9);
  expect(stamps).toEqual([{x:2,y:2}]); expect(cells).toEqual([]);
});
test.each(['pointercancel','lostpointercapture','blur'])('%s cancels pending paint',event=>{
  pointer('pointerdown',2,2); pointer('pointermove',5,2);
  pointer(event,5,2); vi.advanceTimersByTime(1000);
  expect(cells).toEqual([{x:2,y:2}]);
});
test('leaving the canvas ends the stroke instead of drawing a bridge on reentry',()=>{
  pointer('pointerdown',2,2); pointer('pointermove',101,2); pointer('pointermove',5,2); pointer('pointerup',5,2);
  expect(cells).toEqual([{x:2,y:2}]);
});
test('right click and secondary pointers cannot spend paint or interrupt the primary stroke',()=>{
  pointer('pointerdown',2,2,{button:2,buttons:2}); expect(cells).toEqual([]);
  pointer('pointerdown',2,2); pointer('pointermove',8,8,{pointerId:2,isPrimary:false}); pointer('pointerup',8,8,{pointerId:2,isPrimary:false});
  pointer('pointerleave',8,8,{pointerId:2,isPrimary:false});
  pointer('pointermove',3,2); pointer('pointerup',3,2);
  expect(cells).toEqual([{x:2,y:2},{x:3,y:2}]);
});
test('a rejected stroke stops all further automatic painting',()=>{
  permit=false; pointer('pointerdown',2,2); pointer('pointermove',5,2); vi.advanceTimersByTime(1000); pointer('pointerup',5,2);
  expect(cells).toEqual([{x:2,y:2}]);
});
test.each(['blur','visibilitychange'])('backgrounding via %s stops pending strokes',event=>{
  pointer('pointerdown',2,2); pointer('pointermove',5,2);
  if(event==='blur') window.dispatchEvent(new Event(event));
  else { Object.assign(document,{hidden:true}); document.dispatchEvent(new Event(event)); }
  vi.advanceTimersByTime(1000); expect(cells).toEqual([{x:2,y:2}]);
});
