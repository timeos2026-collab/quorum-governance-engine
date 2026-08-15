# QUORUM — Design Style Guide

Durable design brief for QUORUM, the AI-native decision-governance engine for
crypto & digital assets. `src/client/index.css` holds these decisions as code
(Tailwind v4, CSS-first `@theme`).

## Aesthetic Direction

**Institutional governance terminal.** QUORUM is a system of record for
irreversible capital decisions across trading, private equity, private credit,
investment banking and AUM reporting. The UI must read as an *instrument panel*,
not a consumer dashboard: dense, precise, legible at a glance, with every claim
visibly stamped with its provenance.

Principles:
- **Dark graphite base.** Operators watch this screen across sessions (Cape Town
  hours through Asia liquidity peaks). Low-luminance surfaces, high-contrast text.
- **Colour is semantic, never decorative.** Amber = signal/quorum. Green =
  verified. Orange = caution/inferred. Red = blocked. Blue = model inference.
  A colour appearing anywhere means a verdict was reached.
- **Monospace for facts.** Any value that has a source, timestamp, address or
  numeric verdict renders in mono. Prose renders in the sans face.
- **Restraint over ornament.** No gradients-as-decoration, no glassmorphism.
  1px hairlines, tight radii, generous internal padding, hard structural edges.

## Color Palette (`@theme` tokens)

| Token | Value | Usage |
| --- | --- | --- |
| `--color-ink-900` | `#07090c` | Page background |
| `--color-ink-800` | `#0c1016` | Panel/nav background |
| `--color-ink-700` | `#11161e` | Card surface |
| `--color-ink-600` | `#171d27` | Raised surface / table header |
| `--color-ink-500` | `#1f2733` | Hover surface, scrollbar |
| `--color-line` | `#232c39` | Hairline borders, grid |
| `--color-line-strong` | `#33404f` | Emphasised borders |
| `--color-fg` | `#e6ebf2` | Primary text |
| `--color-fg-muted` | `#93a1b3` | Secondary text |
| `--color-fg-faint` | `#5f6d80` | Labels, metadata |
| `--color-signal-500/400/600` | `#e0a33a` / `#f0b954` / `#b07d22` | Accent — quorum, primary actions |
| `--color-signal-soft` | `#2a2113` | Accent fill background |
| `--color-verified-500` | `#35b98a` | Verified provenance, APPROVED |
| `--color-caution-500` | `#d98b3c` | Warnings, RESTRICTED, under review |
| `--color-blocked-500` | `#d8544f` | BLOCKED, breaches, failures |
| `--color-inferred-500` | `#6f8fd8` | Model inference / social claim tags |

Each verdict colour has a matching `-soft` background token for badge fills.

## Typography

- **Display / headings** — `Space Grotesk` (600/700). Slightly technical
  grotesque; used for `h1`–`h4` and module titles.
- **Body** — `IBM Plex Sans` (400/500/600). Institutional, high x-height, made
  for dense data UI.
- **Mono / data** — `IBM Plex Mono` (400/500). All identifiers, addresses,
  timestamps, percentages, verdicts, and the `label-caps` utility.

Imported from Google Fonts in `index.css`.

## Spacing & Radius

- Radius scale is deliberately tight: `xs 2px`, `sm 3px`, `md 5px`, `lg 8px`,
  `xl 12px`. Panels use `lg`, badges/chips use `sm`.
- Panels: `p-4`/`p-5` internal, `gap-4` between panels, `1px` `--color-line`
  borders. Tables use `px-3 py-2` cells with hairline row dividers.
- Page shell max width `max-w-[1600px]`, content breathes at `px-6`.

## Animation Utilities

Defined as `@theme` `--animate-*` and keyframes in `index.css`:

- `animate-fade-in` — panel/content entrance (0.35s).
- `animate-slide-up` — staggered row/card reveal (0.4s, expressive easing).
- `animate-pulse-signal` — live status dots (2.4s loop).
- `animate-scan` — horizontal sweep for active job/ingestion indicators.

Interactive elements use `transition-colors`/`transition-all` at 150–200ms.

## Custom Utilities

- `quorum-grid` — subtle 44px hairline grid background for hero/empty surfaces.
- `label-caps` — uppercase mono micro-label (11px, 0.14em tracking) used for
  every field label and section eyebrow.
