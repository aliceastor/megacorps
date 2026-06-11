'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';
type ToastItem = { id: number; kind: ToastKind; message: string };
type ToastCtx = { toast: (message: string, kind?: ToastKind) => void };

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((current) => [...current.slice(-4), { id, kind, message }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  return <Ctx.Provider value={{ toast }}>
    {children}
    <div className="global-toast-stack" role="status" aria-live="polite">
      {items.map((item) => <div key={item.id} className={`global-toast ${item.kind}`}>{item.message}</div>)}
    </div>
  </Ctx.Provider>;
}

export function useToast() {
  return useContext(Ctx);
}
