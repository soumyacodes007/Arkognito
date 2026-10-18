// The opening page: the problem, the promise, and the cast.
import { I } from './ui/icons.jsx';
import { Addr, Panel } from './ui/kit.jsx';
import { useStory } from './lib/store.js';
import { go } from './router.js';

export function Intro() {
  const { campus } = useStory();
  const cast = [
    ['You', 'smartphone', 'A student. Your keys and proofs stay on this device.', null],
    ['The student union', 'graduation-cap', 'Checks you’re a student once and adds you to each professor’s list.', campus.union],
    ['The shared relayer', 'server', 'Sends every student’s report to Arkiv, so the sender says nothing about the writer.', campus.relayer],
    ['Four classmates', 'users', 'Other students in the same courses.', null],
    ['The complaints committee', 'scale', 'Holds the only key that opens reports.', null],
  ];
  return (
    <div className="page">
      <div className="hero">
        <span className="pill-ind live" style={{ '--c': 'var(--amber)' }}>
          <i />
          A story with invented people, on Arkiv’s testnet
        </span>
        <h1>Report a professor without being identified, and still be believed.</h1>
        <p>
          A student who reports a professor by name risks their grades and their career. An anonymous report gets dismissed as a grudge, or as fake. Campus Voice is built so neither happens.
        </p>
        <div className="acts">
          <button className="btn btn-primary btn-lg" onClick={() => go('1')}>
            <I n="play" s={15} />
            Start the story
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => go('committee')}>
            <I n="scale" s={15} />
            Committee room
          </button>
        </div>
      </div>

      <div className="grid3" style={{ marginBottom: 24 }}>
        {[
          ['01', 'Only real students', 'Every report carries a proof that it came from a member the student union admitted. Outsiders and bots can’t file one.'],
          ['02', 'Nobody can trace it', 'Reports go through a relayer every student shares, to an owner address used once. Even two reports from the same student look unrelated.'],
          ['03', 'And it still counts', 'One report per student per professor, so five reports really are five people. And you can prove a report was yours, if you ever choose to.'],
        ].map(([n, t, d]) => (
          <div key={n} className="panel howto">
            <span className="n">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </div>

      <div className="grid2">
        <Panel title="The cast" body={false}>
          {cast.map(([who, icon, what, addr]) => (
            <div key={who} className="lrow static who">
              <span className="who-ic">
                <I n={icon} s={14} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="who-n">{who}</div>
                <div className="who-k">{what}</div>
              </div>
              {addr && <Addr a={addr} />}
            </div>
          ))}
        </Panel>
        <Panel title="Already on Arkiv" body={false}>
          {campus.setup.map(s => (
            <a key={s.url} className="lrow" href={s.url} target="_blank" rel="noreferrer">
              <I n="arrow-up-right" s={14} className="faint" />
              <span className="grow trunc">The union created the {s.label.replace('group for ', '')} list</span>
            </a>
          ))}
          <div className="lrow static">
            <I n="users" s={14} className="faint" />
            <span className="grow">
              {campus.members} of {campus.maxMembers} places taken on each list
            </span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
