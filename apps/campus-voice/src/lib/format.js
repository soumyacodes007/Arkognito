// Formatting and explorer links (the subset of the dashboard's format.js this app uses).
export const EXPLORER = 'https://tiramisu.explorer.arkiv.network';
export const addrUrl = a => `${EXPLORER}/address/${a}`;
export const entityUrl = k => `${EXPLORER}/entity/${k}`;
export const txUrl = h => `${EXPLORER}/tx/${h}`;
export const ARKOGNITO = 'https://github.com/soumyacodes007/Arkognito';

export const short = (a, n = 4) => (a && a.length > 2 + n * 2 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a || '');
export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// The dashboard's kit.jsx imports STATE for its rule badges; this app does not use those badges.
export const STATE = { waiting: { name: 'Waiting', icon: 'circle-dashed', c: 'var(--text-4)' } };
