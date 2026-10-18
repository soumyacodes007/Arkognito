// gr8r's components as React: the markup and class names are gr8r's own, so its CSS applies as is.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { I } from './icons.jsx';
import { STATE, addrUrl, short } from '../lib/format.js';

/** Re-renders every `ms`, for countdowns and "2m ago". */
export function useNow(ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN(n => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return Date.now();
}

export const cx = (...c) => c.filter(Boolean).join(' ');

// ---- toasts ---------------------------------------------------------------------------------------

let toasts = [];
const tsubs = new Set();
const emit = () => tsubs.forEach(f => f());
export function toast(msg, opt = {}) {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts, { id, msg, ...opt }];
  emit();
  setTimeout(() => dismiss(id), opt.ms || 4600);
}
function dismiss(id) {
  toasts = toasts.map(t => (t.id === id ? { ...t, out: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    emit();
  }, 160);
}
export function ToastHost() {
  const list = useSyncExternalStore(
    f => (tsubs.add(f), () => tsubs.delete(f)),
    () => toasts,
  );
  const host = document.getElementById('toasts');
  if (!host) return null;
  return createPortal(
    list.map(t => (
      <div key={t.id} className={cx('toast', t.out && 'out')} role="status">
        <I n={t.kind === 'err' ? 'circle-alert' : t.kind === 'info' ? 'info' : 'circle-check'} s={15} className={t.kind === 'err' ? 'bad' : t.kind === 'info' ? '' : 'ok'} />
        <span className="grow">{t.msg}</span>
        {t.action && (
          <button
            className="ta"
            onClick={() => {
              t.onAction?.();
              dismiss(t.id);
            }}
          >
            {t.action}
          </button>
        )}
        <button className="ibtn ibtn-xs" aria-label="Dismiss" style={{ color: 'inherit', opacity: 0.6 }} onClick={() => dismiss(t.id)}>
          <I n="x" s={13} />
        </button>
      </div>
    )),
    host,
  );
}

// ---- modal ----------------------------------------------------------------------------------------

export function Modal({ title, sub, onClose, size = '', children, footer, labelId = 'modal-title' }) {
  useEffect(() => {
    const k = e => e.key === 'Escape' && onClose?.();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <>
      <div className="scrim enter" onClick={onClose} />
      <div className="modal-wrap" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
        <div className={cx('modal enter', size)} role="dialog" aria-modal="true" aria-labelledby={labelId}>
          <div className="modal-h">
            <div>
              <h2 id={labelId}>{title}</h2>
              {sub && (
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {sub}
                </div>
              )}
            </div>
            <button className="ibtn ibtn-sm" onClick={onClose} aria-label="Close">
              <I n="x" s={16} />
            </button>
          </div>
          <div className="modal-b">{children}</div>
          {footer && <div className="modal-f">{footer}</div>}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---- floating menu ----------------------------------------------------------------------------------

/** A gr8r .pop menu anchored to its trigger. `children` gets `close`. */
export function Menu({ trigger, children, width = 220, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const close = () => setOpen(false);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = pop.current?.offsetHeight || 0;
    let x = align === 'right' ? r.right - width : r.left;
    x = Math.max(8, Math.min(x, innerWidth - width - 8));
    const y = r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    setPos({ x, y });
  }, [open, width, align]);
  useEffect(() => {
    if (!open) return;
    const down = e => !pop.current?.contains(e.target) && !btn.current?.contains(e.target) && close();
    const key = e => e.key === 'Escape' && close();
    addEventListener('mousedown', down, true);
    addEventListener('keydown', key);
    addEventListener('resize', close);
    return () => {
      removeEventListener('mousedown', down, true);
      removeEventListener('keydown', key);
      removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <>
      {trigger({ ref: btn, onClick: () => setOpen(o => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open &&
        createPortal(
          <div
            ref={pop}
            className={cx('pop floating enter', className)}
            role="menu"
            style={{ left: pos?.x ?? -999, top: pos?.y ?? -999, width, maxWidth: width }}
            onClick={e => e.target.closest('[data-close]') && close()}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  );
}
export const MenuItem = ({ icon, children, onClick, danger, kbd, href, checked }) => {
  const inner = (
    <>
      {icon && <I n={icon} s={15} />}
      <span className="trunc grow">{children}</span>
      {kbd && (
        <span className="r">
          <kbd>{kbd}</kbd>
        </span>
      )}
      {checked && (
        <span className="ck">
          <I n="check" s={14} />
        </span>
      )}
    </>
  );
  return href ? (
    <a className={cx('mi', danger && 'danger')} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer" data-close role="menuitem">
      {inner}
    </a>
  ) : (
    <button className={cx('mi', danger && 'danger')} onClick={onClick} data-close role="menuitem">
      {inner}
    </button>
  );
};

/** gr8r's styled dropdown, as a controlled component. */
export function Select({ value, onChange, options, style, ariaLabel, id }) {
  const cur = options.find(o => String(o.value) === String(value)) || options[0];
  return (
    <Menu
      width={Math.max(200, style?.width || 0)}
      className="select-menu"
      trigger={p => (
        <button type="button" id={id} className="select select-btn" style={style} aria-label={ariaLabel} {...p}>
          <span className="trunc">{cur?.label}</span>
        </button>
      )}
    >
      {options.map(o => (
        <button type="button" key={o.value} className="mi" role="option" aria-selected={o.value === value} data-close onClick={() => onChange(o.value)} disabled={o.disabled}>
          <span className="trunc grow">{o.label}</span>
          {o.hint && <span className="r faint">{o.hint}</span>}
          {String(o.value) === String(value) && (
            <span className="ck">
              <I n="check" s={14} />
            </span>
          )}
        </button>
      ))}
    </Menu>
  );
}

// ---- small pieces -----------------------------------------------------------------------------------

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map(([k, n, extra]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {n}
          {extra != null && extra !== '' && <span className="faint">{extra}</span>}
        </button>
      ))}
    </div>
  );
}

export function Panel({ title, acts, children, body = true, className = '', style, id }) {
  return (
    <section className={cx('panel', className)} style={style} aria-labelledby={id}>
      {(title || acts) && (
        <div className="panel-h">
          {title && <h2 id={id}>{title}</h2>}
          {acts && <div className="acts">{acts}</div>}
        </div>
      )}
      {body ? <div className="panel-b">{children}</div> : children}
    </section>
  );
}

export function Stat({ icon, k, v, d, tone, onClick, vStyle }) {
  return (
    <button className="stat" onClick={onClick}>
      <span className="k">
        <I n={icon} s={14} />
        {k}
      </span>
      <span className="v" style={vStyle}>
        {v}
      </span>
      <span className={cx('d', tone)}>{d}</span>
    </button>
  );
}

export function Empty({ icon, title, text, children, sm, err }) {
  return (
    <div className={cx('empty-state', sm && 'sm', err && 'err')}>
      <div className="glyph">
        <I n={icon} s={20} />
      </div>
      <h2 className="es-h">{title}</h2>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export function StateIcon({ state, s = 15 }) {
  const st = STATE[state] || STATE.waiting;
  return <I n={st.icon} s={s} style={{ color: st.c, flexShrink: 0 }} className={state === 'firing' ? 'spin' : ''} />;
}
export function StateBadge({ state }) {
  const st = STATE[state] || STATE.waiting;
  return (
    <span className="pstatus" style={{ '--c': st.c }}>
      <i />
      {st.name}
    </span>
  );
}

export function copy(text, what = 'Copied') {
  navigator.clipboard?.writeText(text).then(
    () => toast(`${what} to the clipboard`),
    () => toast('Copying is blocked in this browser', { kind: 'err' }),
  );
}

/** An address or key in mono, with copy and an explorer link. */
export function Addr({ a, n = 4, link = true, you, title }) {
  if (!a) return <span className="faint">—</span>;
  return (
    <span className="addr" title={title || a}>
      <span className="mono">{short(a, n)}</span>
      {you && <span className="badge accent">You</span>}
      <button className="ibtn ibtn-xs" onClick={e => (e.stopPropagation(), copy(a, 'Address copied'))} aria-label="Copy" data-tip="Copy">
        <I n="copy" s={12} />
      </button>
      {link && a.length === 42 && (
        <a className="ibtn ibtn-xs" href={addrUrl(a)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} aria-label="Open in explorer" data-tip="Open in explorer">
          <I n="arrow-up-right" s={12} />
        </a>
      )}
    </span>
  );
}

/** A wallet's colour blob, standing in for an avatar. */
export function Blob({ a, size = 22 }) {
  const h = a ? parseInt(a.slice(2, 8), 16) % 360 : 0;
  const h2 = (h + 60) % 360;
  return <span className="blob" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 62% 58%), hsl(${h2} 58% 46%))` }} aria-hidden="true" />;
}

export const Kbd = ({ children }) => <kbd>{children}</kbd>;

export function Field({ label, htmlFor, hint, err, children, right }) {
  return (
    <div className="field">
      {label && (
        <div className="row" style={{ gap: 6 }}>
          <label className="label" htmlFor={htmlFor}>
            {label}
          </label>
          {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
        </div>
      )}
      {children}
      {err ? (
        <span className="err">
          <I n="circle-alert" s={12} />
          {err}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Code({ children, onCopy = true }) {
  return (
    <div className="codeblock">
      {onCopy && (
        <button className="ibtn ibtn-xs cb-copy" onClick={() => copy(children, 'Copied')} aria-label="Copy" data-tip="Copy">
          <I n="copy" s={13} />
        </button>
      )}
      <pre>{children}</pre>
    </div>
  );
}
