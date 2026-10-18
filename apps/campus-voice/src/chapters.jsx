// The seven chapters of the story. Every action is real: proofs are made in this browser, reports go
// through the shared relayer to Arkiv's Tiramisu testnet, and each result links to the explorer.
import { useEffect, useState } from 'react';
import { I } from './ui/icons.jsx';
import { Addr, Empty, Field, Panel, copy, cx } from './ui/kit.jsx';
import { Busy, Explore, OnArkiv, Problem, WhoKnows, useAction } from './ui/bits.jsx';
import { api, findMine, hasDevice, join, lookup, proveMine, readCard, report, restore, verifyReport } from './lib/campus.js';
import { Scanner } from './ui/aadhaar.jsx';
import { update, useStory } from './lib/store.js';
import { addrUrl, entityUrl, same, short } from './lib/format.js';
import { go } from './router.js';

export const CHAPTERS = [
  { n: 1, title: 'Join through the student union', icon: 'user-plus', done: p => !!p.joined },
  { n: 2, title: 'Report Professor A', icon: 'send', done: p => !!p.reportA },
  { n: 3, title: 'What anyone can see', icon: 'eye', done: p => !!p.reportA && !!p.seen },
  { n: 4, title: 'Try to report again', icon: 'ban', done: p => !!p.retry },
  { n: 5, title: 'Report Professor B', icon: 'shuffle', done: p => !!p.reportB },
  { n: 6, title: 'Your classmates speak up', icon: 'users', done: p => p.classmates.length >= 4 },
  { n: 7, title: 'Prove it was yours', icon: 'badge-check', done: p => !!p.proof?.verdict?.ok },
];

const prof = (campus, id) => campus.professors.find(p => p.id === id);

