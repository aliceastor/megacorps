'use client';

import { useEffect } from 'react';

export function AppMouseMotion() {
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-frame');
    if (!shell) return;
    const root = shell;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) return;

    let targetX = 0.5;
    let targetY = 0.34;
    let currentX = targetX;
    let currentY = targetY;
    let frame = 0;

    function writeVars() {
      currentX += (targetX - currentX) * 0.14;
      currentY += (targetY - currentY) * 0.14;

      root.style.setProperty('--mouse-x', `${(currentX * 100).toFixed(2)}%`);
      root.style.setProperty('--mouse-y', `${(currentY * 100).toFixed(2)}%`);
      root.style.setProperty('--mouse-shift-x', `${((currentX - 0.5) * 34).toFixed(2)}px`);
      root.style.setProperty('--mouse-shift-y', `${((currentY - 0.5) * 28).toFixed(2)}px`);

      if (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001) {
        frame = window.requestAnimationFrame(writeVars);
      } else {
        frame = 0;
      }
    }

    function schedule(event: PointerEvent) {
      targetX = event.clientX / Math.max(window.innerWidth, 1);
      targetY = event.clientY / Math.max(window.innerHeight, 1);
      if (!frame) frame = window.requestAnimationFrame(writeVars);
    }

    function reset() {
      targetX = 0.5;
      targetY = 0.34;
      if (!frame) frame = window.requestAnimationFrame(writeVars);
    }

    window.addEventListener('pointermove', schedule, { passive: true });
    window.addEventListener('pointerleave', reset);
    return () => {
      window.removeEventListener('pointermove', schedule);
      window.removeEventListener('pointerleave', reset);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
