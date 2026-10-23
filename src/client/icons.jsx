// Original artwork: the agent bot and the sidebar glyph.

/** A small round-headed bot with a visor. */
export function BotIcon({ size = 28 }) {
  const eyes = '#63e6be'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <line x1="16" y1="4" x2="16" y2="8.5" stroke="#5f3dc4" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="3.6" r="2.3" fill="#ffd43b" stroke="#5f3dc4" strokeWidth="1.2" />
      <rect x="2.8" y="13.5" width="3.4" height="8" rx="1.7" fill="#5f3dc4" />
      <rect x="25.8" y="13.5" width="3.4" height="8" rx="1.7" fill="#5f3dc4" />
      <rect x="5.5" y="8" width="21" height="19.5" rx="7.5" fill="#7048e8" />
      <rect x="8.5" y="11.5" width="15" height="10" rx="5" fill="#1e1b3a" />
      <circle cx="13" cy="16.5" r="2.1" fill={eyes} />
      <circle cx="19" cy="16.5" r="2.1" fill={eyes} />
      <circle cx="13.7" cy="15.8" r="0.6" fill="#ffffff" />
      <circle cx="19.7" cy="15.8" r="0.6" fill="#ffffff" />
      <path d="M13.6 24.1q2.4 1.5 4.8 0" stroke="#e5dbff" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="9.4" cy="23.6" r="1.25" fill="#f783ac" opacity="0.85" />
      <circle cx="22.6" cy="23.6" r="1.25" fill="#f783ac" opacity="0.85" />
    </svg>
  )
}

export function MindmapIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="7.5" height="6" rx="1.6" />
      <rect x="13.5" y="14" width="7.5" height="6" rx="1.6" />
      <path d="M10.5 7h3.2a2.3 2.3 0 0 1 2.3 2.3V14" />
      <circle cx="18" cy="6.5" r="1.4" />
    </svg>
  )
}

export function LockIcon({ size = 12, open = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.6" />
      <path d={open ? 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
    </svg>
  )
}
