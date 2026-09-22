import { useEffect, useRef, type ReactNode } from 'react';
import { X, AlertCircle, Radio } from 'lucide-react';
import { labels } from '../lib/format';
export function Badge({ value }: { value: string }) { return <span className={'badge badge-' + value.toLowerCase()}><i />{labels[value] ?? value.replaceAll('_', ' ')}</span>; }
export function Demo({ show }: { show?: boolean }) { return show ? <span className="demo-label">DEMO</span> : null; }
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) { return message ? <div className="error-notice" role="alert"><AlertCircle size={18} /><span>{message}</span>{retry && <button className="text-button" onClick={retry}>Try again</button>}</div> : null; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><Radio size={30} /><h3>{title}</h3><p>{children}</p></div>; }
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close(): void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); const prior = document.activeElement as HTMLElement | null; return () => { prior?.focus(); }; }, []);
  return <dialog ref={ref} className={'modal ' + (wide ? 'modal-wide' : '')} onCancel={event => { event.preventDefault(); close(); }}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20} /></button></div>{children}</dialog>;
}
export function Pager({ offset, hasMore, onPage, busy = false }: { offset: number; hasMore: boolean; onPage(offset: number): void; busy?: boolean }) { return <div className="pager"><span>Page {Math.floor(offset / 25) + 1}</span><button className="button subtle" disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - 25))}>Previous</button><button className="button subtle" disabled={busy || !hasMore} onClick={() => onPage(offset + 25)}>Next</button></div>; }
