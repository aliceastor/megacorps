'use client';

import { useEffect } from 'react';

type MouseMotionState = {
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
};

type MouseMotionWindow = Window & {
  __megacorpsMouseMotion?: MouseMotionState;
};

const DEFAULT_X = 0.5;
const DEFAULT_Y = 0.34;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function parsePercent(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? clampUnit(parsed / 100) : fallback;
}

function getInitialState(): MouseMotionState {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const x = parsePercent(root.style.getPropertyValue('--app-mouse-x') || styles.getPropertyValue('--app-mouse-x'), DEFAULT_X);
  const y = parsePercent(root.style.getPropertyValue('--app-mouse-y') || styles.getPropertyValue('--app-mouse-y'), DEFAULT_Y);
  return { targetX: x, targetY: y, currentX: x, currentY: y };
}

function getMotionState(): MouseMotionState {
  const motionWindow = window as MouseMotionWindow;
  motionWindow.__megacorpsMouseMotion ??= getInitialState();
  return motionWindow.__megacorpsMouseMotion;
}

function writeRootVars(root: HTMLElement, x: number, y: number) {
  root.style.setProperty('--app-mouse-x', formatPercent(x));
  root.style.setProperty('--app-mouse-y', formatPercent(y));
  root.style.setProperty('--app-mouse-shift-x', `${((x - 0.5) * 34).toFixed(2)}px`);
  root.style.setProperty('--app-mouse-shift-y', `${((y - 0.5) * 28).toFixed(2)}px`);
}

export function AppMouseMotion() {
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-frame');
    if (!shell) return;
    const root = document.documentElement;
    const state = getMotionState();
    writeRootVars(root, state.currentX, state.currentY);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) return;

    let frame = 0;

    function writeVars() {
      state.currentX += (state.targetX - state.currentX) * 0.14;
      state.currentY += (state.targetY - state.currentY) * 0.14;

      writeRootVars(root, state.currentX, state.currentY);

      if (Math.abs(state.targetX - state.currentX) > 0.001 || Math.abs(state.targetY - state.currentY) > 0.001) {
        frame = window.requestAnimationFrame(writeVars);
      } else {
        frame = 0;
      }
    }

    function schedule(event: PointerEvent) {
      state.targetX = clampUnit(event.clientX / Math.max(window.innerWidth, 1));
      state.targetY = clampUnit(event.clientY / Math.max(window.innerHeight, 1));
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
