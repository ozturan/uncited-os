'use client';

import type { CSSProperties } from 'react';

const NAVY = 'var(--brand-underline-blue)';

interface WordmarkProps {
  /** Link target. Defaults to the marketing site root. */
  href?: string;
  /** Font size in px (number) or any CSS length (string). */
  fontSize?: number | string;
  /** Extra styles merged onto the anchor (rarely needed). */
  style?: CSSProperties;
}

/**
 * The "uncited" wordmark logo link — the single source of truth for the brand
 * wordmark in page headers (marketing, landing, trending, dashboard sidebar).
 *
 * Radley font (.brand), navy brand underline, and a navy hover box with white
 * text. Change the look here once and every header updates; no more editing the
 * logo on each page. Hover is self-contained (inline handlers), so it never
 * depends on a page's CSS and can't drift back to the old light blue.
 */
export default function Wordmark({ href = '/', fontSize = 26, style }: WordmarkProps) {
  return (
    <a
      href={href}
      style={{
        color: 'inherit',
        textDecoration: 'underline',
        textDecorationColor: NAVY,
        textUnderlineOffset: '4px',
        padding: '4px',
        borderRadius: '4px',
        transition: 'background-color 120ms ease, color 120ms ease',
        display: 'inline-block',
        fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
        lineHeight: '2rem',
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = NAVY; e.currentTarget.style.color = '#ffffff'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'inherit'; }}
    >
      <span className="brand">uncited-os</span>
    </a>
  );
}
