import {
  Atom,
  Award,
  Bomb,
  BookOpen,
  Bot,
  Building2,
  Camera,
  Car,
  Castle,
  ChessKnight,
  CircleHelp,
  ClipboardList,
  Coffee,
  Cog,
  Compass,
  Crosshair,
  Dices,
  FingerprintPattern,
  Flag,
  Footprints,
  Gauge,
  Gift,
  Globe,
  Grid3x3,
  Hammer,
  Hourglass,
  Joystick,
  Landmark,
  Laugh,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  MessagesSquare,
  Milestone,
  Mountain,
  MousePointerClick,
  Orbit,
  Pickaxe,
  Plane,
  Puzzle,
  RefreshCw,
  Repeat,
  Rocket,
  ScanSearch,
  Shield,
  Shovel,
  Shuffle,
  Skull,
  Smile,
  Split,
  Swords,
  Target,
  Tent,
  Users,
  VenetianMask,
  Volleyball,
  WandSparkles,
  Wrench,
  Zap,
  Brain,
  type LucideIcon
} from 'lucide-react'
import type { ReactElement } from 'react'
import { genrePicture } from '../lib/genrePictures'

/**
 * Roguelike: a tombstone circled by "try again" arrows, drawn like the lucide icons (the picture the user found is a
 * watermarked stock preview, so it is drawn here instead).
 */
const Roguelike: LucideIcon = (({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 16.5V10a3 3 0 0 1 6 0v6.5" />
    <path d="M7.5 16.5h9" />
    <path d="M12 11v3M10.75 12.25h2.5" />
    <path d="M4.2 9.5A8 8 0 0 1 17.5 5.2" />
    <path d="M17.6 2.4v2.9h-2.9" />
    <path d="M19.8 14.5A8 8 0 0 1 6.5 18.8" />
    <path d="M6.4 21.6v-2.9h2.9" />
  </svg>
)) as unknown as LucideIcon

/**
 * Filters > Genre's line icon per choice (lib/steamTags.ts TAG_FILTERS ids). The genres no line icon fits use the
 * user's pictures instead (lib/genrePictures.ts).
 */
export const GENRE_LINE_ICONS: Readonly<Partial<Record<string, LucideIcon>>> = {
  action: Zap,
  'action rpg': Swords,
  adventure: Compass,
  'board game': Dices,
  building: Hammer,
  casual: Coffee,
  'choices matter': Split,
  'choose your own adventure': Milestone,
  'city builder': Building2,
  classic: Award,
  destruction: Bomb,
  detective: FingerprintPattern,
  difficult: Mountain,
  driving: Car,
  exploration: MapIcon,
  'family friendly': Smile,
  fantasy: WandSparkles,
  'fast-paced': Gauge,
  flight: Plane,
  fps: Crosshair,
  'free to play': Gift,
  funny: Laugh,
  futuristic: Bot,
  'hidden object': ScanSearch,
  historical: Landmark,
  horror: Skull,
  logic: Lightbulb,
  management: ClipboardList,
  'massively multiplayer': Users,
  mystery: CircleHelp,
  'open world': Globe,
  parkour: Footprints,
  physics: Atom,
  'pixel graphics': Grid3x3,
  'point & click': MousePointerClick,
  'procedural generation': Shuffle,
  'psychological horror': Brain,
  puzzle: Puzzle,
  racing: Flag,
  realistic: Camera,
  relaxing: Leaf,
  remake: RefreshCw,
  'replay value': Repeat,
  'resource management': Pickaxe,
  retro: Joystick,
  roguelike: Roguelike,
  rpg: Shield,
  sandbox: Shovel,
  'science fiction': Rocket,
  simulation: Cog,
  space: Orbit,
  sports: Volleyball,
  stealth: VenetianMask,
  'story rich': BookOpen,
  strategy: ChessKnight,
  survival: Tent,
  tactical: Target,
  'tower defense': Castle,
  'turn-based': Hourglass,
  utilities: Wrench,
  'visual novel': MessagesSquare
}

/**
 * A Filters > Genre choice's icon before its name, in the box Platform's console pictures use so the rows line up: a
 * line icon or a black picture drawn in the text colour like Favorites' heart, or a coloured picture as it is (an
 * empty box for a genre without any).
 */
export function GenreIcon({ genreId }: { genreId: string }): ReactElement {
  const Icon = GENRE_LINE_ICONS[genreId]
  const picture = Icon ? undefined : genrePicture(genreId)
  return (
    <span className="console-icon" aria-hidden="true">
      {Icon ? (
        <Icon className="console-icon__generic genre-icon" />
      ) : picture?.kind === 'mask' ? (
        <span
          className="console-icon__generic genre-icon genre-icon--mask"
          style={{ maskImage: `url("${picture.url}")` }}
        />
      ) : picture ? (
        <img
          className="genre-icon genre-icon--picture"
          src={picture.url}
          alt=""
          draggable={false}
        />
      ) : null}
    </span>
  )
}
