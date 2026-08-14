## How to build with NotYet UI

A dense, dark-first system in two halves: **UI** for building interfaces, **Charts**
for encoding data. Teal means a value went up, rust means it went down — in both
themes. Every figure is monospace.

### 1. Wrap everything in `ThemeProvider` — nothing is styled without it

`ThemeProvider` defines the `--ny-*` custom properties, sets `data-theme`, and
scopes the reset and the shared focus ring. Outside it, components render with
transparent backgrounds and browser-default text, because every colour they
reference resolves to nothing.

```jsx
<ThemeProvider theme="dark">   {/* "dark" | "light" */}
  <Container><Panel>…</Panel></Container>
</ThemeProvider>
```

There is no other provider and no required load order. `useTheme()` reads the
current theme inside it.

### 2. Styling idiom: **CSS custom properties, not utility classes**

There is **no utility-class vocabulary** — do not invent `bg-*`, `p-*` or
`text-*` classes; they will not resolve. The `.ny-*` classes in the stylesheet
are component-internal (`.ny-panel`, `.ny-badge`, …) — never apply them
yourself. Style your own layout glue with the layout components below, or with
inline styles reading these tokens:

| Family | Real names |
|---|---|
| Surface | `--ny-bg` `--ny-surface` `--ny-surface-sunken` `--ny-surface-raised` `--ny-surface-hover` `--ny-surface-active` `--ny-surface-selected` `--ny-overlay` |
| Border | `--ny-border` `--ny-border-strong` |
| Text | `--ny-text` `--ny-text-muted` `--ny-text-subtle` `--ny-text-disabled` `--ny-text-inverse` |
| Tones | `--ny-{accent,success,warning,danger,info,neutral}` — six tones, each with the **same eight tokens**: the bare name (solid) plus `-hover` `-active`, `-subtle` `-subtle-hover` (tints), `-border` (hairline on tint), `-text` (ink on tint), and `--ny-text-on-{tone}` (ink on solid, theme-invariant). `accent` and `neutral` are ordinary tones here, not special cases |
| Data (theme-invariant) | `--ny-positive` `--ny-negative` `--ny-neutral` |
| Type size | `--ny-font-size-` `2xs` `xs` `sm` `md` `lg` `xl` `2xl` `3xl` `4xl` — in `rem`, `md` is the body default |
| Type detail | `--ny-line-height-{tight,snug,normal}` `--ny-font-weight-{regular,medium,semibold}` `--ny-tracking-{tight,normal,wide,wider}` |
| Fonts | `--ny-font-sans` `--ny-font-mono` `--ny-font-numeric` |
| Spacing | `--ny-space-{0,px,2,4,8,12,16,20,24,32,40,48,64}` — **each token is named for the pixel value it holds** |
| Spacing roles | `--ny-inset` (16) `--ny-inset-compact` (8) `--ny-stack` (12) `--ny-gutter` (24, 16 below 768px) |
| Radii | `--ny-radius-{none,xs,sm,md,lg,xl,full}` |
| Elevation | `--ny-shadow-{none,sm,md,lg}` |
| Motion | `--ny-ease-{standard,out,in}` `--ny-duration-{fast,base,slow}` |
| Controls | `--ny-control-height-{sm,md,lg}` (28/34/44) `--ny-control-padding-x-{sm,md,lg}` `--ny-icon-size-{sm,md,lg,xl}` |
| Layering | `--ny-z-{base,sticky,dropdown,toast}` |

Prefer the **spacing roles** over raw steps for component chrome — they are what
keeps padding, margin and gutter consistent. The one utility class is `.ny-mono`
(switches to the monospace face).

### 3. Layout: use the primitives, don't hand-roll a grid

```jsx
<Container size="lg">                        {/* sm 720 | md 960 | lg 1280 | xl 1560 | full */}
  <Grid columns={{ base: 1, md: 12 }} gap={16}>
    <GridItem span={{ base: 1, md: 8 }}>…</GridItem>
    <GridItem span={{ base: 1, md: 4 }}>…</GridItem>
  </Grid>
  <Stack direction="row" gap={8} align="center">…</Stack>
</Container>
```

`columns`, `span` and `gap` accept a plain value or a `Responsive` object
(`{ base, sm, md, lg, xl }`). Breakpoints are 480 / 768 / 1024 / 1280.
**Do not write your own media queries** — components adapt to the space they are
in via container queries, and the four breakpoints live in the primitives.

