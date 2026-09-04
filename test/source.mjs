// Read the game's constants out of game/race.js rather than restating them here, so these
// tests cannot drift from the source they are meant to guard.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RACE_PATH = fileURLToPath(new URL('../game/race.js', import.meta.url));
export const race = readFileSync(RACE_PATH, 'utf8');

const arrayOf = name => {
  const m = race.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`could not find ${name} in game/race.js`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};

export const GAME_RELAYS = arrayOf('GAME_RELAYS');
export const PROFILE_RELAYS = arrayOf('PROFILE_RELAYS');

export const KINDS = Object.fromEntries(
  [...race.matchAll(/\b(K_[A-Z]+)\s*=\s*(\d+)/g)].map(m => [m[1], Number(m[2])])
);

// Kinds the client actually publishes, by the constant it signs with.
export const published = Object.entries(KINDS).filter(([name]) =>
  new RegExp(`kind:\\s*${name}\\b`).test(race)
);

export const isEphemeral = k => k >= 20000 && k < 30000;
export const isAddressable = k => k >= 30000 && k < 40000;
