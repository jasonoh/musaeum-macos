interface IconProps {
  className?: string
}

function base(className?: string) {
  return {
    className: className ?? 'h-4 w-4',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    viewBox: '0 0 24 24'
  }
}

export const GridIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
  </svg>
)

export const ListIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="5" cy="6" r="0.8" fill="currentColor" />
    <circle cx="5" cy="12" r="0.8" fill="currentColor" />
    <circle cx="5" cy="18" r="0.8" fill="currentColor" />
  </svg>
)

export const SearchIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="11" cy="11" r="7" />
    <line x1="16.5" y1="16.5" x2="21" y2="21" />
  </svg>
)

/**
 * A field the user has set, which a metadata fetch will not touch. A padlock
 * rather than a tick or a dot: the state is "held", and the click beside it
 * hands it back rather than clearing the value.
 */
export const LockIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </svg>
)

/** The ask panel: a speech bubble, so it reads as a conversation rather than a search. */
export const AskIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M20 15.5a2 2 0 0 1-2 2H8.6L4.5 21V5.5a2 2 0 0 1 2-2h11.5a2 2 0 0 1 2 2z" />
    <line x1="8" y1="8.5" x2="16" y2="8.5" />
    <line x1="8" y1="12.5" x2="13" y2="12.5" />
  </svg>
)

export const BookIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </svg>
)

/** Open book — "read this here", as against BookIcon's closed spine. */
export const ReaderIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M12 7.5C10.6 6.2 8.7 5.5 6.5 5.5H3v12h3.5c2.2 0 4.1.7 5.5 2 1.4-1.3 3.3-2 5.5-2H21v-12h-3.5c-2.2 0-4.1.7-5.5 2z" />
    <line x1="12" y1="7.5" x2="12" y2="19.5" />
  </svg>
)

export const StarIcon = ({ className, filled }: IconProps & { filled?: boolean }) => (
  <svg {...base(className)} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3z" />
  </svg>
)

export const ChevronIcon = ({ className, open }: IconProps & { open?: boolean }) => (
  <svg {...base(className)} style={{ transform: open ? 'rotate(90deg)' : undefined }}>
    <path d="M9 5l7 7-7 7" />
  </svg>
)

export const CloseIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
)

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
)

export const SpinnerIcon = ({ className }: IconProps) => (
  <svg {...base(className)} className={`animate-spin ${className ?? 'h-4 w-4'}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)

export const DeviceIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <rect x="6" y="2.5" width="12" height="19" rx="2" />
    <line x1="10" y1="18.5" x2="14" y2="18.5" />
  </svg>
)

export const WarningIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M12 3.5L22 20H2L12 3.5z" />
    <line x1="12" y1="10" x2="12" y2="14" />
    <circle cx="12" cy="17" r="0.5" fill="currentColor" />
  </svg>
)

/** Neutral notice — "nothing changed" is an answer, not a warning. */
export const InfoIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16.5" />
    <circle cx="12" cy="7.8" r="0.5" fill="currentColor" />
  </svg>
)

export const SendIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
)

export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </svg>
)

export const TrashIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
  </svg>
)

/** Edit metadata by hand. */
export const PencilIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3z" />
    <path d="M14.5 6.5l3 3" />
  </svg>
)

export const FolderIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5z" />
  </svg>
)

/** Open elsewhere — used for handing a file to the system default app. */
export const OpenExternalIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8.5 8.5" />
    <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </svg>
)

/** Column-header sort indicator: points up for ascending, down for descending. */
export const SortArrowIcon = ({ className, up }: IconProps & { up?: boolean }) => (
  <svg {...base(className)} style={{ transform: up ? 'rotate(180deg)' : undefined }}>
    <path d="M12 5v14M12 19l-5-5M12 19l5-5" />
  </svg>
)

export const GearIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47 1z" />
  </svg>
)

/** Reveal/hide a secret value. */
export const EyeIcon = ({ className, off }: IconProps & { off?: boolean }) => (
  <svg {...base(className)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <line x1="4" y1="20" x2="20" y2="4" />}
  </svg>
)

export const SortIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M7 4v13M7 17l-3-3M7 17l3-3" />
    <path d="M17 20V7M17 7l-3 3M17 7l3 3" />
  </svg>
)

/** Add. The on-ramp control's own glyph — a plus, not a folder or a down-arrow. */
export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)
