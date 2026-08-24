# EXPLAINER — how this viewer works

This document is the study companion to `index.html`. One section per build phase;
each is written to be read top-to-bottom after that phase lands. The goal: you can
explain every design decision in this repo without looking at the code.

## Contents

1. **Phase 1 — Data pipeline** *(pending)*
   - What a NIfTI-1 file is, byte by byte
   - Why the CT needs a rescale (`scl_slope` / `scl_inter`) and what Hounsfield Units are
   - Why 9 binary masks become one label volume
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