function Header({ n, children }) {
  const c = CHAPTERS[n - 1];
  return (
    <div className="ph">
      <div>
        <div className="eyebrow">
          Chapter {n} of {CHAPTERS.length}
        </div>
        <h1>{c.title}</h1>
        <p className="lede">{children}</p>
      </div>
      <div className="acts">
        <button className="btn btn-ghost" onClick={() => go(n > 1 ? String(n - 1) : '')}>
          <I n="arrow-left" s={14} />
          <span className="hide-m">Back</span>
        </button>
        {n < CHAPTERS.length ? (
          <button className="btn btn-primary" onClick={() => go(String(n + 1))}>
            Next
            <I n="arrow-right" s={14} />
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => go('committee')}>
            Committee room
            <I n="arrow-right" s={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown when a chapter needs an earlier one first. */
function Needs({ n, what }) {
  return (
    <Panel>
      <Empty icon="circle-dashed" title={`First, ${what}`} text={`This chapter continues from chapter ${n}.`}>
        <button className="btn btn-primary" onClick={() => go(String(n))}>
          Go to chapter {n}
        </button>
      </Empty>
    </Panel>
  );
}

function Layout({ main, side }) {
  return (
    <div className="ed">
      <div className="stack">{main}</div>
      <div className="ed-side">{side}</div>
    </div>
  );
}

function Step({ n, title, ok, state, children }) {
  return (
    <section className="panel">
      <div className="step-h">
        <span className={cx('step-n', ok && 'ok')}>{ok ? <I n="check" s={12} /> : n}</span>
        <h2>{title}</h2>
        {state && <span className={cx('step-state', ok && 'ok')}>{state}</span>}
      </div>
      <div className="step-b">{children}</div>
    </section>
  );
}

// ---- 1 -----------------------------------------------------------------------------------------------

const STAGES = [
  ['tokens', 'Making your membership tokens on this device'],
  ['reading', 'Checking the card'],
  ['fetching-wasm', 'Loading the prover'],
  ['fetching-zkey', 'Getting the proving key (282 MB, only the first time)'],
  ['proving', 'Making the zero-knowledge proof, on this device'],
  ['union', 'The student union checks the proof and adds you'],
];
const stageIndex = s => (s === 'initializing' ? 2 : s === 'completed' ? 5 : Math.max(0, STAGES.findIndex(x => x[0] === s)));

export function Chapter1() {
  const { campus, progress } = useStory();
  const [scanned, setScanned] = useState(null);
  const [stage, setStage] = useState('tokens');
  const [read, rs] = useAction(async qr => setScanned({ qr, fields: await readCard(qr) }));
  const [prove, ps] = useAction(async () => {
    setStage('tokens');
    const r = await join(campus, scanned.qr, setStage);
    update({
      joined: { txs: r.txs, nullifier: r.nullifier, proof: { ageAbove18: r.proof.ageAbove18, timestamp: r.proof.timestamp, signalHash: r.proof.signalHash } },
      notebook: r.recoveryCode,
      forgotten: false,
      reportA: null,
      retry: null,
      reportB: null,
      proof: null,
      recovered: null,
      seen: false,
    });
  });
  const j = progress.joined;
  const f = scanned?.fields;
  const at = stageIndex(stage);
  return (
    <div className="page">
      <Header n={1}>
        Campus Voice only counts if one person can’t pretend to be five. So the student union admits each person once, using Anon Aadhaar: you prove you hold a valid Aadhaar and are over 18, and the union learns nothing else. Not your name, not your number.
      </Header>
      <Layout
        main={
          <>
            <Step n={1} title="Scan your Aadhaar QR" ok={!!scanned} state={scanned ? 'Card read' : null}>
              {!scanned ? (
                <Scanner onScan={qr => !rs.busy && read(qr)} disabled={rs.busy || !!scanned} />
              ) : (
                <>
                  <div className="alert ok">
                    <I n="circle-check" s={15} />
                    <span>
                      Card read. Everything below <b>stays on this device</b>: none of it is sent to the union, the relayer or Arkiv.
                    </span>
                  </div>
                  <dl className="props">
                    {[
                      ['Name', f.name],
                      ['Date of birth', f.dob],
                      ['Gender', f.gender],
                      ['Pincode', f.pincode],
                      ['State', f.state],
                      ['Aadhaar number', `•••• •••• ${f.last4}`],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt>{k}</dt>
                        <dd className="row" style={{ gap: 8 }}>
                          <span>{v || '—'}</span>
                          <span className="badge gray">
                            <I n="eye-off" s={11} />
                            stays here
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="faint" style={{ fontSize: 12, margin: 0 }}>
                    These are Anon Aadhaar’s fictional sample details, with a random photo.
                  </p>
                </>
              )}
              <Busy on={rs.busy} t={rs.t}>
                Reading the card on this device…
              </Busy>
              <Problem err={rs.err} />
            </Step>

            <Step n={2} title="Prove you’re a real, unique adult, and join" ok={!!j} state={j ? 'Joined' : null}>
              {!j && (
                <>
                  <p className="muted" style={{ margin: 0 }}>
                    Your device makes a zero-knowledge proof from the card. It shows the card is validly signed and that you’re over 18, and it is tied to your new membership tokens so nobody can reuse it. Takes 1–3 minutes.
                  </p>
                  <div>
                    <button className="btn btn-primary" onClick={() => prove()} disabled={!scanned || ps.busy}>
                      <I n="shield-check" s={15} />
                      Prove and join
                    </button>
                  </div>
                </>
              )}
              {ps.busy && (
                <div className="tl">
                  {STAGES.map(([k, label], i) => (
                    <div className="tl-item" key={k}>
                      <span className={cx('tl-dot', i < at ? 'ok' : i === at ? 'on' : 'wait')}>
                        <I n={i < at ? 'check' : i === at ? 'loader' : 'circle-dashed'} s={12} className={i === at ? 'spin' : ''} />
                      </span>
                      <div className="grow">
                        <div className="t" style={i > at ? { color: 'var(--text-3)' } : undefined}>
                          {label}
                        </div>
                        {i === at && <div className="m">{ps.t}s so far</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Problem err={ps.err} />
              {j && (
                <div className="grid2">
                  <div className="panel learned">
                    <div className="lh ok">
                      <I n="circle-check" s={14} />
                      The union learned
                    </div>
                    <ul>
                      <li>The card is a valid Aadhaar (test key)</li>
                      <li>The holder is over 18</li>
                      <li>
                        A one-per-person code: <span className="mono">{j.nullifier ? `${j.nullifier.slice(0, 8)}…${j.nullifier.slice(-4)}` : '—'}</span>
                      </li>
                      <li>That the proof belongs to your membership tokens</li>
                    </ul>
                  </div>
                  <div className="panel learned">
                    <div className="lh">
                      <I n="eye-off" s={14} />
                      It never saw
                    </div>
                    <ul>
                      <li>Your name</li>
                      <li>Your Aadhaar number</li>
                      <li>Your date of birth</li>
                      <li>Your address, pincode or state</li>
                      <li>Your photo</li>
                    </ul>
                  </div>
                </div>
              )}
            </Step>

            {j && progress.notebook && (
              <Step n={3} title="Write down your recovery code" ok>
                <div className="codeblock">
                  <button className="ibtn ibtn-xs cb-copy" onClick={() => copy(progress.notebook, 'Recovery code copied')} aria-label="Copy" data-tip="Copy">
                    <I n="copy" s={13} />
                  </button>
                  <pre className="code-big">{progress.notebook}</pre>
                </div>
                <div className="alert warn">
                  <I n="key-round" s={15} />
                  <span>This code is the only way back to your reports, and the only way to prove one is yours. Nobody can recover it for you, not even the union.</span>
                </div>
              </Step>
            )}
          </>
        }
        side={
          <>
            <WhoKnows
              rows={[
                ['This device', 'smartphone', scanned ? 'Your card and everything on it.' : 'Nothing yet.'],
                ['Student union', 'graduation-cap', j ? 'A real, unique adult joined. Not who.' : 'Nothing yet.'],
                ['Everyone else', 'globe', j ? 'One more member on each professor’s list.' : 'Nothing yet.'],
              ]}
            />
            <OnArkiv links={(j?.txs || []).map(t => [`The union added you to ${t.prof}'s list`, t.url])} />
            {j && (
              <div className="alert info">
                <I n="info" s={15} />
                <span>The card, the proof and the one-per-person code stay with the union. None of them is written to Arkiv: only your membership token is.</span>
              </div>
            )}
          </>
        }
      />
    </div>
  );
}

// ---- 2 and 5: sending a report ------------------------------------------------------------------------

const DRAFTS = {
  'prof-a': 'During office hours, Professor A made demeaning remarks about my accent in front of other students.',
  'prof-b': 'Professor B cancelled the midterm with no notice and told us to stop asking why.',
};

function Composer({ profId, done, onSent, label }) {
  const { campus } = useStory();
  const p = prof(campus, profId);
  const [text, setText] = useState(DRAFTS[profId]);
  const [run, st] = useAction(async () => onSent(await report(campus, p, text)));
  return (
    <Step n={1} title={label} ok={!!done} state={done ? 'Sent' : null}>
      <Field label={`About ${p.name} · ${p.course}`} htmlFor={`r-${profId}`} hint="Demo only: use invented details, never real names.">
        <textarea id={`r-${profId}`} className="textarea" rows={4} value={text} onChange={e => setText(e.target.value)} disabled={st.busy || !!done} />
      </Field>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary" onClick={() => run()} disabled={st.busy || !text.trim() || !!done}>
          <I n={done ? 'check' : 'send'} s={15} />
          {done ? 'Sent' : 'Send anonymously'}
        </button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          Encrypted for the complaints committee before it leaves this device.
        </span>
      </div>
      <Busy on={st.busy} t={st.t}>
        Proving you're a member, on this device, then sending it through the shared relayer to Arkiv…
      </Busy>
      <Problem err={st.err} />
    </Step>
  );
}

export function Chapter2() {
  const { progress } = useStory();
  const r = progress.reportA;
  if (!progress.joined) return <Page n={2} lede={LEDE[2]}><Needs n={1} what="join Campus Voice" /></Page>;
  return (
    <Page n={2} lede={LEDE[2]}>
      <Layout
        main={
          <>
            <Composer profId="prof-a" label="Write your report" done={r} onSent={x => update({ reportA: x, seen: false })} />
            {r && (
              <div className="alert ok">
                <I n="circle-check" s={15} />
                <span className="grow">Your report is on Arkiv. Next: what anyone looking at it can see.</span>
                <Explore href={entityUrl(r.entityKey)} />
              </div>
            )}
          </>
        }
        side={
          <>
            <WhoKnows
              rows={[
                ['Student union', 'graduation-cap', 'That you are a student. Not that you reported.'],
                ['Shared relayer', 'server', r ? 'That some member sent an encrypted report.' : 'Nothing yet.'],
                ['Complaints committee', 'scale', r ? 'What happened, from a verified student.' : 'Nothing yet.'],
                ['Nobody', 'eye-off', 'That it was you.', 'ok'],
              ]}
            />
            <OnArkiv links={r ? [['Your report', entityUrl(r.entityKey)], ['The transaction', `https://tiramisu.explorer.arkiv.network/tx/${r.txHash}`]] : []} />
          </>
        }
      />
    </Page>
  );
}

// ---- 3 -----------------------------------------------------------------------------------------------

export function Chapter3() {
  const { campus, progress } = useStory();
  const r = progress.reportA;
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!r) return;
    lookup(r.entityKey).then(
      x => (setInfo(x), update({ seen: true })),
      e => setErr(e.message),
    );
  }, [r?.entityKey]);
  if (!r) return <Page n={3} lede={LEDE[3]}><Needs n={2} what="send a report" /></Page>;
  return (
    <Page n={3} lede={LEDE[3]}>
      <Layout
        main={
          <>
          <Panel title="Your report, as the whole world sees it" acts={<Explore href={entityUrl(r.entityKey)}>Open on the explorer</Explore>}>
            <Problem err={err} />
            {!info && !err && <Busy on t="">Reading it from Arkiv…</Busy>}
            {info && (
              <dl className="props">
                <dt>Sent by</dt>
                <dd>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Addr a={info.creator} />
                    {same(info.creator, campus.relayer) && <span className="badge gray">Campus Voice relayer</span>}
                  </div>
                  <div className="faint dd-note">The same sender for every student's report, so it says nothing about who wrote this one.</div>
                </dd>
                <dt>Owned by</dt>
                <dd>
                  <Addr a={info.owner} />
                  <div className="faint dd-note">A brand-new address, made for this report only. It has never been used before and won't be used again.</div>
                </dd>
                <dt>Contents</dt>
                <dd>
                  <span className="badge accent">
                    <I n="lock" s={12} />
                    Encrypted
                  </span>
                  <div className="faint dd-note">Only the complaints committee's key can open it. Here is what is actually stored:</div>
                  <pre className="stored">{info.stored}…</pre>
                </dd>
                <dt>One-per-student tag</dt>
                <dd>
                  <span className="mono">{info.nullifier.length > 18 ? `${info.nullifier.slice(0, 10)}…${info.nullifier.slice(-6)}` : info.nullifier}</span>
                  <div className="faint dd-note">Proves this came from a member who hasn't reported Professor A before, without saying which member. Chapter 4 shows what it's for.</div>
                </dd>
                <dt>Points to you?</dt>
                <dd>
                  <span className="badge green">
                    <I n="eye-off" s={12} />
                    No
                  </span>
                </dd>
              </dl>
            )}
          </Panel>
          <ProofCheck profId="prof-a" entityKey={r.entityKey} />
          </>
        }
        side={
          <>
            <WhoKnows
              rows={[
                ['Anyone on the internet', 'globe', 'A verified student reported something about Professor A, at this time.'],
                ['Nobody', 'eye-off', 'That it was you.', 'ok'],
              ]}
            />
            <OnArkiv
              links={[
                ['The report', entityUrl(r.entityKey)],
                ['Its owner: used once, never again', info && addrUrl(info.owner)],
                ['The relayer: it sends for every student', addrUrl(campus.relayer)],
              ]}
            />
          </>
        }
      />
    </Page>
  );
}

/** Anyone can verify a report's zero-knowledge proof from Arkiv's public data. */
function ProofCheck({ profId, entityKey }) {
  const { campus } = useStory();
  const [res, setRes] = useState(null);
  const [run, st] = useAction(async () => setRes(await verifyReport(campus, profId, entityKey)));
  const p = campus.professors.find(x => x.id === profId);
  const rows = res && [
    [res.valid, 'The zero-knowledge proof is valid', `Checked here in your browser: ${res.points} proof values, verified with Semaphore.`],
    [res.rootMatches, `It was made against the union’s list for ${p.name}`, `The list had ${res.members} members at block ${res.block}; the proof shows the sender is one of them.`],
    [true, 'It names no one', 'Nothing in the proof says which of the members made it.'],
    [true, `Its one-per-student tag for ${p.name}`, `${res.nullifier.slice(0, 10)}…${res.nullifier.slice(-6)}: the same student would produce the same tag again.`],
  ];
  return (
    <Panel
      title="The zero-knowledge proof inside it"
      acts={
        <button className="btn btn-sm btn-primary" onClick={() => run()} disabled={st.busy}>
          <I n={st.busy ? 'loader' : 'shield-check'} s={14} className={st.busy ? 'spin' : ''} />
          {res ? 'Verify again' : 'Verify it yourself'}
        </button>
      }
    >
      {!res && !st.busy && (
        <p className="muted" style={{ margin: 0 }}>
          The report carries a proof that a member of {p.name}’s list sent it. You don’t have to trust the relayer or this app: check it from the data on Arkiv.
        </p>
      )}
      <Busy on={st.busy} t={st.t}>
        Reading the proof from Arkiv and verifying it in this browser…
      </Busy>
      <Problem err={st.err} />
      {rows && (
        <div className="tl">
          {rows.map(([ok, t, m]) => (
            <div className="tl-item" key={t}>
              <span className={cx('tl-dot', ok ? 'ok' : 'bad')}>
                <I n={ok ? 'check' : 'x'} s={12} />
              </span>
              <div className="grow">
                <div className="t">{t}</div>
                <div className="m">{m}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---- 4 -----------------------------------------------------------------------------------------------

export function Chapter4() {
  const { campus, progress } = useStory();
  const [run, st] = useAction(async () => {
    try {
      const x = await report(campus, prof(campus, 'prof-a'), 'A second report about Professor A, from the same student.');
      update({ retry: { accepted: true, ...x } });
    } catch (e) {
      update({ retry: { accepted: false, reason: e.message } });
    }
  });
  const t = progress.retry;
  if (!progress.reportA) return <Page n={4} lede={LEDE[4]}><Needs n={2} what="send your report on Professor A" /></Page>;
  return (
    <Page n={4} lede={LEDE[4]}>
      <Layout
        main={
          <>
            <Step n={1} title="Send a second report about Professor A" ok={t && !t.accepted} state={t ? (t.accepted ? 'Accepted' : 'Refused') : null}>
              <p className="muted" style={{ margin: 0 }}>
                If one angry student could report a hundred times, the count would mean nothing. Try it.
              </p>
              <div>
                <button className="btn btn-secondary" onClick={() => run()} disabled={st.busy}>
                  <I n="rotate-ccw" s={15} />
                  Report Professor A again
                </button>
              </div>
              <Busy on={st.busy} t={st.t}>
                Proving membership again and sending…
              </Busy>
              <Problem err={st.err} />
            </Step>
            {t && !t.accepted && (
              <div className="alert danger">
                <I n="ban" s={15} />
                <div>
                  <b>Refused. You've already reported Professor A.</b>
                  <div style={{ marginTop: 4 }}>
                    Your proof carried the same one-per-student tag as your first report, so the relayer refused it before anything was written. Nobody learns who tried: only that the tag was already used.
                  </div>
                  <div className="faint mono" style={{ fontSize: 11.5, marginTop: 6 }}>
                    {t.reason.replace(/^.*relayer refused: /, 'relayer: ').slice(0, 120)}
                  </div>
                </div>
              </div>
            )}
            {t?.accepted && (
              <div className="alert warn">
                <I n="triangle-alert" s={15} />
                <span>The second report was accepted, which should not happen. Start a new story and try again.</span>
              </div>
            )}
          </>
        }
        side={
          <WhoKnows
            rows={[
              ['Shared relayer', 'server', 'That this tag was already used for Professor A. Not whose tag it is.'],
              ['Complaints committee', 'scale', 'Still exactly one report from you.'],
              ['Nobody', 'eye-off', 'That it was you who tried.', 'ok'],
            ]}
          />
        }
      />
    </Page>
  );
}

// ---- 5 -----------------------------------------------------------------------------------------------

export function Chapter5() {
  const { progress } = useStory();
  const a = progress.reportA;
  const b = progress.reportB;
  if (!a) return <Page n={5} lede={LEDE[5]}><Needs n={2} what="send your report on Professor A" /></Page>;
  return (
    <Page n={5} lede={LEDE[5]}>
      <Layout
        main={
          <>
            <Composer profId="prof-b" label="Write a report about Professor B" done={b} onSent={x => update({ reportB: x })} />
            {b && (
              <>
                <div className="grid2">
                  {[
                    ['Your report on Professor A', a],
                    ['Your report on Professor B', b],
                  ].map(([t, x]) => (
                    <Panel key={x.entityKey} title={t} acts={<Explore href={entityUrl(x.entityKey)}>Report</Explore>}>
                      <div className="label" style={{ marginBottom: 6 }}>
                        Owned by
                      </div>
                      <Addr a={x.owner} n={6} />
                    </Panel>
                  ))}
                </div>
                <div className="alert info">
                  <I n="shuffle" s={15} />
                  <span>
                    <b>Different owners, different tags, the same shared sender.</b> Nothing on Arkiv says these two reports came from the same student, so nobody can build a picture of "the student who keeps complaining".
                  </span>
                </div>
              </>
            )}
          </>
        }
        side={
          <>
            <WhoKnows
              rows={[
                ['Complaints committee', 'scale', b ? 'One verified report about each professor.' : 'One verified report about Professor A.'],
                ['Anyone on the internet', 'globe', 'Two unrelated reports.'],
                ['Nobody', 'eye-off', 'That both came from you.', 'ok'],
              ]}
            />
            <OnArkiv links={[['Report on Professor A', entityUrl(a.entityKey), `owner ${short(a.owner)}`], b && ['Report on Professor B', entityUrl(b.entityKey), `owner ${short(b.owner)}`]]} />
          </>
        }
      />
    </Page>
  );
}

// ---- 6 -----------------------------------------------------------------------------------------------

export function Chapter6() {
  const { progress } = useStory();
  const [view, setView] = useState(null);
  const [run, st] = useAction(async () => {
    for (let i = progress.classmates.length; i < 4; i++) {
      const x = await api(`/classmate/${i}`, {});
      update(p => ({ classmates: [...p.classmates, x] }));
    }
    setView(await api('/committee/prof-a'));
  });
  const [load, lst] = useAction(async () => setView(await api('/committee/prof-a')));
  useEffect(() => {
    if (progress.classmates.length >= 4 && !view) load();
  }, []);
  const done = progress.classmates.length;
  if (!progress.reportA) return <Page n={6} lede={LEDE[6]}><Needs n={2} what="send your report on Professor A" /></Page>;
  return (
    <Page n={6} lede={LEDE[6]}>
      <Layout
        main={
          <>
            <Step n={1} title="Four classmates report Professor A" ok={done >= 4} state={done >= 4 ? 'All four sent' : done ? `${done} of 4 sent` : null}>
              <p className="muted" style={{ margin: 0 }}>
                Each classmate is a separate member with their own device and recovery code, sending through the same relayer you did. To keep the story quick, they were admitted when it was set up, without making their own Anon Aadhaar proofs; you joined the full way.
              </p>
              <div className="tl">
                {[0, 1, 2, 3].map(i => {
                  const x = progress.classmates[i];
                  const working = st.busy && i === done;
                  return (
                    <div className="tl-item" key={i}>
                      <span className={cx('tl-dot', x ? 'ok' : working ? 'on' : 'wait')}>
                        <I n={x ? 'check' : working ? 'loader' : 'circle-dashed'} s={12} className={working ? 'spin' : ''} />
                      </span>
                      <div className="grow">
                        <div className="t">Classmate {i + 1}</div>
                        <div className="m">
                          {x ? (
                            <>
                              <span>reported Professor A</span>
                              {x.url ? (
                                <a href={x.url} target="_blank" rel="noreferrer">
                                  see it on Arkiv ↗
                                </a>
                              ) : (
                                <span>it’s on Arkiv; see the committee view</span>
                              )}
                            </>
                          ) : working ? (
                            <span>proving membership and sending…</span>
                          ) : (
                            <span>waiting</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {done < 4 && (
                <div>
                  <button className="btn btn-primary" onClick={() => run()} disabled={st.busy}>
                    <I n="users" s={15} />
                    {done ? 'Continue' : 'Let them report'}
                  </button>
                </div>
              )}
              <Problem err={st.err} />
            </Step>
            {view && <CommitteeCard view={view} mine={progress.reportA?.entityKey} onRefresh={load} busy={lst.busy} />}
            <Problem err={lst.err} />
          </>
        }
        side={
          <WhoKnows
            rows={[
              ['Complaints committee', 'scale', view ? `${view.distinctStudents} different verified students reported Professor A.` : 'Waiting for reports.'],
              ['Professor A', 'circle-help', 'That several students reported. Not which.'],
              ['Nobody', 'eye-off', 'Who any of them are.', 'ok'],
            ]}
          />
        }
      />
    </Page>
  );
}

export function CommitteeCard({ view, mine, onRefresh, busy }) {
  return (
    <Panel
      title="What the complaints committee sees"
      body={false}
      acts={
        onRefresh && (
          <button className="ibtn ibtn-sm" onClick={onRefresh} disabled={busy} aria-label="Refresh" data-tip="Read again from Arkiv">
            <I n="refresh-cw" s={14} className={busy ? 'spin' : ''} />
          </button>
        )
      }
    >
      <div className="panel-b">
        <div className="bigstat">
          <div>
            <div className="v num">{view.reports.length}</div>
            <div className="k">reports</div>
          </div>
          <div>
            <div className="v num">{view.distinctStudents}</div>
            <div className="k">different students</div>
          </div>
          <div className="grow faint" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Every report carries a valid membership proof, and every one has a different one-per-student tag. So these are {view.distinctStudents} different real students. Who they are is not recorded anywhere.
          </div>
        </div>
      </div>
      {view.reports.map(r => (
        <div className="lrow static rep" key={r.key}>
          <I n="lock" s={14} className="faint" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="rep-t">{r.text || 'Could not be decrypted'}</div>
            <div className="faint" style={{ fontSize: 12 }}>
              owner {short(r.owner)} · sent by the relayer
              {same(r.key, mine) && <span className="badge accent" style={{ marginLeft: 8 }}>Yours</span>}
            </div>
          </div>
          <a className="ibtn ibtn-sm" href={r.url} target="_blank" rel="noreferrer" aria-label="Open on the explorer" data-tip="Open on the explorer">
            <I n="arrow-up-right" s={14} />
          </a>
        </div>
      ))}
    </Panel>
  );
}

// ---- 7 -----------------------------------------------------------------------------------------------

export function Chapter7() {
  const { campus, progress } = useStory();
  const [lost, setLost] = useState(!!progress.forgotten || !hasDevice());
  const [code, setCode] = useState('');
  const [restoreRun, rs] = useAction(async () => {
    restore(code);
    const found = await findMine(campus);
    update({ forgotten: false, recovered: found });
  });
  const [proveRun, ps] = useAction(async () => {
    const { verdict } = await proveMine(campus, 'prof-a', progress.reportA.entityKey);
    update({ proof: { key: progress.reportA.entityKey, prof: 'prof-a', verdict } });
  });
  if (!progress.reportA) return <Page n={7} lede={LEDE[7]}><Needs n={2} what="send your report on Professor A" /></Page>;
  const verified = progress.proof?.verdict?.ok;
  const found = progress.recovered;
  return (
    <Page n={7} lede={LEDE[7]}>
      <Layout
        main={
          <>
            <Step n={1} title="Show the committee your Professor A report is yours" ok={verified} state={progress.proof ? (verified ? 'Verified' : 'Not verified') : null}>
              <div className="lrow static" style={{ padding: '8px 0', borderTop: 0 }}>
                <I n="lock" s={15} className="faint" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>Your report on Professor A</div>
                  <div className="faint mono" style={{ fontSize: 12 }}>
                    owner {short(progress.reportA.owner, 6)}
                  </div>
                </div>
                <Explore href={entityUrl(progress.reportA.entityKey)} />
              </div>
              <p className="muted" style={{ margin: 0 }}>
                The committee sends a one-time challenge. Your recovery code holds the key that owns this report, so it can sign the challenge, and nothing else about you is shown.
              </p>
              <div>
                <button className="btn btn-primary" onClick={() => proveRun()} disabled={ps.busy || !hasDevice()}>
                  <I n="badge-check" s={15} />
                  Prove it’s mine
                </button>
              </div>
              <Busy on={ps.busy} t={ps.t}>
                Signing the committee’s challenge with your report’s key…
              </Busy>
              <Problem err={ps.err} />
              {verified && (
                <div className="alert ok">
                  <I n="badge-check" s={15} />
                  <span>
                    <b>The committee verified it.</b> The report filed months ago was yours. Until now nothing linked it to you{progress.reportB ? ', and your report on Professor B is still unlinked' : ''}.
                  </span>
                </div>
              )}
              {progress.proof && !verified && <Problem err={`Not verified: ${progress.proof.verdict.reason}`} />}
            </Step>

            <section className="panel">
              <button className="lost-h" onClick={() => setLost(v => !v)} aria-expanded={lost}>
                <I n="smartphone" s={15} className="faint" />
                <span className="grow">Lost your phone? Restore with your recovery code</span>
                <I n="chevron-down" s={15} className={cx('faint', 'chev', lost && 'open')} />
              </button>
              {lost && (
                <div className="step-b">
                  <p className="muted" style={{ margin: 0 }}>
                    Nothing about your reports was stored with your name, so the code you wrote down is all a new phone needs.
                  </p>
                  <Field
                    label="Your recovery code"
                    htmlFor="code"
                    right={
                      progress.notebook && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setCode(progress.notebook)}>
                          <I n="key-round" s={13} />
                          Use the code I wrote down
                        </button>
                      )
                    }
                  >
                    <input id="code" className="input mono" placeholder="arkognito1-…" value={code} onChange={e => setCode(e.target.value)} disabled={rs.busy} />
                  </Field>
                  <div>
                    <button className="btn btn-secondary" onClick={() => restoreRun()} disabled={rs.busy || !code.trim()}>
                      <I n="rotate-ccw" s={15} />
                      Restore my reports
                    </button>
                  </div>
                  <Busy on={rs.busy} t={rs.t}>
                    Rebuilding your keys from the code, then finding your reports on Arkiv…
                  </Busy>
                  <Problem err={rs.err} />
                  {found && (
                    <div className="alert ok">
                      <I n="circle-check" s={15} />
                      <span>
                        Restored. Found {found.length} report{found.length === 1 ? '' : 's'} of yours: {found.map(f => prof(campus, f.prof)?.name).join(' and ')}.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        }
        side={
          <WhoKnows
            rows={[
              ['Complaints committee', 'scale', verified ? 'That the Professor A report is yours, because you showed it.' : 'Five reports from five students. Not who.'],
              ['Everyone else', 'globe', 'Nothing new.', 'ok'],
            ]}
          />
        }
      />
    </Page>
  );
}

// ---- shared --------------------------------------------------------------------------------------------

const LEDE = {
  2: 'Something has been happening in Professor A’s office hours, and you want the complaints committee to know. Your report is proved to come from a real student, encrypted for the committee, and sent through a relayer every student shares.',
  3: 'Arkiv is public: anyone can look up your report. Here is everything they would see.',
  4: 'A complaint system only works if each person counts once. What happens if you report Professor A a second time?',
  5: 'A different course, a different problem. You report Professor B as well.',
  6: 'One report is easy to dismiss as a grudge. Four classmates report Professor A too, and the committee looks at what it has.',
  7: 'Months later there is a hearing about Professor A. You decide to come forward: you show the committee that the first report was yours, and only that one.',
};

function Page({ n, lede, children }) {
  return (
    <div className="page">
      <Header n={n}>{lede}</Header>
      {children}
    </div>
  );
}
