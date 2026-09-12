import { useEffect, useRef, type ReactNode } from "react";

export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // React가 dialog를 먼저 제거해도 키보드 위치를 잃지 않도록 복구한다.
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) previous.focus();
        else document.querySelector<HTMLElement>("[data-workspace-trigger]")?.focus();
      });
    };
  }, []);
  return <dialog ref={ref} className="workspace-dialog" aria-label={title} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="row-between"><h2>{title}</h2><button aria-label="닫기" disabled={busy} onClick={onClose}>✕</button></div>
    {children}
  </dialog>;
}
