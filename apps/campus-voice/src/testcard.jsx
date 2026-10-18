// A page outside the story: a synthetic Anon Aadhaar test QR to scan in chapter 1.
import { useEffect, useState } from 'react';
import { I } from './ui/icons.jsx';
import { Panel } from './ui/kit.jsx';
import { Busy, Problem, useAction } from './ui/bits.jsx';
import { TestCard } from './ui/aadhaar.jsx';
import { getTestCard } from './lib/campus.js';

export function TestCardPage() {
  const [qr, setQr] = useState('');
  const [make, st] = useAction(async () => setQr((await getTestCard()).qr));
  useEffect(() => {
    make();
  }, []);
  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">For the demo</div>
          <h1>A test Aadhaar QR</h1>
          <p className="lede">Anon Aadhaar’s sample card with a random photo, signed with Anon Aadhaar’s public test key. Each one counts as a new test person. Open it on your phone, then scan it in chapter 1.</p>
        </div>
        <div className="acts">
          <button className="btn btn-secondary" onClick={() => make()} disabled={st.busy}>
            <I n="refresh-cw" s={14} />
            Another one
          </button>
        </div>
      </div>
      <Panel>
        <Busy on={st.busy} t={st.t}>
          Making a synthetic test card…
        </Busy>
        <Problem err={st.err} />
        {qr && !st.busy && <TestCard qr={qr} />}
      </Panel>
    </div>
  );
}
