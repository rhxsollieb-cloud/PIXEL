import {
  forwardRef,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type ReactElement,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

function classes(...values: (string | undefined | false)[]): string {
  return values.filter(Boolean).join(' ');
}

export interface PixelPanelProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  eyebrow?: string;
  right?: ReactNode;
}

export function PixelPanel({ title, eyebrow, right, children, className, ...props }: PixelPanelProps) {
  return <div className={classes('pixel-panel', className)} {...props}>
    {(title || eyebrow || right) && <div className="pixel-panel__header">
      <div className="pixel-panel__heading">{eyebrow && <span className="pixel-description">{eyebrow}</span>}{title && <h2 className="pixel-title">{title}</h2>}</div>
      {right && <div className="pixel-panel__right">{right}</div>}
    </div>}
    {children}
  </div>;
}

export interface PixelBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'green' | 'amber' | 'red';
}

export function PixelBadge({ tone = 'neutral', className, ...props }: PixelBadgeProps) {
  return <span className={classes('pixel-badge', `pixel-badge--${tone}`, className)} {...props} />;
}

export const PixelInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PixelInput({ className, ...props }, ref) {
  return <input ref={ref} className={classes('pixel-input', className)} {...props} />;
});

export const PixelTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function PixelTextarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={classes('pixel-input', 'pixel-textarea', className)} {...props} />;
});

export const PixelSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function PixelSelect({ className, ...props }, ref) {
  return <select ref={ref} className={classes('pixel-input', 'pixel-select', className)} {...props} />;
});

export interface PixelFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  description?: string;
  error?: string;
  htmlFor?: string;
}

export function PixelField({ label, description, error, htmlFor, children, className, ...props }: PixelFieldProps) {
  const generatedId = useId();
  type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' };
  const isControl = isValidElement<ControlProps>(children) && (children.type === PixelInput || children.type === PixelTextarea || children.type === PixelSelect || children.type === 'input' || children.type === 'textarea' || children.type === 'select');
  const control = isControl ? children as ReactElement<ControlProps> : undefined;
  const controlId = htmlFor ?? control?.props.id ?? generatedId;
  const helpId = `${generatedId}-help`;
  const content = control ? cloneElement(control, {
    id: controlId,
    ...(error ? { 'aria-invalid': true } : {}),
    ...(error || description ? { 'aria-describedby': [control.props['aria-describedby'], helpId].filter(Boolean).join(' ') } : {}),
  }) : children;
  return <div className={classes('pixel-field', className)} {...props}>
    <label className="pixel-field__label" htmlFor={control ? controlId : htmlFor}>{label}</label>
    {content}
    {error ? <p id={helpId} className="pixel-field__error" role="alert">{error}</p> : description && <p id={helpId} className="pixel-description">{description}</p>}
  </div>;
}

export interface PixelEmptyProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  icon?: string;
}

export function PixelEmpty({ title, description, icon = 'frames', children, className, ...props }: PixelEmptyProps) {
  return <div className={classes('pixel-empty', className)} {...props}>
    <div className="pixel-empty__icon"><PixelIcon name={icon} /></div>
    <p className="pixel-title">{title}</p>
    {description && <p className="pixel-description">{description}</p>}
    {children}
  </div>;
}

const iconPaths: Record<string, string> = {
  frames: 'M2 3h12v10H2z M5 3v10 M11 3v10 M2 6h3 M2 10h3 M11 6h3 M11 10h3',
  image: 'M2 2h12v12H2z M2 11l4-4 3 3 2-2 3 3 M10 5h1',
  music: 'M6 12V3l7-1v9 M6 4l7-1 M6 12H3v2h3z M13 11h-3v2h3z',
  audio: 'M2 7h3l4-4v10l-4-4H2z M12 5v6 M14 3v10',
  voice: 'M6 2h4v7H6z M3 7v3l3 2h4l3-2V7 M8 12v3 M5 15h6',
  spark: 'M8 1v3 M8 12v3 M1 8h3 M12 8h3 M5 5h6v6H5z',
  folder: 'M1 4h5V2h4l2 2h3v10H1z M1 6h14',
  timeline: 'M1 4h14 M4 1v14 M1 8h7v3H1z M10 8h5v3h-5z',
  chevron: 'M6 3l5 5-5 5',
  'chevron-right': 'M6 3l5 5-5 5',
  back: 'M9 3L4 8l5 5 M4 8h10',
  check: 'M2 8l4 4 8-8',
  warning: 'M7 2h2l6 12H1z M8 6v4 M8 12h.1',
  close: 'M3 3l10 10 M13 3L3 13',
  reference: 'M5 9L3 11v3h3l3-2 M7 5l2-3h4v4l-3 2 M5 11l6-6',
  grid: 'M2 2h4v4H2z M10 2h4v4h-4z M2 10h4v4H2z M10 10h4v4h-4z',
  file: 'M3 1h7l3 3v11H3z M10 1v4h3 M5 8h6 M5 11h6',
  dots: 'M3 7v2 M8 7v2 M13 7v2',
};

