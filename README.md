# Browser CT Viewer

A web-based CT scan viewer with per-voxel segmentation overlays, in the spirit of
[3D Slicer](https://www.slicer.org/) but running entirely in the browser. No install,
no server, no GPU — a single self-contained `index.html` with zero dependencies.

Built as the demo for **BodyMaps Developer Project 1** (Johns Hopkins University /
Johns Hopkins Medicine).

## Features

> Work in progress — feature list and screenshots land as each milestone completes.

- [ ] NIfTI-1 (`.nii.gz`) parsing in pure JavaScript (native `DecompressionStream`, no libraries)
- [ ] Axial slice viewer with window/level controls and radiology presets (Abdomen / Bone / Lung)
- [ ] 9 organ segmentation overlays with Slicer's GenericAnatomyColors, per-organ toggles
- [ ] Hover readout: voxel coordinates, HU value, organ name
- [ ] Coronal + sagittal views with anisotropic voxel aspect correction
- [ ] Slicer-style 2×2 layout with linked crosshairs
- [ ] 3D organ mask view (pure canvas, rotatable)

## Usage

Open `index.html` in any modern browser and drag the CT + segmentation files in —
or serve the repo with any static file server to have the sample data load automatically:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Data

`data/` contains one abdominal CT scan and 9 per-voxel organ masks
(aorta, gall bladder, kidneys, liver, pancreas, postcava, spleen, stomach) from the
publicly hosted BodyMaps sample `BDMAP_00000338`:

- Volume: 502 × 348 × 71 voxels, int16, spacing 0.816 × 0.816 × 2.5 mm
- CT rescale: `HU = raw × 0.030518 + 0.015259` (from the NIfTI header)
- Masks: binary int8, same grid as the CT

## Architecture

One `index.html`, vanilla HTML/CSS/JS. See [docs/EXPLAINER.md](docs/EXPLAINER.md)
for a walkthrough of the pipeline: gunzip → NIfTI header parse → HU rescale →
label-volume merge → canvas slice rendering.
