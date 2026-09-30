import { animate } from 'motion/mini';
import type { Command } from '../game/types';

/** Visual feedback only. No animation callback can change the game state. */
export function createMotion(root: HTMLElement) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Map<Element, ReturnType<typeof animate>>();

  function play(element: HTMLElement | null, frames: Parameters<typeof animate>[1], duration = .35, delay = 0) {
    if (!element || reduced.matches) return;
    running.get(element)?.complete();
    const animation = animate(element, frames, { duration, delay, ease: 'easeOut' });
    running.set(element, animation);
    void animation.finished.then(() => {
      if (running.get(element) !== animation) return;
      running.delete(element);
      element.style.removeProperty('transform');
      element.style.removeProperty('opacity');
    });
  }
  const find = (selector: string) => root.querySelector<HTMLElement>(selector);
  const pop = (selector: string) => play(find(selector), { transform: ['scale(.94)', 'scale(1.04)', 'scale(1)'] });
  reduced.addEventListener('change', () => {
    if (reduced.matches) for (const animation of running.values()) animation.complete();
  });

  return {
    enter() {
      root.querySelectorAll<HTMLElement>('.intro, .studio, .sidebar .card, .history-strip').forEach((element, index) => {
        play(element, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0)'] }, .45, index * .045);
      });
      play(find('.intro-art'), { transform: ['rotate(-12deg) scale(.8)', 'rotate(13deg) scale(1.06)', 'rotate(8deg) scale(1)'] }, .7, .1);
    },
    select(element: HTMLElement) { play(element, { transform: ['scale(.97)', 'scale(1)'] }, .22); },
    error() { play(find('#feedback'), { opacity: [.4, 1] }, .25); },
    openDialog() { play(find('#reset-dialog'), { opacity: [0, 1], transform: ['translateY(8px) scale(.98)', 'translateY(0) scale(1)'] }, .2); },
    action(command: Command, difference: number) {
      if (difference) {
        pop('#balance');
        const delta = find('#balance-change');
        if (delta) {
          delta.textContent = `${difference > 0 ? '+' : '−'}${Math.abs(difference).toLocaleString('en-US')} paint`;
          play(delta, { opacity: [0, 1, 1, 0], transform: ['translateY(5px)', 'translateY(-12px)'] }, .9);
        }
      }
      if (command.type === 'advance') {
        pop('#day');
        play(find('#history .current'), { transform: ['scaleY(.5)', 'scaleY(1)'] }, .4);
      } else if (command.type === 'buy') {
        pop(`#${command.item}-stock`);
        pop(command.item === 'bomb' ? '.bomb-icon' : '.shield-icon');
      } else if (command.type === 'apply' && command.tool === 'bomb') {
        play(find('.frame'), { transform: ['translateY(0)', 'translateY(-2px)', 'translateY(1px)', 'translateY(0)'] }, .25);
      } else if (command.type === 'apply' && command.tool === 'shield') {
        play(find('#shield-status'), { opacity: [.25, 1] }, .4);
      }
      play(find('#activity li'), { opacity: [0, 1], transform: ['translateY(5px)', 'translateY(0)'] }, .25);
    },
  };
}
