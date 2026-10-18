// The story's progress, kept in this browser per story run so a reload picks up where it was.
import { useSyncExternalStore } from 'react';

const blank = () => ({ joined: null, reportA: null, retry: null, reportB: null, classmates: [], recovered: null, proof: null, notebook: '' });
let campus = null;
let progress = blank();
const subs = new Set();
const emit = () => subs.forEach(f => f());
const keyFor = run => `campus-voice:${run}`;

export function setCampus(c) {
  campus = c;
  try {
    progress = { ...blank(), ...JSON.parse(localStorage.getItem(keyFor(c.run)) || '{}') };
  } catch {
    progress = blank();
  }
  emit();
}

export function update(patch) {
  progress = { ...progress, ...(typeof patch === 'function' ? patch(progress) : patch) };
  try {
    if (campus) localStorage.setItem(keyFor(campus.run), JSON.stringify(progress));
  } catch {
    /* private mode: progress lives in memory only */
  }
  emit();
}

export function resetProgress() {
  progress = blank();
  emit();
}

const snapshot = () => ({ campus, progress });
let last = snapshot();
export function useStory() {
  return useSyncExternalStore(
    f => (subs.add(f), () => subs.delete(f)),
    () => (last.campus === campus && last.progress === progress ? last : (last = snapshot())),
  );
}
