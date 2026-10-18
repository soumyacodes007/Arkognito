// Small story pieces built from gr8r's classes: explorer buttons, the "who knows what" panel, busy states.
import { useEffect, useRef, useState } from 'react';
import { I } from './icons.jsx';
import { Panel, cx } from './kit.jsx';

export function Explore({ href, children = 'See it on Arkiv', sm = true }) {
  if (!href) return null;
  return (
    <a className={cx('btn btn-secondary', sm && 'btn-sm')} href={href} target="_blank" rel="noreferrer">
      <I n="arrow-up-right" s={14} />
      {children}
    </a>
  );
}

/** Runs an async action with a busy flag, elapsed seconds and an error message. */
export function useAction(fn) {
  const [state, setState] = useState({ busy: false, err: '', t: 0 });
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  const run = async (...args) => {
    const start = Date.now();
    setState({ busy: true, err: '', t: 0 });
    timer.current = setInterval(() => setState(s => ({ ...s, t: Math.floor((Date.now() - start) / 1000) })), 500);
    try {
      return await fn(...args);
    } catch (e) {
      setState(s => ({ ...s, err: e?.message || String(e) }));
      return undefined;
    } finally {
      clearInterval(timer.current);
      setState(s => ({ ...s, busy: false }));
    }
  };
  return [run, state];
}

export function Busy({ on, t, children }) {
  if (!on) return null;
  return (
    <div className="alert info" role="status">
      <I n="loader" s={15} className="spin" />
      <span className="grow">{children}</span>
      <span className="faint num">{t}s</span>
    </div>
  );
}

export function Problem({ err }) {
  if (!err) return null;
  return (
    <div className="alert danger" role="alert">
      <I n="circle-alert" s={15} />
      <span>{err.split('\n')[0]}</span>
    </div>
  );
}

/**
 * Who knows what, after this chapter. The point of the whole story in one table: the last row is
 * always "that it was you", and nobody has it.
 */
export function WhoKnows({ rows }) {
  return (
    <Panel title="Who knows what" body={false}>
      {rows.map(([who, icon, knows, tone]) => (
        <div key={who} className="lrow static who">
          <span className={cx('who-ic', tone)}>
            <I n={icon} s={14} />
          </span>
          <div className="grow">
            <div className="who-n">{who}</div>
            <div className="who-k">{knows}</div>
          </div>
        </div>
      ))}
    </Panel>
  );
}

/** A labelled list of explorer links for the side column. */
export function OnArkiv({ links }) {
  const list = links.filter(l => l && l[1]);
  if (!list.length) return null;
  return (
    <Panel title="On Arkiv" body={false}>
      {list.map(([label, href, sub]) => (
        <a key={href} className="lrow" href={href} target="_blank" rel="noreferrer">
          <I n="arrow-up-right" s={14} className="faint" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="trunc">{label}</div>
            {sub && <div className="faint trunc" style={{ fontSize: 12 }}>{sub}</div>}
          </div>
        </a>
      ))}
    </Panel>
  );
}
