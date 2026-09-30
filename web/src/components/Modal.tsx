import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Tailwind max-width class of the panel. */
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** A native modal <dialog>: focus trap and Escape come from the browser. */
export default function Modal({ open, onClose, title, width = 'max-w-3xl', children, footer }: Readonly<ModalProps>) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100vw-24px)] ${width} rounded-2xl border border-line bg-bg p-0 text-fg shadow-pop backdrop:bg-black/40`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 id="modal-title" className="text-[15px] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg">
              <X aria-hidden className="size-4" />
              <span className="sr-only">Đóng</span>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export const fieldCls =
  'w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-focus focus:outline-none';
export const btnCls = 'h-8 rounded-lg border border-line px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface disabled:opacity-50';
export const primaryBtnCls = 'h-8 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-fg transition-opacity hover:opacity-85 disabled:opacity-50';
