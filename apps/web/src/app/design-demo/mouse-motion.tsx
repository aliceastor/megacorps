'use client';

import { useEffect } from 'react';

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function parsePercent(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? clampUnit(parsed / 100) : fallback;
}

export function DesignDemoMouseMotion() {
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.mc-ref-shell');
    if (!shell) return;
    const root = shell;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) return;

    const styles = getComputedStyle(root);
    let targetX = parsePercent(root.style.getPropertyValue('--mouse-x') || styles.getPropertyValue('--mouse-x'), 0.5);
    let targetY = parsePercent(root.style.getPropertyValue('--mouse-y') || styles.getPropertyValue('--mouse-y'), 0.34);
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
      root.style.setProperty('--mouse-tilt-x', `${((0.5 - currentY) * 2.2).toFixed(2)}deg`);
      root.style.setProperty('--mouse-tilt-y', `${((currentX - 0.5) * 2.6).toFixed(2)}deg`);

      if (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001) {
        frame = window.requestAnimationFrame(writeVars);
      } else {
        frame = 0;
      }
    }

    function schedule(event: PointerEvent) {
      targetX = clampUnit(event.clientX / Math.max(window.innerWidth, 1));
      targetY = clampUnit(event.clientY / Math.max(window.innerHeight, 1));
      if (!frame) frame = window.requestAnimationFrame(writeVars);
    }

    window.addEventListener('pointermove', schedule, { passive: true });
    window.addEventListener('pointerdown', schedule, { passive: true });
    return () => {
      window.removeEventListener('pointermove', schedule);
      window.removeEventListener('pointerdown', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
