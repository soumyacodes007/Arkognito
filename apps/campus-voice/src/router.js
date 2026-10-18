// Hash routes: #/ (the story), #/1 … #/7 (chapters), #/committee.
import { useSyncExternalStore } from 'react';

const read = () => location.hash.replace(/^#\/?/, '');
export const go = to => {
  location.hash = `/${to}`;
  document.getElementById('main-content')?.scrollTo?.(0, 0);
  scrollTo(0, 0);
};
export const useRoute = () =>
  useSyncExternalStore(
    f => (addEventListener('hashchange', f), () => removeEventListener('hashchange', f)),
    read,
  );
