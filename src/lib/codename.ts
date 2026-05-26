/**
 * Deterministic `<adjective>-<animal>` codename generator. Given any string
 * seed (session id, etc.) returns the same slug forever. 50 × 50 = 2500
 * distinct codenames — ample for human-scale session lists.
 *
 * Hash is FNV-1a 32-bit: fast, dependency-free, well-distributed for short
 * inputs, and avalanche-mixes so seeds with shared prefixes don't collide.
 */

const ADJECTIVES = [
  "agile",
  "amber",
  "ancient",
  "autumn",
  "azure",
  "bold",
  "brave",
  "bright",
  "bronze",
  "calm",
  "clever",
  "cobalt",
  "cosmic",
  "crimson",
  "crystal",
  "dapper",
  "dewy",
  "eager",
  "electric",
  "ember",
  "frosty",
  "gentle",
  "gilded",
  "glowing",
  "golden",
  "hazel",
  "hidden",
  "honest",
  "ivory",
  "jade",
  "lively",
  "lucky",
  "lunar",
  "misty",
  "mystic",
  "noble",
  "plucky",
  "polar",
  "quartz",
  "quiet",
  "rapid",
  "royal",
  "rustic",
  "sable",
  "scarlet",
  "silent",
  "silver",
  "solar",
  "sunny",
  "swift",
] as const;

const ANIMALS = [
  "badger",
  "bear",
  "beaver",
  "bee",
  "bison",
  "bobcat",
  "butterfly",
  "capybara",
  "cheetah",
  "condor",
  "coyote",
  "crane",
  "deer",
  "dolphin",
  "eagle",
  "falcon",
  "ferret",
  "fox",
  "gecko",
  "giraffe",
  "gorilla",
  "hare",
  "hawk",
  "hedgehog",
  "heron",
  "ibex",
  "jaguar",
  "koala",
  "leopard",
  "lemur",
  "lion",
  "lynx",
  "marmot",
  "mongoose",
  "moose",
  "narwhal",
  "ocelot",
  "otter",
  "owl",
  "panda",
  "panther",
  "penguin",
  "puffin",
  "raccoon",
  "raven",
  "robin",
  "seal",
  "sparrow",
  "tiger",
  "walrus",
] as const;

/** FNV-1a 32-bit hash. Returns an unsigned 32-bit integer. */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pure deterministic codename. Empty/identical seeds → identical output. */
export function codename(seed: string): string {
  const h = fnv1a32(seed);
  // Spread across both lists by deriving each index from a different
  // portion of the hash so two seeds whose hashes share a low bit don't
  // also collide on the adjective.
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length];
  return `${adj}-${animal}`;
}
