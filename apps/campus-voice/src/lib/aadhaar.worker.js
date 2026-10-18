// The Anon Aadhaar prover, in its own worker so the page stays responsive for the minutes it takes.
// The card's data never leaves this worker: it returns the card's fields (shown on this device only)
// and, when asked, a zero-knowledge proof that reveals nothing but "valid test card, over 18".
import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer;

let core;
const load = async () => (core ??= await import('@anon-aadhaar/core'));

self.onmessage = async ({ data }) => {
  try {
    const c = await load();
    if (data.type === 'read') {
      const bytes = c.decompressByteArray(c.convertBigIntToByteArray(BigInt(data.qr)));
      const id = c.returnFullId(bytes.slice(0, bytes.length - 256));
      self.postMessage({
        fields: {
          name: id.Name,
          dob: id.DOB,
          gender: id.Gender,
          pincode: id.PinCode,
          state: id.State,
          last4: (id.ReferenceId || '').slice(0, 4),
        },
      });
      return;
    }
    if (data.type === 'prove') {
      self.postMessage({ stage: 'reading' });
      const args = await c.generateArgs({
        qrData: data.qr,
        certificateFile: data.certificate,
        nullifierSeed: data.seed,
        fieldsToRevealArray: ['revealAgeAbove18'],
        signal: data.signal,
      });
      // The chunked proving key (282 MB) is downloaded once and cached in this browser's IndexedDB.
      await c.init({ wasmURL: c.artifactUrls.v2.wasm, zkeyURL: c.artifactUrls.v2.chunked, vkeyURL: c.artifactUrls.v2.vk, artifactsOrigin: c.ArtifactsOrigin.chunked });
      const pcd = await c.prove(args, stage => self.postMessage({ stage }));
      self.postMessage({ pcd: JSON.parse(JSON.stringify(pcd)) });
    }
  } catch (e) {
    self.postMessage({ error: e?.message || String(e) });
  }
};
