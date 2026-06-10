'use client';

import { useEffect } from 'react';

function isBenignCancelError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const error = reason as { name?: unknown; message?: unknown };
  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return name === 'CancelError' || /cancelerror/i.test(message) || /animation.*cancel/i.test(message);
}

export function RuntimeErrorGuard() {
  useEffect(() => {
    function onUnhandledRejection(event: PromiseRejectionEvent) {
      if (!isBenignCancelError(event.reason)) return;
      event.preventDefault();
    }

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

  return null;
}
