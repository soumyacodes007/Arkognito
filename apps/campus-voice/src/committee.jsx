// The committee room: what the complaints committee can see for each professor, at any time.
import { useEffect, useState } from 'react';
import { I } from './ui/icons.jsx';
import { Empty, Panel, Seg } from './ui/kit.jsx';
import { Problem, useAction } from './ui/bits.jsx';
import { CommitteeCard } from './chapters.jsx';
import { api } from './lib/campus.js';
import { useStory } from './lib/store.js';

export function Committee() {
  const { campus, progress } = useStory();
  const [profId, setProf] = useState('prof-a');
  const [view, setView] = useState(null);
  const [load, st] = useAction(async id => setView(await api(`/committee/${id}`)));
  useEffect(() => {
    setView(null);
    load(profId);
  }, [profId, campus.run]);
  const mine = profId === 'prof-a' ? progress.reportA?.entityKey : progress.reportB?.entityKey;
  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Complaints committee</div>
          <h1>Committee room</h1>
          <p className="lede">
            The committee holds the key that opens reports. It can read every report and count how many different students sent them. It cannot see who any of them are.
          </p>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Seg
          label="Professor"
          value={profId}
          onChange={setProf}
          options={campus.professors.map(p => [p.id, `${p.name} · ${p.course}`])}
        />
      </div>
      <Problem err={st.err} />
      {view ? (
        view.reports.length ? (
          <CommitteeCard view={view} mine={mine} onRefresh={() => load(profId)} busy={st.busy} />
        ) : (
          <Panel>
            <Empty icon="inbox" title="No reports yet" text="Reports appear here once students send them." />
          </Panel>
        )
      ) : (
        <Panel>
          <div className="row faint" style={{ gap: 8 }}>
            <I n="loader" s={15} className="spin" />
            Reading verified reports from Arkiv…
          </div>
        </Panel>
      )}
    </div>
  );
}
