// The Anon Aadhaar pieces of chapter 1: a synthetic test card, and a scanner (camera or picture).
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { I } from './icons.jsx';
import { Seg, cx } from './kit.jsx';
import { decodeQr, imageDataFromFile } from '../lib/qr.js';

/** A synthetic Anon Aadhaar test card: the QR a student would scan. Clearly not a real Aadhaar. */
export function TestCard({ qr }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    // 1200 px: about 9 pixels per module, so the downloaded picture always scans.
    QRCode.toDataURL(qr, { errorCorrectionLevel: 'L', margin: 2, width: 1200, color: { dark: '#111111', light: '#ffffff' } }).then(setSrc);
  }, [qr]);
  return (
    <div className="aadhaar-card">
      <div className="ac-band">
        <I n="triangle-alert" s={13} />
        TEST CARD · not a real Aadhaar
      </div>
      <div className="ac-body">
        {src ? <img src={src} alt="Synthetic Anon Aadhaar test QR code" className="ac-qr" /> : <div className="ac-qr sk" />}
        <div className="ac-side">
          <div className="ac-t">Anon Aadhaar test card</div>
          <p>Signed with Anon Aadhaar’s public test key, with a random photo, so it counts as one new test person. The union refuses any real Aadhaar.</p>
          {src && (
            <a className="btn btn-secondary btn-sm" href={src} download="campus-voice-test-aadhaar.png">
              <I n="arrow-up-right" s={14} />
              Download the QR
            </a>
          )}
          <p className="faint" style={{ fontSize: 12 }}>
            Open the downloaded picture on your phone and hold it up to this camera, or upload it below.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Scans an Aadhaar secure QR with the camera or from a picture. */
export function Scanner({ onScan, disabled }) {
  const [mode, setMode] = useState('camera');
  const [camOn, setCamOn] = useState(false);
  const [err, setErr] = useState('');
  const [reading, setReading] = useState(false);
  const video = useRef(null);
  const canvas = useRef(null);

  useEffect(() => {
    if (mode !== 'camera' || disabled || !camOn) return;
    let stream;
    let timer;
    let stopped = false;
    setErr('');
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(s => {
        if (stopped) return s.getTracks().forEach(t => t.stop());
        stream = s;
        video.current.srcObject = s;
        video.current.play();
        let decoding = false;
        timer = setInterval(async () => {
          const v = video.current;
          if (!v || v.readyState < 2 || decoding) return;
          decoding = true; // one frame at a time
          try {
            const c = canvas.current;
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, 0, 0);
            const text = await decodeQr(ctx.getImageData(0, 0, c.width, c.height), { quick: true });
            if (text && !stopped) onScan(text);
          } finally {
            decoding = false;
          }
        }, 250);
      })
      .catch(e => setErr(e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it, or upload a picture instead.' : 'No camera found. Upload a picture instead.'));
    if (!navigator.mediaDevices) setErr('This browser has no camera access here. Upload a picture instead.');
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [mode, disabled, camOn]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <Seg
        label="How to scan"
        value={mode}
        onChange={setMode}
        options={[
          ['camera', 'Camera'],
          ['upload', 'Upload a picture'],
        ]}
      />
      {mode === 'camera' && !camOn && (
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => setCamOn(true)} disabled={disabled}>
            <I n="smartphone" s={15} />
            Start the camera
          </button>
          <span className="faint" style={{ fontSize: 12.5 }}>
            Hold your test Aadhaar QR up to the camera. The picture never leaves this browser.
          </span>
        </div>
      )}
      {mode === 'camera' && camOn && (
        <div className={cx('scan-view', disabled && 'off')}>
          <video ref={video} muted playsInline />
          <canvas ref={canvas} hidden />
          <span className="scan-frame" aria-hidden="true" />
          <span className="scan-hint">Hold the QR code inside the frame</span>
        </div>
      )}
      {mode === 'upload' && (
        <label className={cx('drop', disabled && 'off')}>
          <I n="inbox" s={18} />
          <span>{reading ? 'Reading the picture…' : 'Choose a picture or screenshot of the QR code'}</span>
          <input
            type="file"
            accept="image/*"
            disabled={disabled}
            onChange={async e => {
              setErr('');
              const f = e.target.files?.[0];
              e.target.value = ''; // the same file can be chosen again
              if (!f) return;
              setReading(true);
              try {
                const text = await decodeQr(await imageDataFromFile(f));
                if (text) onScan(text);
                else setErr('No QR code found in that picture. Upload the downloaded QR image, or a photo where the QR fills most of the frame.');
              } catch (x) {
                setErr(x.message);
              } finally {
                setReading(false);
              }
            }}
          />
        </label>
      )}
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        Only Anon Aadhaar test QR codes are accepted; a real Aadhaar is refused.{' '}
        <a href="#/test-card" target="_blank" rel="noreferrer">
          Need a test QR?
        </a>
      </p>
      {err && (
        <div className="alert warn">
          <I n="triangle-alert" s={15} />
          <span>{err}</span>
        </div>
      )}
    </div>
  );
}