export function PixelIcon({ name, className, label }: { name: string; className?: string; label?: string }) {
  return <svg className={classes('pixel-icon', className)} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" strokeLinejoin="miter" shapeRendering="crispEdges" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    <path d={iconPaths[name] ?? iconPaths['frames']} />
  </svg>;
}

export function PixelProgress({ value, label }: { value: number; label?: string }) {
  const safe = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return <div className="pixel-progress">
    {label && <div className="pixel-progress__label"><span>{label}</span><span>{Math.round(safe * 100)}%</span></div>}
    <div className="pixel-progress__track" role="progressbar" aria-label={label ?? '任务进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(safe * 100)}><div className="pixel-progress__fill" style={{ width: `${safe * 100}%` }} /></div>
  </div>;
}

export interface PixelContextMenuItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface PixelContextMenuProps {
  x: number;
  y: number;
  items: readonly PixelContextMenuItem[];
  onClose: () => void;
}

export function PixelContextMenu({ x, y, items, onClose }: PixelContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const originalFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
  }, [x, y, items]);

  useEffect(() => {
    originalFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    const first = menu?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (first ?? menu)?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current();
    };
    const dismiss = (event: Event) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) closeRef.current(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      if (document.activeElement === document.body || ref.current?.contains(document.activeElement)) originalFocus.current?.focus();
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(<div ref={ref} data-pixel-context-menu="" className="pixel-context-menu" role="menu" aria-label="对象命令" tabIndex={-1} style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!options.length) return;
      const active = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
  }}>
    
    {items.map(item => <button key={item.id} type="button" role="menuitem" className="pixel-context-menu__item" disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>
      <span className="pixel-context-menu__label">{item.label}</span>
      {item.description && <span className="pixel-description">{item.description}</span>}
      <PixelIcon name="chevron" />
    </button>)}
    {items.length === 0 && <p className="pixel-context-menu__empty pixel-description">当前对象没有可用命令</p>}
    
  </div>, document.body);
}

export interface PixelModalHostProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  depth?: number;
}

const focusableSelector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function PixelModalHost({ open, title, description, children, onBack, depth = 1 }: PixelModalHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const backRef = useRef(onBack);
  backRef.current = onBack;

  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute('data-pixel-modal') && !node.hasAttribute('data-pixel-context-menu'));
    const saved = siblings.map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of saved) { element.inert = true; element.setAttribute('aria-hidden', 'true'); }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const focusInside = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-pixel-context-menu]')) return;
      if (!ref.current?.contains(event.target)) ref.current?.focus();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('[data-pixel-context-menu]')) return;
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); backRef.current(); return; }
      if (event.key !== 'Tab') return;
      const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first || !last) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('focusin', focusInside);
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('focusin', focusInside);
      document.removeEventListener('keydown', keys);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of saved) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', ariaHidden);
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useLayoutEffect(() => { if (open) ref.current?.focus(); }, [open, depth, title]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div data-pixel-modal="" className="pixel-modal-backdrop" onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <div ref={ref} className="pixel-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
      <div className="pixel-modal__header">
        <div><h2 id={titleId} className="pixel-title">{title}</h2>{description && <p id={descriptionId} className="pixel-description">{description}</p>}</div>
        <span className="pixel-keycap" aria-label="按 Escape 返回上一层">Esc ↩</span>
      </div>
      <div className="pixel-modal__content">{children}</div>
      
    </div>
  </div>, document.body);
}