### 4. Rules that are easy to get wrong

- **Components never format numbers.** Pass pre-formatted strings, plus the
  signed raw value that picks the accent colour (`tone`, `changeValue`). Use the
  exported `formatDelta(millions, signed)` / `formatCompact(v)` — they emit
  U+2212 MINUS (`−`), which keeps signed columns optically flush.
- **Charts measure themselves — do not hardcode a `width`.** `SankeyFlow` and
  `RotationRing` lay out in real CSS pixels because their labels are HTML and must
  not scale, so they read their own container. Omit `width` and they fit whatever
  you put them in; pass one only to pin a chart to a fixed size, which will
  overflow a narrower parent.
- **`StatTile` only works inside `MacroStrip`**, which supplies the tile
  background and the hairline rules between tiles.
- **Colour by value, not by hand:** `deltaColor(value)` returns the right teal or
  rust for a signed number. `deltaColors.positive` / `.negative` / `.neutral` are
  the literals.
- **Form controls take `value` or `defaultValue`, both work.** `Tabs`,
  `SegmentedControl` and `Select` are controlled-only: pass `value` + `onChange`.
- **Wrap inputs in `Field`** rather than wiring labels yourself — it generates the
  ids and the `aria-describedby`/`aria-invalid` links.
- **Never set `z-index` on an overlay.** `Dialog`, `Popover`, `Tooltip` and
  `Toast` render in the browser top layer and always paint above everything.
- **Give a data grid a `label`.** `HeatGrid` and `RotationMatrix` render a real
  `role="grid"` with row and column headers, and a grid with no accessible name
  is one a screen-reader user cannot place. `rowHeaderLabel` names the corner
  above the row labels — it defaults sensibly, so set it only when "Row" is
  wrong for your axis.
- **`Sparkline`'s fill follows its baseline.** With `baseline` the fill closes on
  the zero line and reads as signed area; without it the fill closes on the
  bottom of the plot and reads as magnitude under the curve. Pass `baseline`
  whenever the sign is the point — a series that never crosses zero otherwise
  fills to a height nothing on screen explains.
- **An icon-only `Button` sizes its own glyph.** Pass the bare `<svg>` with no
  `width`/`height`: the button sets them from its size, and a hardcoded pair
  either fights it or drifts from the other icon buttons.

### 5. Where the truth lives

Read `styles.css` and the `_ds_bundle.css` it imports for the real token values,
and `components/<group>/<Name>/<Name>.prompt.md` + `<Name>.d.ts` for a
component's exact API before using it.

### 6. Idiomatic example

```jsx
<ThemeProvider theme="dark">
  <Container size="lg">
    <Stack gap={24}>
      <PageHeader kicker="Cross-border equity flows" title="Where the hot money went" />
      <MacroStrip>
        <StatTile label="USD/JPY" value="145.9" change="+0.5%" changeValue={0.5} trend={[1, 3, 2, 5]} />
      </MacroStrip>
      <Grid columns={{ base: 1, md: 12 }} gap={16}>
        <GridItem span={{ base: 1, md: 8 }}>
          <Panel padding="chart" column>
            <PanelHeading title="Region rotation" subtitle="Row sold → column bought, $B" />
            <DataRow leading="←" label="from KR · Semiconductors" value={formatDelta(5300, true)} tone={1} />
          </Panel>
        </GridItem>
        <GridItem span={{ base: 1, md: 4 }}>
          <Panel header={<Heading size="lg">Alerts</Heading>}>
            <Stack gap={8}>
              <Alert tone="warning" title="Position limit">KR desk at 92% of cap.</Alert>
              <Badge tone="success">Settled</Badge>
            </Stack>
          </Panel>
        </GridItem>
      </Grid>
    </Stack>
  </Container>
</ThemeProvider>
```

# NotYetUI (@notyet.im/ui@0.1.1)

This design system is the published @notyet.im/ui React library, bundled as a single
browser global. All 49 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.NotYetUI`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.NotYetUI.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { Alert } = window.NotYetUI;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<Alert />);
```

This DS's storybook wraps every story in decorators from `.storybook/preview`
(bundled for the preview cards as `_vendor/preview-decorators.js`). Components
likely need equivalent context — theme/i18n providers — in your tree too. The
exact chain hasn't been distilled into config, so check the DS's documented
provider setup before composing.

