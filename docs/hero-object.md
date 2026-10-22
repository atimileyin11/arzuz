# The hero object

The landing page's hero is the only place the site shows an *object* rather than a card: a compound
plan on the page, an inspection panel resting on it, an Arzuz stamp pressed over its corner. It is
one composition defined once — the breakpoints only scale it — because two hand-tuned arrangements
are two things that drift apart. Read this before changing anything inside `.h-scene`.

Lives in [index.html](../index.html): the rules at `.h-scene` (~L203–830, in the page's own `<style>`),
the markup in `<!-- ============ HERO ============ -->`. It is named to assistive tech as one
`role="img"` whose label states all four claims, so a screen reader reads one image rather than four
plates out of order. No price and no count is drawn anywhere in it; every claim it carries is set out
in full under **Verification** below the fold.

Guarded by **`scripts/test-home-motion.mjs`** (the plate animates on mobile too, sits whole inside
the hero, and covers no copy, button or link), **`scripts/test-site-audit.mjs`** (both widths, every
page) and **`scripts/test-hero-visual.mjs`** (the paint itself, against the image recorded for it in
[hero-baselines/](hero-baselines/) — the tint of the plan, the throw of the one light, the glint, the
type inside the disc). None of them can see whether the object still *reads* right — that part is
yours.

The middle section of this page is mechanically checked by **`scripts/test-hero-geometry.mjs`**,
which loads the real page at 1440 and 390 and asserts the chain rather than the sizes: `--seal`'s own
value, the band, the overhang and the foot derived from it, the stage padding being exactly those
four values, the paper inset by the overhang, the plan showing the same gutter beside the panel and
the foot beneath it, and the seal landing flush on the column's right edge while crossing the paper
by exactly the overhang. It measures layout boxes (`offset*`), never painted ones, because the turns
would flatter a number that is really a composition slipping. Change a value here and that suite is
the thing that tells you what else moved — the table below is what it prints on every run. It also
sets `--seal-over: 0` and a unitless `--foot` on the live page twice per run and requires each to
cost only the edge it names, because those are the two hand edits this composition has actually been
through.

## The stack

Rendered back to front:

### The plan — the paper (`.h-blueprint` → `.h-blueprint-in`)

*Why:* the context. It says *where* an inspection happened and *what* it was measured against, and it
gives the panel something to rest on. It is deliberately quiet — a 1.5px dashed frame, a 24px grid at
.085, a .72 sheet fill — so the panel's own type stays the read.

It is not a plate placed *on* the scene; it **is** the scene's plane: absolutely positioned to fill
the stage's padding box, inset on the right by `--seal-over` so the seal can hang past it and the
composition still ends on the page's gutter. The `Compound plan` label and the gate pin sit inside it.

### The panel — the claim (`.h-ticketwrap` → `.h-ticket`)

*Why:* the four facts the stamp carries — water tested at the tap, power hours confirmed with
residents, the walk measured on foot from the gate, the date and signature of whoever inspected. This
is the only plate that is *read*, so it is the nearest one (`data-depth="1"`) and the largest.

It is in **flow** inside the stage, between the stage's own gutters. That is what makes its height the
object's height — there is no `min-height` anywhere — and it is why the panel must never be given a
top `margin`: a child's top margin collapses out of the stage and drags the whole composition down
the page.

### The seal — the authority (`.h-stampwrap` → `.h-stamp`)

*Why:* who inspected, and when. It is the one plate that is a minted disc rather than a sheet, and
the one that breaks the paper's rectangle: pressed on the corner with `--seal-over` of overhang on
both axes, exactly the amount the paper is inset by, so disc and paper still land together on the
scene's right edge.

Its innards scale from `--seal` — the inner ring's inset (.057), the `ARZUZ`/date type (.0625), the
`INSPECTED` word (.128, the widest that still sits inside the inner ring), the rule width (.45) — with
clamp floors where legibility stops scaling. The date comes from one constant, `Arzuz.STAMP_DATE`
(`assets/app.js`), so the stamp and the page's "updated" line can never disagree.

### The pin and its caption — the plan's landmark (`.h-bp-pin`, `.h-bp-cap`)

*Why:* the walk is *measured from the gate*, and the plan should show one. A ringed pin with its label
sits left at 46% and vertically on the centre line of the seal's band (`--seal-band / 2 ± 8/13px`), so
it holds the same place on the plan at both scales even though the plan is a different shape at each.

### The aurora — light, not a plate (`.h-aurora`)

A blurred purple/blue wash whose only job is to make the object sit in air. It is **opacity-only** on
purpose: `motion.js` owns every transform on this stage, and a second claimant for `transform` is how
an object starts twitching. It is switched off below 940px, where a wash drawn for a wide dark hero
would tint the panel instead of sitting behind it.

## Why the light comes from the upper left

One key light, and one plate that fixes its direction: the seal, the only plate with a specular
highlight — a white radial glint at **30% 22%** of the disc. From that, every shadow on the object
falls **down and to the right**, by `--lit`:

| plate | x-offset | drop / blur |
| --- | --- | --- |
| paper | `var(--lit)` | 60px tall, −34 blur |
| panel — contact shadow | `calc(var(--lit) * .38)` | 9px, −3 blur |
| panel — lift | `var(--lit)` | 50px, −24 blur |
| seal | `calc(var(--lit) * .62)` | 36px, −16 blur |
| pin | `calc(var(--lit) * .2)` | 12px, −3 blur |

Each plate reads its x-offset *from* `--lit` rather than inventing one, which is what stops a plate
being re-lit on its own: the paper, the panel and the seal cannot disagree about where the light is.
`--bezel` (a 1px inner rim plus a top highlight) is the plates' shared neutral edge, and the two
turns keep the plates nearly parallel — paper `rotateY(9deg) rotateX(2deg) rotateZ(-1deg)`, panel
`rotateY(5deg) rotateX(1deg)` — one plane with a slight turn, not two objects facing away from each
other. The seal is the single disc turned in the hand (`rotateY(-13deg) rotateX(10deg) rotateZ(-8deg)`).

On a phone the light does not move; the throw shortens. `--lit` is 8px, because a 16px offset on a
~330px sheet reads as the whole composition leaning, and the turns shrink with it (paper 3.5deg,
panel 2.5deg). If you ever feel the object is lit "wrongly", do not rotate a shadow: the glint is the
source of truth.

## The two scales, in numbers

The breakpoints set **values only**; every *position* is derived. Change `--seal` and the band, the
overhang and the foot follow — there is no second arrangement to keep in step.

| | desktop (≥940px) | phone (≤939px) | derived from |
| --- | --- | --- | --- |
| `--seal` | 156px | 108px | set by the breakpoint |
| `--gutter` | 30px | 15px | set by the breakpoint |
| `--lit` | 16px | 8px | set by the breakpoint |
| `--seal-over` | 15.6px | 10.8px | `seal × .1` |
| `--seal-band` | 164px | 116px | `seal + 8px` |
| `--foot` | 34.32px | 23.76px | `seal × .22` |

The stage's padding *is* the composition: `--seal-band` / `--gutter + --seal-over` / `--foot` /
`--gutter`. The paper fills that box minus `--seal-over` on the right; the panel sits in flow inside
the gutters; the seal is a `--seal` square at `top: -seal-over`, `right: 0`.

Measured by `scripts/test-hero-geometry.mjs` in this checkout (2026-10-15, headless Chrome,
scrollbars hidden, layout boxes — transforms excluded) at 1440×900 and 390×844; it prints these
lines itself on every run, which is the point of quoting them:

| | 1440 | 390 |
| --- | --- | --- |
| scene column | 435×398 | 354×336 (the column caps at 440) |
| paper | 419×398 | 343×336 |
| panel | 359×200, 30px in, 164px down | 313×196, 15px in, 116px down |
| seal | 156², top −16, flush with the column's right edge | 108², top −11, same edge |
| plan beside the panel | 30 / 30 | 15 / 15 |
| plan below the panel | 34.3 | 23.8 |

Widths are the composition and are what a regression shows up in first. The two heights are the
panel's own type, so they move when a line of the panel changes — read them, do not hold the suite to
them. The turn on each plate makes its *painted* box a little larger than its layout box at 1440
(which is why the suite measures `offset*` and this table records the layout, not the paint); at 390
the wrappers' transforms are suppressed, so painted and layout are the same box there.

## What the motion layer owns

`assets/motion.js` is contracted for this object: the stage rotates a little with the pointer and the
plates drift against it by `data-depth` — aurora 0.16 (light, furthest), paper 0.44, seal 0.72 with
`data-z="26"`, panel 1 with `data-z="74"` (nearest, because it is the one you read). The depth order
**is** the meaning: light, plane, stamp, claim.

Below 940px the layer's transforms are suppressed with `!important` on the three wrappers — a depth
offset needs a pointer to move it, and with none it survives only as distortion — and the object gets
one ambient motion instead: a slow float (`stampFloat`, 8s) whose last frame is the resting
transform, so the reduced-motion collapse lands flat. With `prefers-reduced-motion` scenes and tilt
are never bound at all, and if `motion.js` never loads, the object still renders: nothing in the
composition starts hidden.

## House rules

- **Do not write the stage's padding as one shorthand.** It is four longhands over `--seal-band`,
  `--gutter + --seal-over`, `--foot` and `--gutter`, and the four are registered as `<length>` up in
  the page's `@property` block. A shorthand is one declaration: a single value it cannot parse —
  `--foot: 24` without a unit, or `--seal-over: 0` before the registrations — takes the band, the foot
  and both gutters down with it and the object collapses into its own corner. Written this way each
  value costs only its own edge, which is the most a reader poking at one of them should pay. The
  geometry suite sets both of those values on the live page every run to keep that true.
- **Do not place anything per-breakpoint.** A media query here may set `--seal`, `--gutter`, `--lit`,
  the three turns, the phone's depth suppression and its float — nothing positional.
- **Do not give a plate its own shadow direction.** Offsets come from `--lit`.
- **Do not hard-code the seal's innards.** They scale from `--seal`; the clamps are legibility floors.
- **Do not `margin-top` the panel** (it collapses out of the stage) and do not add `min-height` to
  the scene — the panel's height is the object's height.
- **Keep the `role="img"` label in step with the panel.** If a claim changes, all three change: the
  panel, the label, and the Verification section it points at.
- **Check the object, not the diff:** `node scripts/test-all.mjs --only=hero-geometry` (does the chain
  still hold), `--only=hero-visual` (does it still look like itself), then `--only=home-motion` and
  `--only=site-audit`; and compare the layout numbers above at both widths.
- **A paint change is accepted, not argued with.** The baselines in `hero-baselines/` are what the
  object looked like when someone said "this is right" — including a one-line note in the commit for
  why it changed. Re-record them with `node scripts/test-hero-visual.mjs --update`, and read the image
  it writes before you do: it is the only thing in the repository that shows what a reader sees.
