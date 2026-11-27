import { customFilterIcon, type CustomFilterIcon } from '@shared/custom-filters'
import {
  Baby,
  Bomb,
  Book,
  Bookmark,
  Brain,
  Calendar,
  Car,
  Cat,
  Clock,
  Coffee,
  Crown,
  Dices,
  Flag,
  Flame,
  Gamepad2,
  Gem,
  Ghost,
  Globe,
  Heart,
  Joystick,
  Leaf,
  Map as MapIcon,
  Moon,
  Mountain,
  Music,
  Plane,
  Puzzle,
  Rocket,
  Shield,
  Skull,
  Snowflake,
  Sparkles,
  Star,
  Sun,
  Sword,
  Tag,
  Target,
  Trophy,
  Users,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { ReactElement } from 'react'
import { CUSTOM_FILTER_COLORS } from './filterColors'

/** The lucide icon of each shared/custom-filters.ts CUSTOM_FILTER_ICONS id. */
export const CUSTOM_FILTER_ICON_COMPONENTS: Readonly<Record<CustomFilterIcon, LucideIcon>> = {
  star: Star,
  heart: Heart,
  bookmark: Bookmark,
  flame: Flame,
  trophy: Trophy,
  crown: Crown,
  gem: Gem,
  rocket: Rocket,
  sword: Sword,
  shield: Shield,
  skull: Skull,
  ghost: Ghost,
  puzzle: Puzzle,
  gamepad: Gamepad2,
  joystick: Joystick,
  car: Car,
  plane: Plane,
  music: Music,
  book: Book,
  coffee: Coffee,
  moon: Moon,
  sun: Sun,
  leaf: Leaf,
  zap: Zap,
  target: Target,
  flag: Flag,
  map: MapIcon,
  globe: Globe,
  users: Users,
  baby: Baby,
  clock: Clock,
  calendar: Calendar,
  tag: Tag,
  sparkles: Sparkles,
  snowflake: Snowflake,
  mountain: Mountain,
  dices: Dices,
  brain: Brain,
  bomb: Bomb,
  cat: Cat
}

/** A custom filter's icon, drawn in its own colour (an unknown icon id draws the default icon). */
export function CustomFilterIconView({
  icon,
  className
}: {
  icon: string
  className?: string
}): ReactElement {
  const id = customFilterIcon(icon)
  const Icon = CUSTOM_FILTER_ICON_COMPONENTS[id]
  return (
    <Icon className={className} style={{ color: CUSTOM_FILTER_COLORS[id] }} aria-hidden="true" />
  )
}
