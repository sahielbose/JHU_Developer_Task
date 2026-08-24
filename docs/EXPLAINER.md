# EXPLAINER — how this viewer works

This document is the study companion to `index.html`. One section per build phase;
each is written to be read top-to-bottom after that phase lands. The goal: you can
explain every design decision in this repo without looking at the code.

## Contents

1. **[Phase 1 — Data pipeline](#phase-1--data-pipeline)** *(done)*
2. **Phase 2 — Axial viewer** *(pending)*
   - How a 3D array becomes a 2D slice on a canvas
   - Window/level: what radiologists actually do with those two numbers
   - Overlay compositing and Slicer's anatomy color table
3. **Phase 3 — Three planes** *(pending)*
   - Reslicing: coronal and sagittal from the same array
   - Anisotropic voxels and aspect correction
   - Linked crosshairs
4. **Phase 4 — 3D view + polish** *(pending)*
5. **Mock Q&A** *(written last)* — questions a reviewer might ask, with the answers
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
