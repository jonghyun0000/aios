import { useEffect, useRef, type ReactNode } from "react";

export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 자식의 autoFocus가 먼저 실행되므로 effect 안에서 읽으면 이미 모달 내부를 가리킨다.
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    const dialog = ref.current;
    const previous = opener.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-modal-initial-focus]")?.focus();
    return () => {
      dialog?.close();
      // React가 dialog를 먼저 제거해도 키보드 위치를 잃지 않도록 복구한다.
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected && previous.checkVisibility()) previous.focus();
        else (document.querySelector<HTMLElement>("[data-workspace-trigger]") ?? document.getElementById("main-content"))?.focus();
      });
    };
  }, []);
  return <dialog ref={ref} className="workspace-dialog" aria-label={title} tabIndex={-1} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    // native dialog는 배경을 inert로 만들지만 브라우저 툴바까지 Tab이 빠질 수 있다.
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter((element) => element.checkVisibility());
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <div className="row-between"><h2>{title}</h2><button aria-label="닫기" disabled={busy} onClick={onClose}>✕</button></div>
    {children}
  </dialog>;
}
