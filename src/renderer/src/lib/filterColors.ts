/**
 * The Filters menus' icon colours, chosen from each choice's name and picture (a skull in blood red, a leaf in green,
 * a rocket in cyan…). Every colour is its own: no two icons share one, and none repeats the colours Filters already
 * uses (Reviews' golds, Size's blue-to-red scale, Favorites' red, Recompilations' blue). Light enough to read on the
 * dark menu. H.L.T.B.'s stopwatches stay in the text colour, and the pictures that have colours of their own
 * (platforms, stores, eras, difficulty levels, coloured genre pictures) are shown as they are.
 */

/** Filters > Genre: line icons and black pictures (GenreIcon's ICONS and the `.mask` pictures), by genre id. */
export const GENRE_COLORS: Readonly<Record<string, string>> = {
  action: '#ffa62b', // a lightning bolt
  'action rpg': '#e8714a', // crossed swords
  adventure: '#3fc1a5', // a compass
  'board game': '#c58af9', // dice
  building: '#d4a373', // a hammer
  casual: '#c49a6c', // a coffee cup
  'choices matter': '#7dd3fc', // a forking path
  'choose your own adventure': '#a3e635', // a signpost
  'city builder': '#6ba8f7', // buildings
  classic: '#f2c94c', // an award
  destruction: '#ff8a3d', // a bomb
  detective: '#a78bfa', // a fingerprint
  difficult: '#8fb3d9', // a mountain
  driving: '#f87171', // a car
  exploration: '#34d399', // a map
  'family friendly': '#fde047', // a smile
  fantasy: '#e879f9', // a magic wand
  'fast-paced': '#fb923c', // a gauge
  flight: '#38bdf8', // a plane
  fps: '#ff5c5c', // a crosshair
  'free to play': '#4ade80', // a gift
  funny: '#ffd23f', // laughing
  futuristic: '#22d3ee', // a robot
  'hidden object': '#e3b96b', // a magnifier
  historical: '#c9a66b', // a landmark
  horror: '#e23b3b', // a skull
  logic: '#fde68a', // a light bulb
  management: '#93c5fd', // a clipboard
  'massively multiplayer': '#818cf8', // a crowd
  mystery: '#b48cf2', // a question mark
  'open world': '#2dd4bf', // a globe
  parkour: '#fdba74', // footprints
  physics: '#67e8f9', // an atom
  'pixel graphics': '#f472b6', // a pixel grid
  'point & click': '#fca5a5', // a pointer
  'procedural generation': '#c4b5fd', // shuffle arrows
  'psychological horror': '#f0527a', // a brain
  puzzle: '#a96bff', // a puzzle piece
  racing: '#ff5577', // a chequered flag
  realistic: '#cbd5e1', // a camera
  relaxing: '#86efac', // a leaf
  remake: '#5eead4', // a refresh arrow
  'replay value': '#7c9cff', // repeat arrows
  'resource management': '#f5a524', // a pickaxe
  retro: '#ec4899', // a joystick
  roguelike: '#e8894f', // a dungeon door with arrows
  rpg: '#8b93ff', // a shield
  sandbox: '#e9c46a', // a shovel
  'science fiction': '#06c6e0', // a rocket
  simulation: '#b0bec5', // a cog
  space: '#9d7bff', // an orbit
  sports: '#22c55e', // a ball
  stealth: '#8aa1b8', // a mask
  'story rich': '#d6a2e8', // a book
  strategy: '#f0abfc', // a chess knight
  survival: '#84cc16', // a tent
  tactical: '#ff6b6b', // a target
  'tower defense': '#b4a7d6', // a castle
  'turn-based': '#fcd34d', // an hourglass
  utilities: '#cfd8dc', // a wrench
  'visual novel': '#f9a8d4', // speech bubbles
  // the black pictures
  '2d': '#fb7185',
  anime: '#ff8fab',
  'immersive sim': '#4fd1c5',
  jrpg: '#9fa8ff',
  metroidvania: '#b794f4',
  minimalist: '#e5e7eb',
  platformer: '#f6ad55',
  'puzzle platformer': '#d6bcfa',
  rts: '#68d391',
  shooter: '#fc8181'
}

