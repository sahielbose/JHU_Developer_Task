# EXPLAINER — how this viewer works

This document is the study companion to `index.html`. One section per build phase;
each is written to be read top-to-bottom after that phase lands. The goal: you can
explain every design decision in this repo without looking at the code.

## Contents

1. **[Phase 1 — Data pipeline](#phase-1--data-pipeline)** *(done)*
2. **[Phase 2 — Axial viewer](#phase-2--axial-viewer)** *(done)*
3. **[Phase 3 — Three planes](#phase-3--three-planes)** *(done)*
4. **[Phase 4 — 3D view + polish](#phase-4--3d-view--polish)** *(done)*
5. **[Mock Q&A](#mock-qa)** — questions a reviewer might ask, with the answers
   you should be able to give cold.

---

## Phase 1 — Data pipeline

Everything in this phase happens before a single pixel is drawn. The goal: turn ten
compressed binary files into two arrays in memory — one for the CT, one for the labels —
plus enough metadata to interpret them.

### 1. The files are gzip-compressed

`.nii.gz` = a NIfTI file inside a gzip wrapper. Browsers can now decompress gzip natively
with `DecompressionStream('gzip')` — no third-party library needed. We check the first
two bytes for the gzip signature (`0x1f 0x8b`); if present, decompress; if not, the file
is a plain `.nii` and we use it as-is. This is why the viewer accepts both extensions.

### 2. NIfTI-1: a 348-byte header, then raw voxels

NIfTI is *not* a container like ZIP — it's a fixed-layout C struct dumped to disk.
Every field lives at a known byte offset, so parsing is just reading numbers out of a
`DataView` at the right positions (all little-endian in this dataset):

| Offset | Field | In our CT |
|---|---|---|
| 0 | `sizeof_hdr`, must be 348 — doubles as a validity + endianness check | 348 |
| 40 | `dim[8]` — dim[0] is rank; dim[1..3] are X, Y, Z | 502, 348, 71 |
| 70 | `datatype` — 4 = int16 (CT), 256 = int8 (masks) | 4 |
| 76 | `pixdim[8]` — voxel size in mm at [1..3] | 0.816, 0.816, 2.5 |
| 108 | `vox_offset` — where voxel data starts | 352 |
| 112 | `scl_slope` | 0.030518 |
| 116 | `scl_inter` | 0.015259 |
| 344 | magic `"n+1"` | ✓ |

After `vox_offset`, the rest of the file is one flat array of 502 × 348 × 71 =
12,403,416 numbers, in **Fortran order**: x varies fastest. So the voxel at (x, y, z)
lives at index `x + nx*(y + ny*z)`. This one formula is the backbone of the whole app —
slicing in any plane (Phase 2/3) is just iterating this index in different orders.

### 3. Hounsfield Units and the rescale

CT voxels aren't arbitrary brightness — they're **Hounsfield Units (HU)**, a physical
scale of X-ray attenuation: water = 0, air = −1000, fat ≈ −100, soft organs ≈ 40–60,
bone ≈ +400 and up. Radiologists think entirely in HU, so the viewer must too.

The file doesn't store HU directly. It stores int16 values plus an affine rescale in
the header: `HU = raw × scl_slope + scl_inter`. Here slope ≈ 0.030518 = 2000/65535 —
i.e. the full int16 range (−32768..32767) maps exactly onto −1000..+1000 HU. Whoever
preprocessed this dataset clamped it to that clinical range and stretched it across
all 16 bits.

**Skipping the rescale is the classic mistake:** raw values span ±32768, so any
windowing math written for HU (e.g. "show 40 ± 200") would select a meaninglessly thin
slice of the raw range and render near-uniform gray. We never materialize a converted
copy — the raw array is kept, and the two constants are applied on the fly wherever a
HU value is needed. Zero extra memory, and the data stays exactly as shipped.

### 4. Nine masks → one label volume

Each mask is a full 12.4M-voxel volume of 0s and 1s. Keeping nine of them costs
9 × 12.4 MB, and every rendered pixel would need nine lookups. Instead we fold them
into a single `Uint8Array` where each voxel holds 0 (background) or a label 1–9
(1 = aorta … 9 = stomach, alphabetical). One lookup per pixel, 12.4 MB total.

This works because a voxel belongs to at most one organ — *almost*. Verification
found **1,831 voxels (0.1%) claimed by two masks** at organ boundaries in the source
annotations. Our merge is deterministic (later-alphabetical wins); the per-organ
counts reported in the UI are counted per mask, before merging, so they stay true to
each source file.

### 5. How Phase 1 was verified

The same statistics were computed twice by independent code paths: once by the app in
the browser, once by a NumPy script that parses the NIfTI bytes separately. All nine
voxel counts, the HU range (−1000.0 to 1000.0), grid, and spacing matched exactly.
The organ volumes also pass an anatomical smell test: liver 1,574 mL and spleen
182 mL are normal adult values — a strong hint that grid, spacing, and parsing are
all coherent.

**Q you should be able to answer after this section:** Why does the CT file's int16
range map to exactly ±1000 HU? What breaks if you ignore `scl_slope`? Why is the label
merge lossy in principle but fine in practice?

---

## Phase 2 — Axial viewer

### 1. From 3D array to 2D image

An axial slice is all voxels sharing one z. With the Fortran-order index
`i = x + nx*(y + ny*z)`, a slice is *contiguous* in memory — we walk it row by row and
write each voxel's gray value into a canvas `ImageData` buffer (RGBA bytes), then blit
it with `putImageData`. No WebGL, no libraries. Measured cost: **~1.2 ms per slice**
(502×348), which is why scrubbing feels instant — a GPU would be idle here anyway.

### 2. Window / level

A CT spans ~2000 HU but a monitor shows 256 grays, so you choose *which* HU band gets
the grays. **Level** = the HU value at mid-gray; **Window** = the width of the band.
Everything below `level − window/2` clips to black, above `level + window/2` to white:

```
gray = clamp( (HU − (level − window/2)) / window ) × 255
```

- **Abdomen (W 400 / L 40):** grays span −160..240 HU — organs are distinguishable,
  bone saturates white, air is black. The default.
- **Bone (W 1800 / L 400):** wide window centered high — trabecular detail appears,
  soft tissue flattens to mid-gray.
- **Lung (W 1500 / L −600):** centered deep in the negatives for aerated tissue.

Implementation detail: instead of converting each voxel to HU first, we substitute
`HU = raw·slope + inter` into the formula once per frame and precompute two constants,
so the inner loop does a single multiply-add on the raw int16 — the rescale and the
windowing collapse into one operation.

### 3. Overlay compositing

Where the label volume is nonzero and that structure is visible, the pixel is a linear
blend: `out = gray·(1−α) + organColor·α` (α from the opacity slider, default 0.45).
Colors come from 3D Slicer's **GenericAnatomyColors** table (liver 221,130,101;
spleen 157,108,162; …) so the palette matches what the BodyMaps lab sees in Slicer
daily. Per-label visibility/color lookups are tiny typed arrays indexed by label value
— no hash maps in the hot loop.

### 4. Orientation — the subtle one

NIfTI's canonical axes point Right/Anterior/Superior (+x toward the patient's right,
+y toward their front). A canvas draws y downward and x rightward, so drawing naively
mirrors the patient twice. Two flips fix it:

- **y flip** puts the patient's front (anterior) at the top of the image.
- **x flip** puts the patient's *right* on the image's *left* — the **radiological
  convention** (you view an axial slice from the patient's feet). Slicer does the same.

This was caught during verification by reading the anatomy: the spleen (a left-side
organ) rendered on the image's left before the x flip — anatomically impossible in
radiological display. The yellow **R/L/A/P** labels around the viewport make the
convention explicit, exactly like Slicer's viewport annotations. The hover readout
undoes both flips so reported (x, y, z) are true voxel indices.

### 5. How Phase 2 was verified

Anatomy as ground truth: liver under the "R" label, spleen under "L", spine at "P";
hovering the liver read **81 HU** (normal for contrast-enhanced liver, 50–80+);
stomach gas rendered black; bone preset lit the vertebrae and flattened soft tissue.
Mask-to-CT registration is visually exact — kidney overlays sit precisely on
kidney-shaped structures.

**Q you should be able to answer after this section:** Why does a wider window lower
contrast? Why must the x-axis be flipped, and how was the bug noticed? Why is slice
extraction fast without a GPU?

---

## Phase 3 — Three planes

### 1. Reslicing is just a different iteration order

The volume is one flat array indexed by `i = x + nx*(y + ny*z)`. The three planes are
three ways of walking it:

- **Axial** (fix z): vary x, y — memory-contiguous, the fast one.
- **Coronal** (fix y): vary x, z — row-contiguous per z.
- **Sagittal** (fix x): vary y, z — strided; every pixel is a jump of `nx` elements.

No copies, no precomputed reslices — each view reads straight from the same array.
Even the worst-case strided walk renders all three views in ~2 ms.

### 2. Anisotropy: why coronal/sagittal would look squashed

Voxels are 0.816 × 0.816 × 2.5 mm. In-plane axial pixels are square, but any view that
puts the z-axis on screen has pixels ~3× taller than wide. Drawn 1:1, a 71-slice-tall
coronal view would look like the patient was crushed to a third of their height.

Fix: the canvas keeps its *voxel* resolution (e.g. 502 × 71), and CSS `aspect-ratio`
is set to the *millimetre* proportions (`nx·sx / nz·sz`), so the browser stretches the
bitmap to true physical proportions (with bilinear smoothing for free). Physical size
comes from the header's `pixdim` — the same numbers that give organ volumes in mL.

### 3. Display conventions per plane (matching Slicer)

Each viewport is labeled and oriented like Slicer's, including its color code
(red = axial, yellow = sagittal, green = coronal):

- **Axial** — viewed from the feet: patient R on image left, A at top.
- **Sagittal** — viewed from the patient's left: A on image left, S at top.
- **Coronal** — viewed from the front: patient R on image left, S at top.

NIfTI's +x/+y/+z point Right/Anterior/Superior, so each view flips one or both display
axes to land on its convention (e.g. z must flip in coronal/sagittal because +z is
superior but canvas y grows downward).

### 4. Linked crosshairs

There is one shared cursor `(x, y, z)` in voxel space — the single source of truth.
Each view *displays* the slice at its own axis of the cursor (axial shows slice z,
coronal slice y, sagittal slice x) and *draws* the other two coordinates as crosshair
lines. Clicking or dragging in any view converts the pointer position back to voxel
coordinates (undoing the CSS scaling and that view's flips) and updates the shared
cursor; all three views re-render. That's the entire linking mechanism — no events
between views, just shared state. Scrolling in a view increments its own axis.

### 5. How Phase 3 was verified

- **Anatomy again:** sagittal shows the spine at P with the aorta running anterior to
  it; coronal shows liver under R, spleen under L; nobody squashed.
- **Numerically:** a synthetic click at 80% across the coronal view produced cursor
  x = 100 — exactly `nx−1−⌊0.80·502⌋`, confirming the flip math round-trips.
- **Consistency test:** computed the spleen's centroid from the label volume, moved
  the cursor there — all three views showed the crosshair inside the purple spleen
  overlay, and the centroid read 100 HU (normal contrast-enhanced spleen). One shared
  data structure, three projections, one anatomical point.

**Q you should be able to answer after this section:** Why does sagittal reslicing
have the worst memory access pattern? Where does the ~3× stretch factor come from —
derive it. Why does crosshair linking need no cross-view event system?

---

## Phase 4 — 3D view + polish

### 1. A 3D renderer with no graphics library

The fourth viewport renders the organ masks in 3D using nothing but a 2D canvas.
The trick is that we don't need triangles at all — a dense point cloud of *surface
voxels* reads as a solid surface. Pipeline:

1. **Surface extraction** (once per load): scan the label volume; a voxel is
   "surface" if any of its 6 neighbors has a different label. Only ~183k of the
   1.54M organ voxels survive — a 8× reduction. Each surviving point stores its
   position in **millimetre space** (voxel index × spacing, centered), its label,
   and an outward normal estimated from which neighbors were empty.
2. **Per frame**: rotate every point (turntable yaw + pitch — two 2D rotations),
   orthographically project to screen, and *splat* it as a small square into an
   `ImageData`, using a `Float32Array` **z-buffer** for occlusion: a pixel is only
   written if this point is closer than what's already there. No sorting — the
   z-buffer makes draw order irrelevant, so the whole frame is one O(n) pass.
   ~7 ms for 183k points ⇒ smooth drag rotation.
3. **Shading**: lambert with a headlight. The naive version rotates every normal
   every frame; instead we rotate the *light direction* once by the inverse
   rotation, so per-point cost is a single dot product. Because positions are in
   mm space, the anisotropy fix from Phase 3 falls out automatically here.
4. **Hole filling**: slices are 2.5 mm apart but in-plane voxels 0.816 mm, so a
   fixed splat leaves stripe gaps between slices when viewed side-on. The splat
   size scales with the projected slice spacing, keeping surfaces closed at any
   zoom.

Organ visibility checkboxes drive the same LUT as the 2D views, so hiding the
liver hides it everywhere at once.

### 2. The polish pass — what makes it read as "Slicer"

- **Crosshair colors carry meaning**: in Slicer, the line drawn across a viewport
  is the *intersection with another slice plane*, drawn in that plane's color.
  We do exactly that: in the axial view the vertical line is yellow (sagittal
  plane) and the horizontal green (coronal); coronal and sagittal both show a red
  line where the axial plane cuts. The viewport header strips use Slicer's exact
  view colors (red `#F34A33`, yellow `#EDD54C`, green `#6EB04B`, blue `#7483E9`).
- **Millimetre offsets** in each header (`S −1.3 mm`) — index × spacing measured
  from the volume center, signed toward R/A/S — because clinical software talks
  in physical units, not array indices.
- **Byte-level loading progress**: both `fetch` responses and dropped `File`s are
  read as streams, so one progress bar reflects true bytes for either path.
- **Case switching without reload** (`Load another case`): event listeners are
  bound exactly once at startup, and per-load state (canvas sizes, LUTs, legend,
  cursor) is rebuilt in `initViewer()` — re-ingesting is idempotent.
- **`?load=sample`** deep link: auto-loads the sample case when served over HTTP.
  Doubles as the hook for automated screenshots (the README image is captured by
  headless Chrome hitting that URL).

### 3. How Phase 4 was verified

Perf: 6.7 ms per 3D frame while orbiting, 7.3 ms for a full four-view render.
Toggling the liver dropped lit 3D pixels from 73k to 50k and back — the LUT is
genuinely shared. The reload round-trip was exercised (no duplicated presets or
legend rows), and a false alarm was chased down: the point count appeared to
change between loads, but re-deriving it three ways showed 183,539 every time —
the "discrepancy" was a misreading of a low-resolution screenshot. Verify against
data, not eyeballs.

**Q you should be able to answer after this section:** Why does a z-buffer remove
the need to sort points? Why is rotating the light equivalent to rotating every
normal? Why do the splats need to grow with zoom?

---

## Mock Q&A

The questions a technical reviewer plausibly asks about this demo, with the shape
of a good answer. Don't memorize the words — own the reasoning.

**1. Walk me through what happens between dropping the files and seeing an image.**
Gunzip each file with the browser's native `DecompressionStream`. Parse the fixed
348-byte NIfTI-1 header with a `DataView` — dimensions, datatype, voxel spacing,
and the HU rescale live at fixed byte offsets. The rest of the file becomes a typed
array view (no copy). The nine masks fold into one uint8 label volume. Then each
viewport walks its slice of the CT array, maps raw values through window/level, and
writes RGBA bytes into a canvas `ImageData`.

**2. What are Hounsfield Units, and why does your code multiply by 0.030518?**
HU is the physical scale of X-ray attenuation — water 0, air −1000, soft organs
40–80, bone 400+. The file stores int16 plus an affine rescale in the header
(`scl_slope`/`scl_inter`); this dataset maps the full int16 range onto exactly
−1000..+1000 HU (slope = 2000/65535). Skip the rescale and all windowing math is
meaningless.

**3. Why default to window 400 / level 40?**
That's the standard abdomen window: gray levels span −160..240 HU, which is where
abdominal soft-tissue contrast lives. Bone saturates white, air clips black —
intended behavior, radiologists switch presets when they care about those.

**4. Your voxels aren't cubes. Where does that matter?**
Everywhere physical space matters: coronal/sagittal views need a ~3× vertical
stretch (0.816 mm in-plane vs 2.5 mm between slices) or the anatomy is squashed;
organ volumes in mL use the voxel's mm³; 3D point positions are computed in mm;
and the 3D splat size must cover the projected inter-slice gap.

**5. Why merge nine masks into one label volume?**
Memory (12.4 MB instead of ~112 MB) and speed (one lookup per rendered pixel
instead of nine). The tradeoff: a voxel can only hold one label — 1,831 voxels
(0.1%) sat in two masks at organ boundaries, resolved deterministically. The
per-organ counts shown in the UI are computed per mask before merging, so they
stay faithful to the source files.

**6. Why is this fast without a GPU? Why canvas instead of WebGL?**
An axial slice is 175k pixels and the per-pixel work is one multiply-add and a
clamp — about a millisecond. The full four-view render including 3D is ~7 ms.
At this data scale WebGL adds complexity without visible benefit. The honest
answer continues: for full-resolution volume ray-casting or 4K viewports I'd move
to WebGL/WebGPU, and the mm-space geometry is already structured for that port.

**7. How do the linked crosshairs work?**
One shared cursor in voxel space, three projections of it. Each view shows the
slice at its own axis of the cursor and draws the other two coordinates as lines.
A click inverts the view's display mapping (CSS scale + axis flips) back to voxel
coordinates and updates the shared cursor. No cross-view event system — shared
state is the whole mechanism.

**8. How does the 3D view work with no graphics library?**
Extract surface voxels (any 6-neighbor differs) — 183k points, each with a mm
position, label, and an outward normal from its empty-neighbor directions. Per
frame: two 2D rotations, orthographic projection, and z-buffered splatting into
ImageData — O(n), no sorting, because the depth test makes draw order irrelevant.
Lambert shading via a headlight, rotating the light once instead of 183k normals.

**9. Why all the axis flips?**
Three coordinate systems disagree: NIfTI axes point Right/Anterior/Superior, the
canvas y-axis points down, and radiology displays axial slices viewed from the
feet (patient right on image left — Slicer does the same). Each view flips what's
needed. The bug this catches: my first render put the spleen on the image's left —
anatomically impossible in radiological display, since the spleen is a left-side
organ. Reading the anatomy caught the mirror.

**10. How did you verify correctness?**
Three independent lines: (a) the same statistics computed by separate code — the
app in the browser vs a NumPy script — matched exactly (all voxel counts, HU
range); (b) anatomical sanity — liver 1,574 mL and spleen 182 mL are normal adult
volumes, hovering the liver reads ~50–80 HU; (c) geometric round-trips — synthetic
clicks produce the exact voxel the flip math predicts, and putting the cursor at
the spleen's computed centroid lands the crosshair inside the spleen overlay in
all three planes at once.

**11. What happens with a different AbdomenAtlas case?**
It loads — same format, and nothing is hardcoded to this case: grids and spacing
come from the header, unrecognized mask filenames get fallback colors. The honest
limits: NIfTI-1 little-endian only, and the qform/sform affine is ignored — I
assume axis-aligned RAS voxels, which holds for this dataset. Handling arbitrary
orientations via the sform matrix is the first thing I'd add for general data.

**12. Biggest known limitations?**
The affine assumption above; everything held in memory (fine to a few hundred MB,
then you want chunked loading); no MPR obliques; the 3D view is splats, not a
marching-cubes mesh. All are scoped-out-for-a-demo decisions, not unknowns.

**13. How would you extend this toward what Slicer actually does — editing?**
The label volume is already the right data structure: painting is writing label
values under a brush with an undo stack of (index, oldValue) runs; export is
writing a NIfTI header + the label bytes and gzipping with the native
`CompressionStream`. Rendering needs zero changes — the LUTs already re-render
edited labels.

**14. Why didn't you use NiiVue or Cornerstone?**
Deliberately. Libraries like NiiVue would give all of this out of the box — in a
production team codebase that's likely the right call, and I'd advocate for it.
But this demo's job is to show I understand the pipeline down to the bytes, and
having parsed the format by hand makes me more useful *with* those libraries,
not less.

**15. How long did this take, and did you use AI tools?**
Answer honestly: built with AI assistance in about a day, then audited — every
design decision in this document is one I can defend without notes. This document
is the proof of the second half.
