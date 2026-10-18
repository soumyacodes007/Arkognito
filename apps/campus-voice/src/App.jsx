// The gr8r shell with the story's chapters in the sidebar.
import { useEffect, useState } from 'react';
import { I } from './ui/icons.jsx';
import { Empty, Modal, ToastHost, cx, toast } from './ui/kit.jsx';
import { useAction } from './ui/bits.jsx';
import { CHAPTERS, Chapter1, Chapter2, Chapter3, Chapter4, Chapter5, Chapter6, Chapter7 } from './chapters.jsx';
import { Committee } from './committee.jsx';
import { Intro } from './intro.jsx';
import { TestCardPage } from './testcard.jsx';
import { api, forget, hasDevice, restore } from './lib/campus.js';
import { resetProgress, setCampus, update, useStory } from './lib/store.js';
import { ARKOGNITO } from './lib/format.js';
import { go, useRoute } from './router.js';

const PAGES = { 1: Chapter1, 2: Chapter2, 3: Chapter3, 4: Chapter4, 5: Chapter5, 6: Chapter6, 7: Chapter7 };

function Sidebar({ onReset, mnav, close }) {
  const route = useRoute();
  const { progress } = useStory();
  const item = (to, label, icon, on, extra) => (
    <a key={to} className={cx('sitem', on && 'on')} href={`#/${to}`} aria-current={on ? 'page' : undefined} onClick={close}>
      {icon}
      <span className="trunc">{label}</span>
      {extra}
    </a>
  );
  return (
    <nav className="side" aria-label="Story">
      <div className="side-top">
        <div className="ws">
          <span className="ws-logo trg" style={{ width: 22, height: 22 }}>
            <I n="graduation-cap" s={13} />
          </span>
          <span className="ws-name trunc">Campus Voice</span>
        </div>
      </div>
      <div className="side-scroll">
        {item('', 'The story', <I n="book-open" s={16} />, route === '')}
        <div className="sgroup">
          <div className="sgroup-h">
            <span>Chapters</span>
          </div>
          {CHAPTERS.map(c =>
            item(
              String(c.n),
              c.title,
              c.done(progress) ? <I n="circle-check" s={16} style={{ color: 'var(--green)' }} /> : <span className="chap-n">{c.n}</span>,
              route === String(c.n),
            ),
          )}
        </div>
        <div className="sgroup">
          <div className="sgroup-h">
            <span>Rooms</span>
          </div>
          {item('committee', 'Committee room', <I n="scale" s={16} />, route === 'committee')}
        </div>
      </div>
      <div className="side-bot">
        <button className="sitem" onClick={onReset}>
          <I n="rotate-ccw" s={16} />
          <span>Start a new story</span>
        </button>
        <a className="sitem" href={ARKOGNITO} target="_blank" rel="noreferrer">
          <I n="github" s={16} />
          <span>Arkognito on GitHub</span>
          <span className="ct">
            <I n="arrow-up-right" s={12} />
          </span>
        </a>
      </div>
      {mnav && null}
    </nav>
  );
}

function Topbar({ openNav }) {
  const route = useRoute();
  const c = CHAPTERS.find(x => String(x.n) === route);
  const label = c ? `${c.n}. ${c.title}` : route === 'committee' ? 'Committee room' : route === 'test-card' ? 'Test Aadhaar QR' : 'The story';
  const next = c ? (c.n < CHAPTERS.length ? String(c.n + 1) : 'committee') : route === '' || route === 'test-card' ? '1' : null;
  return (
    <header className="topbar">
      <button className="ibtn mnav-btn" onClick={openNav} aria-label="Open chapters">
        <I n="menu" s={17} />
      </button>
      <nav className="crumbs trunc" aria-label="Breadcrumb">
        <button onClick={() => go('')}>Campus Voice</button>
        <span className="sep">/</span>
        <button className="cur" aria-current="page">
          {label}
        </button>
      </nav>
      <span className="sp" />
      <span className="pill-ind hide-m" style={{ '--c': 'var(--amber)' }} data-tip="Invented students, professors and reports">
        <i />
        Synthetic demo
      </span>
      <span className="pill-ind hide-m" style={{ '--c': 'var(--accent)' }} data-tip="Arkiv testnet, chain 7738577">
        <i />
        Tiramisu
      </span>
      {next && (
        <button className="btn btn-primary btn-sm" onClick={() => go(next)}>
          <span>{route === '' ? 'Start the story' : 'Next'}</span>
          <I n="arrow-right" s={14} />
        </button>
      )}
    </header>
  );
}

export function App() {
  const route = useRoute();
  const { campus } = useStory();
  const [err, setErr] = useState('');
  const [mnav, setMnav] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let stop = false;
    // The story server may still be setting up the campus (or starting): keep asking for a while.
    const tryLoad = async (attempt = 0) => {
      try {
        const c = await api('/campus');
        if (stop) return;
        setCampus(c);
        // A reload keeps the story going: the recovery code is in this demo's notebook.
        const saved = JSON.parse(localStorage.getItem(`campus-voice:${c.run}`) || '{}');
        if (saved.notebook && !saved.forgotten && !hasDevice()) restore(saved.notebook);
      } catch (e) {
        if (stop) return;
        if (attempt < 60 && !/Setup failed/.test(e.message)) setTimeout(() => tryLoad(attempt + 1), 2000);
        else setErr(e.message);
      }
    };
    tryLoad();
    return () => {
      stop = true;
    };
  }, []);

  const [reset, rs] = useAction(async () => {
    const c = await api('/reset', {});
    forget();
    resetProgress();
    setCampus(c);
    update({});
    setConfirm(false);
    go('');
    toast('A new story is ready: new professor groups, four new classmates.');
  });

  if (err)
    return (
      <div className="fullstate">
        <Empty icon="wifi-off" title="The story server isn't running" text={`${err}. Start it with: npm run dev -w campus-voice`} err />
      </div>
    );
  if (!campus)
    return (
      <div className="fullstate">
        <Empty icon="loader" title="Opening Campus Voice…" text="The student union is setting up the campus on Arkiv. This takes about half a minute the first time." />
      </div>
    );

  const Page = PAGES[route] || (route === 'committee' ? Committee : route === 'test-card' ? TestCardPage : Intro);
  return (
    <div className={cx('shell', mnav && 'mnav')}>
      <Sidebar onReset={() => setConfirm(true)} mnav={mnav} close={() => setMnav(false)} />
      {mnav && <div className="side-scrim" onClick={() => setMnav(false)} />}
      <main className="main" id="main">
        <Topbar openNav={() => setMnav(true)} />
        <div className="content" id="main-content" tabIndex={-1}>
          <Page key={`${route}-${campus.run}`} />
        </div>
      </main>
      <ToastHost />
      {confirm && (
        <Modal
          title="Start a new story?"
          sub="This creates new professor groups on Arkiv with four new classmates. Your progress here starts over."
          onClose={() => !rs.busy && setConfirm(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={rs.busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => reset()} disabled={rs.busy}>
                {rs.busy ? <I n="loader" s={14} className="spin" /> : <I n="rotate-ccw" s={14} />}
                {rs.busy ? `Setting up… ${rs.t}s` : 'Start over'}
              </button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Takes about half a minute: the student union creates a group for each professor and enrolls the classmates.
          </p>
          {rs.err && (
            <div className="alert danger" style={{ marginTop: 10 }}>
              <I n="circle-alert" s={15} />
              <span>{rs.err}</span>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