## Tokens

181 CSS custom properties from @notyet.im/ui. Names are
preserved verbatim from upstream. They are declared inside `_ds_bundle.css` (this DS ships one compiled stylesheet rather than separate token files).

- **color** (19): `--ny-surface`, `--ny-surface-sunken`, `--ny-surface-raised`, …
- **spacing** (20): `--ny-space-0`, `--ny-space-px`, `--ny-space-2`, …
- **typography** (26): `--ny-font-sans`, `--ny-font-mono`, `--ny-font-numeric`, …
- **radius** (7): `--ny-radius-none`, `--ny-radius-xs`, `--ny-radius-sm`, …
- **shadow** (5): `--ny-shadow-sm`, `--ny-shadow-md`, `--ny-shadow-lg`, …
- **other** (104): `--ny-ink-0`, `--ny-ink-1`, `--ny-ink-2`, …

## Components

### ui
- `Alert` — A block message about the page, a form, or an operation that just ran.
- `Avatar` — A person or organisation rendered at a glance.
- `Badge` — A small inline chip that labels the state of the thing next to it.
- `Breadcrumb` — The trail back up the hierarchy: a nav wrapping an ordered list.
- `Button` — The system's button, labelled or icon-only.
- `Checkbox` — A binary choice, or one row of a multi-select.
- `Container` — Centred page measure with the system gutter.
- `DataRow` — One line of a ranked list: identity on the left, figure on the right.
- `Dialog` — A modal dialog, built on the native dialog element.
- `Eyebrow` — Small uppercase monospace label. The system's quietest text role.
- `Field` — The wrapper that makes label/control association impossible to get wrong.
- `Grid` — The grid. Lay GridItems into it and give them a span.
- `GridItem` — A cell in a Grid. Only meaningful as a direct child of one.
- `Heading` — A document heading.
- `InlineAction` — A low-emphasis action sized for running text  clear, reset and friends.
- `Input` — A single-line text control.
- `Label` — The name of a control. Prefer letting Field render it.
- `Legend` — Colour key for a chart.
- `MacroStrip` — Edge-to-edge row of StatTiles divided by hairlines.
- `MomentumCard` — A clickable tile pairing a headline figure with its path over time.
- `NarrativeItem` — A plain-language annotation with a coloured rail.
- `PageHeader` — Page-level title block with a control cluster on the far edge.
- `Pagination` — Page navigation for a paged collection: a nav wrapping a list of page
- `Panel` — The surface every block of content sits on.
- `PanelHeading` — Title/subtitle pair used at the top of a Panel.
- `Popover` — A panel anchored to a trigger, holding content the user can reach.
- `Radio` — One option of a mutually exclusive set  a real input typeradio,
- `RadioGroup` — A mutually exclusive set of options.
- `SegmentedControl` — A pill group for picking exactly one of a small set of options.
- `Select` — A native select wearing Input's box, with a drawn chevron.
- `Skeleton` — A grey placeholder holding the space that real content is about to occupy.
- `Spinner` — An indeterminate progress mark, for waits with no measurable percentage.
- `Stack` — One-dimensional flow with a consistent gap  the answer to every I need a
- `StatTile` — One reading in the macro strip: label, figure, change, trend.
- `Switch` — An immediate on/off toggle  the setting takes effect the moment it moves,
- `Table` — A real table  caption, thead, th scopecol  for tabular
- `Tabs` — Underlined tabs for switching the primary view of a panel.
- `Text` — Body text at a chosen step of the type scale.
- `Textarea` — A multi-line text control.
- `ThemeToggle` — Switches between the dark and light palettes.
- `Toast` — A brief, self-dismissing message about something that already happened.
- `Tooltip` — A short, non-interactive label describing the element it hangs off.
- `VisuallyHidden` — Text removed from the visual layout but left in the accessibility tree.

### charts
- `BreakdownBar` — A labelled proportion bar, sized relative to its largest sibling.
- `HeatGrid` — Dense signed-value grid with a diverging teal/rust ramp.
- `RotationMatrix` — Square fromto matrix. The diagonal is deliberately blanked  a market
- `RotationRing` — Circular rotation view: bubble size is net position change, chord thickness
- `SankeyFlow` — Two-column flow diagram: capital leaves the left stack and arrives in the
- `Sparkline` — A compact trend line.