/** Filters > Online Multiplayer, by choice id. */
export const ONLINE_COLORS: Readonly<Record<string, string>> = {
  pvp: '#ff7849', // crossed swords
  coop: '#48bb78', // a handshake
  esports: '#ecc94b', // a trophy
  mmo: '#4299e1', // a globe
  versus: '#f56565', // a sword
  team: '#9f7aea' // a team
}

/** Filters > Local Multiplayer, by choice id (player bands '2', '3-4', '5+'). */
export const LOCAL_COLORS: Readonly<Record<string, string>> = {
  party: '#ff9ff3', // a party popper
  so: '#ff6f91', // a heart handshake
  'lan-party': '#3bc9db', // a network
  '2': '#63b3ed',
  '3-4': '#7bd389',
  '5+': '#f6e05e',
  'nucleus-coop': '#f4a261' // a group, the Co-Op square
}

/** Filters > Controls, by choice id. */
export const CONTROLS_COLORS: Readonly<Record<string, string>> = {
  vr: '#c39bff',
  controller: '#5fd068',
  keyboard: '#a0aec0',
  touch: '#f687b3',
  lightgun: '#ffa94d'
}

/** Filters > Hidden's closed eye. */
export const HIDDEN_COLOR = '#9aa5ce'

/** The least Delta E (CIE76) between two of CUSTOM_FILTER_COLORS. */
export const MIN_CUSTOM_COLOR_DISTANCE = 15

/**
 * The user's own filters' icons (shared/custom-filters.ts CUSTOM_FILTER_ICONS), by icon id: the Create a filter
 * picker, the options menu and Filters > Custom draw each in its colour. Spread apart so no two look alike (each pair at
 * least MIN_CUSTOM_COLOR_DISTANCE apart, CIE76 Delta E), not only different strings.
 */
export const CUSTOM_FILTER_COLORS: Readonly<Record<string, string>> = {
  star: '#fadf27',
  heart: '#fb6ca0',
  bookmark: '#79a1fc',
  flame: '#fd7933',
  trophy: '#e0af3b',
  crown: '#fbdd67',
  gem: '#73dee9',
  rocket: '#6887ff',
  sword: '#a8d1ee',
  shield: '#7491d0',
  skull: '#eadeb2',
  ghost: '#e7d5ff',
  puzzle: '#a473ee',
  gamepad: '#30d882',
  joystick: '#ed46a5',
  car: '#ec5d4b',
  plane: '#4dacf6',
  music: '#df6df8',
  book: '#d0975f',
  coffee: '#bf9d7d',
  moon: '#b0aff5',
  sun: '#f4a34b',
  leaf: '#73d25d',
  zap: '#dbeb48',
  target: '#eb596e',
  flag: '#ef806f',
  map: '#49d3a1',
  globe: '#4db4cc',
  users: '#8fa6cb',
  baby: '#fdb0d4',
  clock: '#8cc4bc',
  calendar: '#d77343',
  tag: '#7fe0c7',
  sparkles: '#df99ef',
  snowflake: '#bcebd1',
  mountain: '#b39abf',
  dices: '#db78e2',
  brain: '#f691cc',
  bomb: '#fc4734',
  cat: '#edc47d'
}

/** Every colour above, for the test that no two icons share one. */
export function allFilterColors(): string[] {
  return [
    ...Object.values(GENRE_COLORS),
    ...Object.values(ONLINE_COLORS),
    ...Object.values(LOCAL_COLORS),
    ...Object.values(CONTROLS_COLORS),
    HIDDEN_COLOR,
    ...Object.values(CUSTOM_FILTER_COLORS)
  ]
}
