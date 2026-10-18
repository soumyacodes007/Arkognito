// The student's device. The recovery code, the vaults and the membership proofs live here, in
// Arkognito's worker; only commitments (when joining) and finished reports leave the page.
import { createPublicClient } from '@arkiv-network/sdk';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { WorkerVault, createPrivateClient, encryptShare } from 'arkognito';
import { http } from 'viem';

/** Arkiv reads go through the story server, which adds the access key (it never reaches the page). */
// Arkiv can be slow (20–30 s for some reads); the story server retries gateway errors.
export const reader = createPublicClient({ chain: tiramisu, transport: http(`${location.origin}/rpc`, { retryCount: 0, timeout: 100_000 }) });
const artifacts = { wasm: `${location.origin}/artifacts/semaphore-3.wasm`, zkey: `${location.origin}/artifacts/semaphore-3.zkey` };
const enc = new TextEncoder();

export async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The story server answered ${res.status}`);
  return data;
}

// ---- the device ------------------------------------------------------------------------------------

/** One vault per professor's group (each group is its own app), all derived from one recovery code. */
let device = { code: null, vaults: {} };

async function vaultFor(prof) {
  if (!device.code) throw new Error('This device has no recovery code. Join first, or restore with your code.');
  if (!device.vaults[prof.id]) device.vaults[prof.id] = await WorkerVault.fromRecoveryCode(device.code, prof.group.project);
  return device.vaults[prof.id];
}

export const hasDevice = () => !!device.code;

/** Use a recovery code on this device (a new phone, or a reload). */
export function restore(code) {
  forget();
  if (!/^arkognito1-[0-9a-f]{64}$/i.test(code.trim())) throw new Error('That is not a Campus Voice recovery code.');
  device = { code: code.trim(), vaults: {} };
}

/** Wipe this device: the vaults stop and the code is gone from memory. */
export function forget() {
  for (const v of Object.values(device.vaults)) v.terminate?.();
  device = { code: null, vaults: {} };
}

// ---- joining with Anon Aadhaar ------------------------------------------------------------------------

let aadhaarWorker;
/** Runs one request on the Anon Aadhaar worker; `onStage` hears its progress. */
function aadhaar(message, onStage) {
  aadhaarWorker ??= new Worker(new URL('./aadhaar.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    aadhaarWorker.onmessage = ({ data }) => {
      if (data.stage) return onStage?.(data.stage);
      if (data.error) return reject(new Error(data.error));
      resolve(data);
    };
    aadhaarWorker.onerror = e => reject(new Error(e.message || 'The Anon Aadhaar worker stopped'));
    aadhaarWorker.postMessage(message);
  });
}

/** Reads a scanned card on this device. Its fields are shown here and never sent anywhere. */
export async function readCard(qr) {
  if (!/^\d{500,}$/.test(qr)) throw new Error("That QR isn't an Aadhaar secure QR.");
  return (await aadhaar({ type: 'read', qr })).fields;
}

export const getTestCard = () => api('/test-card');

const sha256 = async text => `0x${[...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
/** Must match the union's joinSignal: the proof is bound to exactly these membership tokens. */
const joinSignal = commitments => sha256(`campus-voice-join:${JSON.stringify(Object.entries(commitments).sort())}`);

/**
 * Joining: a new recovery code is made on this device with one membership commitment per professor.
 * The Anon Aadhaar proof is made here too, bound to those commitments, and only the proof and the
 * commitments go to the union. A commitment cannot be traced back to the reports made with it.
 */
export async function join(campus, qr, onStage) {
  forget();
  const first = campus.professors[0];
  const { recoveryCode, vault } = await WorkerVault.random(first.group.project);
  device = { code: recoveryCode, vaults: { [first.id]: vault } };
  const commitments = {};
  for (const p of campus.professors) commitments[p.id] = await (await vaultFor(p)).membershipCommitment(p.group);
  const certificate = await (await fetch('/api/aadhaar-certificate')).text();
  const { pcd } = await aadhaar({ type: 'prove', qr, certificate, seed: campus.aadhaar.nullifierSeed, signal: await joinSignal(commitments) }, onStage);
  onStage?.('union');
  const res = await api('/join', { commitments, anonAadhaar: pcd });
  return { recoveryCode, proof: pcd.proof, ...res };
}

async function clientFor(campus, prof) {
  return createPrivateClient({
    app: prof.group.project,
    vault: await vaultFor(prof),
    relayers: [`${location.origin}/relay`],
    publicClient: reader,
    delayMs: [0, 0],
    rarityK: 0,
    pollMs: 500,
    semaphore: { group: prof.group, snarkArtifacts: artifacts },
  });
}

/** The report text is encrypted to the complaints committee's key before it leaves the device. */
const seal = (text, committeeKey) => enc.encode(JSON.stringify({ v: 1, to: 'committee', ...encryptShare(enc.encode(text), committeeKey) }));

/** Proves membership on this device and sends the report through the shared relayer. */
export async function report(campus, prof, text) {
  const client = await clientFor(campus, prof);
  const r = await client.createEntity({ payload: seal(text, campus.committeeKey), contentType: 'application/json', attributes: { type: 'report' }, expires: 7 * 86400 });
  return { entityKey: r.entityKey, owner: r.owner, txHash: r.txHash, prof: prof.id };
}

/** What anyone can see about a report on Arkiv. */
export async function lookup(entityKey) {
  const e = await reader.getEntity(entityKey);
  const raw = new TextDecoder().decode(e.payload);
  return { creator: e.creator, owner: e.owner, expiresAt: e.expiresAt, stored: raw.replace(/\s+/g, ' ').slice(0, 220), nullifier: String(e.attributes?.zknullifier?.value ?? e.attributes?.zknullifier ?? '') };
}

/**
 * Anyone can check a report's membership proof, with nothing but Arkiv's public data: the proof is a
 * valid zero-knowledge proof, made against the union's list for this professor at the block it names.
 */
export async function verifyReport(campus, profId, entityKey) {
  const prof = campus.professors.find(p => p.id === profId);
  const e = await reader.getEntity(entityKey);
  const membership = JSON.parse(new TextDecoder().decode(e.payload)).membership;
  if (!membership) return { ok: false, reason: 'This record carries no membership proof.' };
  const { verifyProof } = await import('@semaphore-protocol/proof');
  const { createSemaphoreReader } = await import('arkognito/semaphore');
  const valid = await verifyProof(membership.proof);
  const snapshot = await createSemaphoreReader(reader, prof.group, { trustedRelayers: [campus.relayer] }).getSnapshot(BigInt(membership.rootBlock));
  return {
    ok: valid && snapshot.root === String(membership.proof.merkleTreeRoot),
    valid,
    rootMatches: snapshot.root === String(membership.proof.merkleTreeRoot),
    members: snapshot.members.length,
    block: membership.rootBlock,
    root: String(membership.proof.merkleTreeRoot),
    nullifier: String(membership.proof.nullifier),
    points: membership.proof.points.length,
  };
}

/** On a device that only has the recovery code: find this student's reports. */
export async function findMine(campus) {
  const out = [];
  for (const p of campus.professors) {
    const client = await clientFor(campus, p);
    for (const m of await client.myEntities({ refresh: true })) out.push({ key: m.key, prof: p.id });
  }
  return out;
}

/** Signs a proof that this device's code owns the report; the committee checks it. */
export async function proveMine(campus, profId, entityKey) {
  const prof = campus.professors.find(p => p.id === profId);
  const challenge = `campus-voice-hearing-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const client = await clientFor(campus, prof);
  const proof = await client.proveOwnership(entityKey, { challenge, verifier: 'complaints-committee' });
  const verdict = await api('/verify', { proof, challenge });
  return { proof, verdict };
}
