# VendoOS interface system

This document defines the shared portal and administration interface. Changes must remain usable on low-cost Android phones, work without external fonts or CDNs, and preserve the compact teal VendoOS identity.

## Tokens

| Category | Tokens | Use |
| --- | --- | --- |
| Brand | `--brand`, `--brand-dark`, `--brand-soft` | Primary actions, selected navigation, focus support |
| Semantic | `--success`, `--warning`, `--danger` and soft variants | Status and validation only |
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--line` | Page, panel, inset region and boundary |
| Typography | `--ink`, `--muted`, `--font` | Primary and supporting information |
| Shape | `--radius-sm`, `--radius-md`, `--radius` | Fields, panels and feature containers |
| Elevation | `--shadow-sm`, `--shadow` | Panels and modal overlays |

## Components

### Buttons

- Primary is reserved for the main action in a form or view.
- Secondary is used for reversible or supporting actions.
- Destructive actions use the danger color and must request confirmation.
- All actions must implement focus, disabled and pending states.
- The minimum touch target is 40px; primary customer actions use at least 50px.

### Forms

- Put the minimum required fields before Advanced settings.
- Display backend validation in `#adminNotice`; do not rely only on browser validation bubbles.
- Disable the submit action while its request is pending to prevent duplicates.
- Labels remain visible; placeholders are examples, never the only label.

### Navigation

- The active module uses `aria-current="page"`.
- Desktop uses the fixed left rail. Narrow screens use a horizontally scrollable, snap-aligned rail.
- Hash routes remain linkable and survive reloads.

### Tables

- Headers remain visible while scrolling.
- Status uses both text and color.
- Actions use keyboard-focusable buttons with accessible names.
- Horizontal scrolling is allowed only when preserving operational data is safer than hiding columns.

### Feedback

- Success and errors are announced through the page status region.
- Modal dialogs must support Escape, visible close controls and focus containment.
- Motion respects `prefers-reduced-motion`; contrast improves under `prefers-contrast`.

## Responsive breakpoints

- Above 900px: sidebar and multi-column operational layout.
- 521–900px: horizontal navigation and single-column panels.
- 520px and below: compact typography, single-column forms and full-width controls.

## Implementation checklist

1. Use existing tokens instead of introducing hardcoded colors.
2. Test keyboard navigation and visible focus.
3. Test 360px, 768px and 1440px widths.
4. Test empty, loading, success, error, offline and large-data states.
5. Run `npm.cmd run check` and `npm.cmd test` before deployment.
