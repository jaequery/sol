/**
 * The app's icon set: one small stroke-based family so every control speaks the same
 * language. Before this the toolbar mixed emoji (🗑 🔊 🔇), dingbats (✂ ✦ ⇥) and text
 * glyphs (▶ ❚❚ ⏮ ⏭), which render at different weights and baselines on every platform.
 *
 * Every icon is decorative: the control it sits in carries the accessible name, so the
 * SVG is `aria-hidden` and `focusable="false"` without exception. A label next to an
 * icon stays a label — an icon never replaces one.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'plus'
  | 'import'
  | 'sparkle'
  | 'scissors'
  | 'trash'
  | 'music'
  | 'magnet'
  | 'play'
  | 'pause'
  | 'skip-back'
  | 'skip-forward'
  | 'volume'
  | 'volume-off'
  | 'x'
  | 'image'
  | 'film'
  | 'check'
  | 'alert'
  | 'chevron-down'
  | 'chevron-right'
  | 'refresh'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'spinner'
  | 'minus'
  | 'folder'
  | 'diamond';

/** Lucide-style 24-unit paths; `fill` marks the few solid glyphs (transport). */
const PATHS: Record<IconName, { d: string[]; fill?: boolean }> = {
  plus: { d: ['M12 5v14', 'M5 12h14'] },
  import: { d: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'] },
  sparkle: {
    d: [
      'M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z',
      'M20 3v4',
      'M22 5h-4',
    ],
  },
  scissors: {
    d: [
      'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M20 4 8.12 15.88',
      'M14.47 14.48 20 20',
      'M8.12 8.12 12 12',
    ],
  },
  trash: {
    d: [
      'M3 6h18',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
      'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      'M10 11v6',
      'M14 11v6',
    ],
  },
  music: { d: ['M9 18V5l12-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'] },
  magnet: {
    d: [
      'M6 15l-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15',
      'M5 8l4 4',
      'M12 15l4 4',
    ],
  },
  play: { d: ['M7 4l13 8-13 8z'], fill: true },
  pause: { d: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'], fill: true },
  'skip-back': { d: ['M19 20 9 12l10-8z', 'M5 19V5'], fill: true },
  'skip-forward': { d: ['M5 4l10 8-10 8z', 'M19 5v14'], fill: true },
  volume: {
    d: ['M11 5 6 9H2v6h4l5 4z', 'M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
  },
  'volume-off': { d: ['M11 5 6 9H2v6h4l5 4z', 'M23 9l-6 6', 'M17 9l6 6'] },
  x: { d: ['M18 6 6 18', 'M6 6l12 12'] },
  image: { d: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M21 15l-5-5L5 21'] },
  film: {
    d: [
      'M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'M7 2v20',
      'M17 2v20',
      'M2 12h20',
      'M2 7h5',
      'M2 17h5',
      'M17 17h5',
      'M17 7h5',
    ],
  },
  check: { d: ['M20 6 9 17l-5-5'] },
  alert: {
    d: [
      'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
      'M12 9v4',
      'M12 17h.01',
    ],
  },
  'chevron-down': { d: ['M6 9l6 6 6-6'] },
  'chevron-right': { d: ['M9 18l6-6-6-6'] },
  refresh: {
    d: [
      'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
      'M3 3v5h5',
      'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
      'M16 16h5v5',
    ],
  },
  'arrow-right': { d: ['M5 12h14', 'M12 5l7 7-7 7'] },
  'arrow-up': { d: ['M12 19V5', 'M5 12l7-7 7 7'] },
  'arrow-down': { d: ['M12 5v14', 'M19 12l-7 7-7-7'] },
  spinner: { d: ['M21 12a9 9 0 1 1-6.22-8.56'] },
  minus: { d: ['M5 12h14'] },
  folder: { d: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z'] },
  diamond: { d: ['M12 3l9 9-9 9-9-9z'], fill: true },
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered size in px. 14 inside inline buttons, 16 on standalone controls. */
  size?: number;
}

export function Icon({ name, size = 14, className, ...rest }: IconProps) {
  const { d, fill } = PATHS[name];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={fill ? 1 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon icon--${name}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
