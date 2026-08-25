'use strict';

/* ===================================================================
 * 1. Constants — organ names and 3D Slicer's GenericAnatomyColors
 * =================================================================== */

const ORGANS = [
  { key: 'aorta',        name: 'Aorta',          color: [224,  97,  76] },
  { key: 'gall_bladder', name: 'Gall bladder',   color: [139, 150,  98] },
  { key: 'kidney_left',  name: 'Left kidney',    color: [185, 102,  83] },
  { key: 'kidney_right', name: 'Right kidney',   color: [185, 102,  83] },
  { key: 'liver',        name: 'Liver',          color: [221, 130, 101] },
  { key: 'pancreas',     name: 'Pancreas',       color: [249, 180, 111] },
  { key: 'postcava',     name: 'Postcava (IVC)', color: [  0, 151, 206] },
  { key: 'spleen',       name: 'Spleen',         color: [157, 108, 162] },
  { key: 'stomach',      name: 'Stomach',        color: [216, 132, 105] },
];

// Fallback palette for masks whose filename we don't recognize, so a
// different case's extra structures still render with distinct colors.
const EXTRA_COLORS = [
  [230, 220, 70], [111, 184, 210], [220, 245, 20], [144, 238, 144],
  [192, 104, 88], [78, 63, 0], [255, 250, 220], [230, 220, 70],
];

const NIFTI_DATATYPES = {
  2:   { ctor: Uint8Array,   label: 'uint8'   },
  4:   { ctor: Int16Array,   label: 'int16'   },
  8:   { ctor: Int32Array,   label: 'int32'   },
  16:  { ctor: Float32Array, label: 'float32' },
  256: { ctor: Int8Array,    label: 'int8'    },
  512: { ctor: Uint16Array,  label: 'uint16'  },
};

/* ===================================================================
 * 2. Decompression + NIfTI-1 parsing
 * =================================================================== */

async function maybeGunzip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;  // not gzip
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

function parseNifti(buffer, filename) {
  const view = new DataView(buffer);

  const sizeofHdr = view.getInt32(0, true);
  if (sizeofHdr !== 348) {
    if (view.getInt32(0, false) === 348)
      throw new Error(`${filename}: big-endian NIfTI is not supported`);
    throw new Error(`${filename}: not a NIfTI-1 file (sizeof_hdr = ${sizeofHdr})`);
  }
  const magic = String.fromCharCode(view.getUint8(344), view.getUint8(345), view.getUint8(346));
  if (magic !== 'n+1' && magic !== 'ni1')
    throw new Error(`${filename}: bad NIfTI magic "${magic}"`);

  const nx = view.getInt16(42, true);   // dim[1..3] — dim[0] (rank) is at byte 40
  const ny = view.getInt16(44, true);
  const nz = view.getInt16(46, true);
  const datatype = view.getInt16(70, true);
  const spacing = [view.getFloat32(80, true), view.getFloat32(84, true), view.getFloat32(88, true)];
  const voxOffset = view.getFloat32(108, true) || 352;
  let slope = view.getFloat32(112, true);
  const inter = view.getFloat32(116, true);
  if (slope === 0 || !isFinite(slope)) slope = 1;  // slope 0 means "no rescale" per spec

  const dt = NIFTI_DATATYPES[datatype];
  if (!dt) throw new Error(`${filename}: unsupported NIfTI datatype ${datatype}`);

  const nvox = nx * ny * nz;
  if (voxOffset + nvox * dt.ctor.BYTES_PER_ELEMENT > buffer.byteLength)
    throw new Error(`${filename}: file too short for ${nx}×${ny}×${nz} ${dt.label}`);

  // Voxel layout is Fortran order: x fastest, so index = x + nx*(y + ny*z)
  const data = new dt.ctor(buffer, voxOffset, nvox);
  return { filename, dims: [nx, ny, nz], spacing, datatype, datatypeLabel: dt.label, slope, inter, data };
}

/* ===================================================================
 * 3. Volume store — CT + merged label volume
 * =================================================================== */

// Filled by ingest(); the renderer reads from here.
const app = {
  ct: null,        // parsed NIfTI of the CT (raw values; HU = raw*slope + inter)
  labels: null,    // Uint8Array, same grid as CT; 0 = background, 1..N = structures
  structures: [],  // [{name, color, labelValue, voxels, visible}]
  huRange: null,
  cloud: null,     // surface point cloud for the 3D view
};
window.app = app;  // exposed for debugging

function huAt(x, y, z) {
  const [nx, ny] = app.ct.dims;
  const raw = app.ct.data[x + nx * (y + ny * z)];
  return raw * app.ct.slope + app.ct.inter;
}

function stripName(filename) {
  return filename.toLowerCase().replace(/\.nii(\.gz)?$/, '').replace(/^.*\//, '');
}

// A segmentation mask holds a handful of small non-negative integer values;
// a CT is a wide-range grayscale volume. Sampling ~20k voxels tells them apart.
function looksLikeLabels(vol) {
  const d = vol.data, n = d.length, stride = Math.max(1, Math.floor(n / 20000));
  const seen = new Set();
  for (let i = 0; i < n; i += stride) {
    const v = d[i];
    if (v < 0 || v > 32 || v !== (v | 0)) return false;
    seen.add(v);
    if (seen.size > 8) return false;
  }
  return true;
}

async function ingest(entries, caseName) {
  // entries: [{name, buffer}]
  const t0 = performance.now();
  log(`Parsing ${entries.length} file(s)…`);

  // The CT is found by the AbdomenAtlas naming convention (ct.nii.gz) when
  // present, and by content otherwise — so arbitrarily named cases still load.
  let ctEntry = null;
  const maskEntries = [];
  for (const e of entries) {
    const base = stripName(e.name);
    if (base === 'ct' || base.startsWith('ct_') || base.endsWith('_ct')) ctEntry = e;
    else maskEntries.push(e);
  }

  let ct = null;
  if (ctEntry) {
    ct = parseNifti(await maybeGunzip(ctEntry.buffer), ctEntry.name);
  } else {
    const candidates = [];
    for (const e of entries) {
      const vol = parseNifti(await maybeGunzip(e.buffer), e.name);
      if (looksLikeLabels(vol)) continue;
      candidates.push(e);
      ct = candidates.length === 1 ? vol : null;
    }
    if (candidates.length > 1)
      throw new Error(`Multiple CT-like volumes (${candidates.map(c => c.name).join(', ')}) — rename the CT to ct.nii.gz to disambiguate`);
    if (candidates.length === 0)
      throw new Error(entries.length === 1
        ? `${entries[0].name} looks like a segmentation mask (only a few distinct values) — drop it together with its CT`
        : 'No CT volume found — every file looks like a segmentation mask');
    ctEntry = candidates[0];
    maskEntries.length = 0;
    for (const e of entries) if (e !== ctEntry) maskEntries.push(e);
    log(`CT identified by content: ${ctEntry.name}`);
  }

  const [nx, ny, nz] = ct.dims;
  const nvox = nx * ny * nz;
  log(`<span class="ok">✓</span> CT ${nx}×${ny}×${nz} ${ct.datatypeLabel}, ` +
      `${ct.spacing.map(s => s.toFixed(3)).join(' × ')} mm`);

  // Merge every mask into one label volume: 1 byte per voxel total,
  // instead of one full volume per organ.
  const labels = new Uint8Array(nvox);
  const structures = [];
  maskEntries.sort((a, b) => stripName(a.name) < stripName(b.name) ? -1 : 1);
  let extraIdx = 0;

  for (const e of maskEntries) {
    const base = stripName(e.name);
    const mask = parseNifti(await maybeGunzip(e.buffer), e.name);
    if (mask.dims.join() !== ct.dims.join()) {
      // A mask on a different grid can't be overlaid voxel-for-voxel —
      // skip it rather than abort the whole case.
      log(`<span class="err">✗</span> ${e.name} skipped: grid ${mask.dims.join('×')} does not match CT ${ct.dims.join('×')}`);
      continue;
    }

    const known = ORGANS.find(o => o.key === base);
    const labelValue = structures.length + 1;
    if (labelValue > 255) throw new Error('More than 255 structures are not supported');
    const color = known ? known.color : EXTRA_COLORS[extraIdx++ % EXTRA_COLORS.length];
    const name = known ? known.name : base.replace(/_/g, ' ');

    let voxels = 0;
    const md = mask.data;
    for (let i = 0; i < nvox; i++) {
      if (md[i] !== 0) { labels[i] = labelValue; voxels++; }
    }
    structures.push({ name, color, labelValue, voxels, visible: true });
    log(`<span class="ok">✓</span> ${name}: ${voxels.toLocaleString()} voxels`);
  }
  if (!structures.length)
    log('No segmentation masks in this load — slice views only.');

  // Raw min/max in one pass — used for the study panel and windowing sanity.
  let min = Infinity, max = -Infinity;
  const cd = ct.data;
  for (let i = 0; i < nvox; i++) {
    const v = cd[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  app.ct = ct;
  app.labels = labels;
  app.structures = structures;
  app.huRange = [min * ct.slope + ct.inter, max * ct.slope + ct.inter];
  app.caseName = caseName || 'case';

  buildSurfaceCloud();
  log(`Done in ${((performance.now() - t0) / 1000).toFixed(2)} s.`);
  initViewer();
}

/* ===================================================================
 * 4. File ingestion — drag & drop (files or folders), picker, sample —
 *    all funneled through a byte-level progress bar
 * =================================================================== */

const logEl = document.getElementById('log');
function log(html) { logEl.insertAdjacentHTML('beforeend', html + '\n'); }
function logError(err) {
  log(`<span class="err">✗ ${err.message || err}</span>`);
  progressHide();
  console.error(err);
}

function isNifti(name) { return /\.nii(\.gz)?$/i.test(name) && !name.startsWith('.'); }

const prog = { total: 0, loaded: 0 };
function progressShow() {
  prog.total = 0; prog.loaded = 0;
  document.getElementById('progress').hidden = false;
  document.getElementById('progress-fill').style.width = '0%';
  logEl.innerHTML = '';
}
function progressHide() { document.getElementById('progress').hidden = true; }
function progressTick() {
  if (!prog.total) return;
  const pct = Math.min(100, prog.loaded / prog.total * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
}

async function readAllWithProgress(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let len = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    len += value.length;
    prog.loaded += value.length;
    progressTick();
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

async function filesFromDataTransfer(dt) {
  const out = [];
  let dirName = null;
  const entries = [...dt.items]
    .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) return { files: [...dt.files], dirName };

  async function walk(entry) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push(f);
    } else if (entry.isDirectory) {
      if (!dirName) dirName = entry.name;
      const reader = entry.createReader();
      let batch;
      do {  // readEntries returns at most ~100 entries per call
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return { files: out, dirName };
}

async function loadFiles(files, caseName) {
  const nifti = files.filter(f => isNifti(f.name));
  if (!nifti.length) { logError(new Error('No .nii / .nii.gz files found in the drop')); return; }
  try {
    progressShow();
    prog.total = nifti.reduce((a, f) => a + f.size, 0);
    const entries = [];
    for (const f of nifti)
      entries.push({ name: f.name, buffer: await readAllWithProgress(f.stream()) });
    await ingest(entries, caseName);
    progressHide();
  } catch (err) { logError(err); }
}

function showLoader() {
  $('viewer').hidden = true;
  $('case-chip').hidden = true;
  $('change-case').hidden = true;
  $('loader').hidden = false;
  logEl.innerHTML = '';
  progressHide();
}

// Drops are accepted anywhere on the page, not just the dropzone — dropping a
// new case while the viewer is open replaces the current one.
const dropzone = document.getElementById('dropzone');
document.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) dropzone.classList.remove('drag'); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const { files, dirName } = await filesFromDataTransfer(e.dataTransfer);
  if ($('loader').hidden) showLoader();
  loadFiles(files, dirName);
});

const fileInput = document.getElementById('file-input');
document.getElementById('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  loadFiles([...fileInput.files]);
  fileInput.value = '';
});

// The file picker cannot select a directory, so a whole case (ct.nii.gz +
// segmentations/) needs its own folder picker.
const folderInput = document.getElementById('folder-input');
document.getElementById('pick-folder').addEventListener('click', () => folderInput.click());
folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  const dirName = files[0] && files[0].webkitRelativePath
    ? files[0].webkitRelativePath.split('/')[0] : null;
  loadFiles(files, dirName);
  folderInput.value = '';
});

// "Load sample" only works when served over HTTP (fetch is blocked on file://).
const SAMPLE_PATHS = ['data/ct.nii.gz',
  ...ORGANS.map(o => `data/segmentations/${o.key}.nii.gz`)];

const sampleBtn = document.getElementById('sample');
if (location.protocol.startsWith('http')) {
  fetch(SAMPLE_PATHS[0], { method: 'HEAD' })
    .then(r => {
      if (!r.ok) return;
      sampleBtn.hidden = false;
      // shareable auto-load link, also used for automated screenshots
      if (new URLSearchParams(location.search).get('load') === 'sample')
        sampleBtn.click();
    })
    .catch(() => {});
}
sampleBtn.addEventListener('click', async () => {
  sampleBtn.disabled = true;
  try {
    progressShow();
    const entries = await Promise.all(SAMPLE_PATHS.map(async p => {
      const r = await fetch(p);
      if (!r.ok) throw new Error(`fetch ${p}: HTTP ${r.status}`);
      prog.total += +r.headers.get('Content-Length') || 0;
      return { name: p.split('/').pop(), buffer: await readAllWithProgress(r.body) };
    }));
    await ingest(entries, 'BDMAP_00000338');
    progressHide();
  } catch (err) { logError(err); }
  sampleBtn.disabled = false;
});

/* ===================================================================
 * 5. Viewer — three orthogonal planes with linked crosshairs
 *
 * Display conventions (matching 3D Slicer's viewports):
 *   axial    — patient R on image left, A at top       (viewed from the feet)
 *   sagittal — A on image left, S at top               (viewed from the left)
 *   coronal  — patient R on image left, S at top       (viewed from the front)
 * NIfTI axes point R/A/S (+x right, +y anterior, +z superior), so each view
 * flips one or both display axes to land on the convention above.
 * =================================================================== */

const PRESETS = [
  { name: 'Abdomen', window: 400,  level: 40   },
  { name: 'Bone',    window: 1800, level: 400  },
  { name: 'Lung',    window: 1500, level: -600 },
];

// Crosshair lines are drawn in the color of the PLANE they represent,
// exactly like Slicer: e.g. in the axial view the vertical line is where
// the sagittal (yellow) plane cuts, the horizontal where coronal (green) does.
const CROSS_COLORS = {
  axial:    { v: 'rgba(237, 213, 76, 0.75)', h: 'rgba(110, 176, 75, 0.75)' },  // sag / cor
  coronal:  { v: 'rgba(237, 213, 76, 0.75)', h: 'rgba(243, 74, 51, 0.75)' },   // sag / ax
  sagittal: { v: 'rgba(110, 176, 75, 0.75)', h: 'rgba(243, 74, 51, 0.75)' },   // cor / ax
};

const view = {
  cursor: { x: 0, y: 0, z: 0 },   // shared crosshair position, voxel coords
  window: 400, level: 40,
  alpha: 0.45,
  crosshair: true,
  zoom: { axial: 1, sagittal: 1, coronal: 1 },
};

const $ = id => document.getElementById(id);
const views = {};   // key -> {canvas, ctx, imageData, w, h}
let lutR, lutG, lutB, lutVis, lutName;

function rebuildLuts() {
  const n = app.structures.length + 1;
  lutR = new Uint8Array(n); lutG = new Uint8Array(n); lutB = new Uint8Array(n);
  lutVis = new Uint8Array(n); lutName = [''];
  for (const s of app.structures) {
    lutR[s.labelValue] = s.color[0];
    lutG[s.labelValue] = s.color[1];
    lutB[s.labelValue] = s.color[2];
    lutVis[s.labelValue] = s.visible ? 1 : 0;
    lutName[s.labelValue] = s.name;
  }
}

// Window mapping with the HU rescale folded in: gray = (raw - rawLo) * rawScale
function windowConstants() {
  const { ct } = app;
  const loHU = view.level - view.window / 2;
  return {
    rawLo: (loHU - ct.inter) / ct.slope,
    rawScale: 255 * ct.slope / view.window,
  };
}

function shadePixel(px, p, g, label, a, ia) {
  if (label && lutVis[label]) {
    px[p]     = g * ia + lutR[label] * a;
    px[p + 1] = g * ia + lutG[label] * a;
    px[p + 2] = g * ia + lutB[label] * a;
  } else {
    px[p] = px[p + 1] = px[p + 2] = g;
  }
  px[p + 3] = 255;
}

function renderView(key) {
  const v = views[key];
  const { ct, labels } = app;
  const [nx, ny, nz] = ct.dims;
  const { x: cx, y: cy, z: cz } = view.cursor;
  const { rawLo, rawScale } = windowConstants();
  const a = view.alpha, ia = 1 - a;
  const data = ct.data, px = v.imageData.data;
  let p = 0;

  if (key === 'axial') {                      // plane (x,y) at z = cz
    for (let row = 0; row < ny; row++) {
      const base = nx * ((ny - 1 - row) + ny * cz);      // y flip: A at top
      for (let dx = 0; dx < nx; dx++, p += 4) {
        const i = base + (nx - 1 - dx);                  // x flip: R on left
        let g = (data[i] - rawLo) * rawScale;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        shadePixel(px, p, g, labels[i], a, ia);
      }
    }
  } else if (key === 'coronal') {             // plane (x,z) at y = cy
    for (let row = 0; row < nz; row++) {
      const base = nx * (cy + ny * (nz - 1 - row));      // z flip: S at top
      for (let dx = 0; dx < nx; dx++, p += 4) {
        const i = base + (nx - 1 - dx);                  // x flip: R on left
        let g = (data[i] - rawLo) * rawScale;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        shadePixel(px, p, g, labels[i], a, ia);
      }
    }
  } else {                                    // sagittal: plane (y,z) at x = cx
    for (let row = 0; row < nz; row++) {
      const zBase = ny * (nz - 1 - row);                 // z flip: S at top
      for (let dx = 0; dx < ny; dx++, p += 4) {
        const i = cx + nx * ((ny - 1 - dx) + zBase);     // y flip: A on left
        let g = (data[i] - rawLo) * rawScale;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        shadePixel(px, p, g, labels[i], a, ia);
      }
    }
  }

  v.ctx.putImageData(v.imageData, 0, 0);
  if (view.crosshair) drawCrosshair(key);
}

// Crosshair display position = cursor voxel run through each view's flips
function crosshairDisp(key) {
  const [nx, ny, nz] = app.ct.dims;
  const { x, y, z } = view.cursor;
  if (key === 'axial')   return { dx: nx - 1 - x, row: ny - 1 - y };
  if (key === 'coronal') return { dx: nx - 1 - x, row: nz - 1 - z };
  return                        { dx: ny - 1 - y, row: nz - 1 - z };  // sagittal
}

function drawCrosshair(key) {
  const v = views[key];
  const { dx, row } = crosshairDisp(key);
  const colors = CROSS_COLORS[key];
  const c = v.ctx;
  c.lineWidth = 1;
  c.strokeStyle = colors.v;
  c.beginPath();
  c.moveTo(dx + 0.5, 0); c.lineTo(dx + 0.5, v.h);
  c.stroke();
  c.strokeStyle = colors.h;
  c.beginPath();
  c.moveTo(0, row + 0.5); c.lineTo(v.w, row + 0.5);
  c.stroke();
}

// Pointer position in a view -> voxel coords (undo CSS scaling + flips)
function voxelFromEvent(key, e) {
  const v = views[key];
  const rect = v.canvas.getBoundingClientRect();
  const dx = Math.floor((e.clientX - rect.left) / rect.width * v.w);
  const row = Math.floor((e.clientY - rect.top) / rect.height * v.h);
  if (dx < 0 || dx >= v.w || row < 0 || row >= v.h) return null;
  const [nx, ny, nz] = app.ct.dims;
  const { x, y, z } = view.cursor;
  if (key === 'axial')   return { x: nx - 1 - dx, y: ny - 1 - row, z };
  if (key === 'coronal') return { x: nx - 1 - dx, y, z: nz - 1 - row };
  return                        { x, y: ny - 1 - dx, z: nz - 1 - row };  // sagittal
}

function renderAll() {
  renderView('axial');
  renderView('sagittal');
  renderView('coronal');
  render3D();
  updateHuds();
}

function updateHuds() {
  const [nx, ny, nz] = app.ct.dims;
  const [sx, sy, sz] = app.ct.spacing;
  const { x, y, z } = view.cursor;
  // mm offsets from the volume center along each plane's own axis,
  // signed toward R / A / S (the positive NIfTI directions)
  const mm = (i, n, s) => ((i - n / 2) * s).toFixed(1);
  $('idx-axial').textContent = `S ${mm(z, nz, sz)} mm · ${z + 1}/${nz}`;
  $('idx-sagittal').textContent = `R ${mm(x, nx, sx)} mm · ${x + 1}/${nx}`;
  $('idx-coronal').textContent = `A ${mm(y, ny, sy)} mm · ${y + 1}/${ny}`;
  $('slider-axial').value = z;
  $('slider-sagittal').value = x;
  $('slider-coronal').value = y;
  $('readout-wl').textContent = `W ${view.window} · L ${view.level}`;
}

function setCursor(x, y, z) {
  const [nx, ny, nz] = app.ct.dims;
  view.cursor.x = Math.max(0, Math.min(nx - 1, x));
  view.cursor.y = Math.max(0, Math.min(ny - 1, y));
  view.cursor.z = Math.max(0, Math.min(nz - 1, z));
  for (const k of ['axial', 'sagittal', 'coronal']) applyZoom(k);
  renderAll();
}

// CSS-transform zoom about the crosshair, so zooming follows the cursor and
// clicking near an edge pans the magnified region there. Hit-testing needs no
// changes: voxelFromEvent maps through getBoundingClientRect proportions,
// which already reflect the transform.
function applyZoom(key) {
  const v = views[key];
  if (!v) return;
  const z = view.zoom[key];
  if (z <= 1) {
    v.canvas.style.transform = '';
    v.canvas.style.transformOrigin = '';
    return;
  }
  const { dx, row } = crosshairDisp(key);
  v.canvas.style.transformOrigin =
    `${(dx + 0.5) / v.w * 100}% ${(row + 0.5) / v.h * 100}%`;
  v.canvas.style.transform = `scale(${z})`;
}

function setWindowLevel(w, l) {
  view.window = Math.max(1, Math.round(w));
  view.level = Math.round(l);
  $('win-slider').value = view.window; $('win-val').textContent = view.window;
  $('lev-slider').value = view.level;  $('lev-val').textContent = view.level;
  for (const b of $('presets').children)
    b.classList.toggle('active',
      +b.dataset.w === view.window && +b.dataset.l === view.level);
  renderAll();
}

function showReadout(key, vox) {
  const { x, y, z } = vox;
  const hu = Math.round(huAt(x, y, z));
  const [nx, ny] = app.ct.dims;
  const label = app.labels[x + nx * (y + ny * z)];
  $('readout-pos').textContent =
    `${key} · (${x}, ${y}, ${z}) · ${hu} HU` + (label ? ` · ${lutName[label]}` : '');
}

function buildLegend() {
  const legend = $('legend');
  legend.innerHTML = '';
  for (const s of app.structures) {
    const row = document.createElement('label');
    row.className = 'legend-row';
    row.innerHTML = `<input type="checkbox" ${s.visible ? 'checked' : ''}>
      <span class="swatch" style="background: rgb(${s.color})"></span>
      <span>${s.name}</span><span class="count">${s.voxels.toLocaleString()}</span>`;
    row.querySelector('input').addEventListener('change', e => {
      s.visible = e.target.checked;
      lutVis[s.labelValue] = s.visible ? 1 : 0;
      renderAll();
    });
    legend.appendChild(row);
  }
}

function setAllVisible(on) {
  for (const s of app.structures) { s.visible = on; lutVis[s.labelValue] = on ? 1 : 0; }
  for (const cb of $('legend').querySelectorAll('input')) cb.checked = on;
  renderAll();
}

/* ===================================================================
 * 6. 3D view — surface point splatting with a z-buffer, no libraries
 *
 * The label volume is scanned once for surface voxels (any of the 6
 * neighbors differs). Each keeps a position in centered mm space, its
 * label, and an outward normal estimated from which neighbors are empty.
 * Per frame: rotate (turntable yaw + pitch), orthographic project, and
 * splat into an ImageData with a Float32 z-buffer for occlusion. Shading
 * is a headlight lambert — the light direction is rotated instead of the
 * 180k normals, so the per-point cost stays at one dot product.
 * =================================================================== */

const r3 = { yaw: -0.55, pitch: -0.38, zoom: 1, canvasSize: 560 };
let zbuf = null, img3d = null;

function buildSurfaceCloud() {
  const { labels } = app;
  const [nx, ny, nz] = app.ct.dims;
  const [sx, sy, sz] = app.ct.spacing;
  const cxm = nx / 2, cym = ny / 2, czm = nz / 2;

  const px = [], py = [], pz = [], pnx = [], pny = [], pnz = [], plab = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) {
        const l = labels[base + x];
        if (!l) continue;
        // empty(d) = 1 when the neighbor in direction d is background/other
        const exm = x === 0      || labels[base + x - 1] !== l ? 1 : 0;
        const exp_ = x === nx - 1 || labels[base + x + 1] !== l ? 1 : 0;
        const eym = y === 0      || labels[base + x - nx] !== l ? 1 : 0;
        const eyp = y === ny - 1 || labels[base + x + nx] !== l ? 1 : 0;
        const ezm = z === 0      || labels[base + x - nx * ny] !== l ? 1 : 0;
        const ezp = z === nz - 1 || labels[base + x + nx * ny] !== l ? 1 : 0;
        if (!(exm | exp_ | eym | eyp | ezm | ezp)) continue;  // interior
        px.push((x - cxm) * sx);
        py.push((y - cym) * sy);
        pz.push((z - czm) * sz);
        // outward normal from empty-neighbor directions (normalized below)
        let vx = exp_ - exm, vy = eyp - eym, vzn = ezp - ezm;
        const len = Math.hypot(vx, vy, vzn) || 1;
        pnx.push(vx / len); pny.push(vy / len); pnz.push(vzn / len);
        plab.push(l);
      }
    }
  }
  let maxR = 0;
  for (let i = 0; i < px.length; i++) {
    const r = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
    if (r > maxR) maxR = r;
  }
  app.cloud = {
    count: px.length,
    x: Float32Array.from(px), y: Float32Array.from(py), z: Float32Array.from(pz),
    nx: Float32Array.from(pnx), ny: Float32Array.from(pny), nz: Float32Array.from(pnz),
    label: Uint8Array.from(plab),
    radius: Math.sqrt(maxR),
  };
}

function render3D() {
  const c = app.cloud;
  if (!c) return;
  const W = r3.canvasSize, H = r3.canvasSize;
  const canvas = $('canvas-3d');
  if (canvas.width !== W) {
    canvas.width = W; canvas.height = H;
    zbuf = new Float32Array(W * H);
    img3d = canvas.getContext('2d').createImageData(W, H);
  }
  if (c.count === 0) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#888';
    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No segmentation masks loaded', W / 2, H / 2 - 8);
    ctx.fillText('3D renders organ surfaces from masks', W / 2, H / 2 + 14);
    return;
  }

  const px = img3d.data;
  px.fill(0);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;  // opaque black
  zbuf.fill(Infinity);

  const cosA = Math.cos(r3.yaw), sinA = Math.sin(r3.yaw);
  const cosB = Math.cos(r3.pitch), sinB = Math.sin(r3.pitch);
  const scale = (0.46 * W) / c.radius * r3.zoom;
  const cxs = W / 2, cys = H / 2;

  // Headlight: rotate the light into world space once, instead of rotating
  // every point's normal per frame. Viewer looks along -depth, so the light
  // in view space is (0, -1, 0) run through the inverse rotation.
  const lx = -(-sinA * cosB), ly = -(cosA * cosB), lz = -(-sinB);

  // Splat size tracks the projected inter-slice gap (2.5 mm z-spacing is ~3x
  // the in-plane spacing) so organ surfaces stay closed instead of banding.
  const maxSpacing = Math.max(...app.ct.spacing);
  const splat = Math.max(2, Math.min(5, Math.ceil(scale * maxSpacing * 1.05)));
  const n = c.count;
  for (let i = 0; i < n; i++) {
    const lab = c.label[i];
    if (!lutVis[lab]) continue;
    const x = c.x[i], y = c.y[i], z = c.z[i];
    const x1 = x * cosA - y * sinA;
    const y1 = x * sinA + y * cosA;
    const y2 = y1 * cosB - z * sinB;
    const z2 = y1 * sinB + z * cosB;
    const u = (cxs - x1 * scale) | 0;      // R on screen left at yaw 0
    const v = (cys - z2 * scale) | 0;      // S at top
    if (u < 0 || u >= W - splat || v < 0 || v >= H - splat) continue;
    const depth = -y2;                     // viewer sits on the +y (anterior) side

    let shade = c.nx[i] * lx + c.ny[i] * ly + c.nz[i] * lz;
    shade = shade < 0 ? 0 : shade;
    const f = 0.45 + 0.55 * shade;
    const r = lutR[lab] * f, g = lutG[lab] * f, b = lutB[lab] * f;

    for (let dv = 0; dv < splat; dv++) {
      let o = (v + dv) * W + u;
      for (let du = 0; du < splat; du++, o++) {
        if (depth < zbuf[o]) {
          zbuf[o] = depth;
          const p = o * 4;
          px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
        }
      }
    }
  }
  canvas.getContext('2d').putImageData(img3d, 0, 0);
  $('idx-3d').textContent = `${c.count.toLocaleString()} pts`;
}

/* ===================================================================
 * 7. UI wiring — bound once at startup; initViewer() runs per load
 * =================================================================== */

function bindUI() {
  // slice-view pointer interaction: hover reads out, click/drag moves the
  // crosshair, scroll scrubs that view's own axis
  const wheelAxis = { axial: 'z', coronal: 'y', sagittal: 'x' };
  for (const key of ['axial', 'sagittal', 'coronal']) {
    const canvas = $(`canvas-${key}`);
    canvas.addEventListener('pointerdown', e => {
      if (!views[key]) return;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      const vox = voxelFromEvent(key, e);
      if (vox) setCursor(vox.x, vox.y, vox.z);
    });
    canvas.addEventListener('pointermove', e => {
      if (!views[key]) return;
      const vox = voxelFromEvent(key, e);
      if (!vox) return;
      if (e.buttons & 1) setCursor(vox.x, vox.y, vox.z);
      showReadout(key, e.buttons & 1 ? view.cursor : vox);
    });
    canvas.addEventListener('pointerleave', () => { $('readout-pos').textContent = ''; });
    canvas.addEventListener('wheel', e => {
      if (!views[key]) return;
      e.preventDefault();
      const c = { ...view.cursor };
      c[wheelAxis[key]] += Math.sign(e.deltaY);
      setCursor(c.x, c.y, c.z);
    }, { passive: false });
  }

  // 3D view: drag to orbit, scroll to zoom
  const c3 = $('canvas-3d');
  let dragging = false, lastX = 0, lastY = 0;
  c3.addEventListener('pointerdown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    c3.classList.add('dragging');
    try { c3.setPointerCapture(e.pointerId); } catch {}
  });
  c3.addEventListener('pointermove', e => {
    if (!dragging || !app.cloud) return;
    r3.yaw += (e.clientX - lastX) * 0.008;
    r3.pitch = Math.max(-1.5, Math.min(1.5, r3.pitch + (e.clientY - lastY) * 0.008));
    lastX = e.clientX; lastY = e.clientY;
    render3D();
  });
  c3.addEventListener('pointerup', () => { dragging = false; c3.classList.remove('dragging'); });
  c3.addEventListener('wheel', e => {
    if (!app.cloud) return;
    e.preventDefault();
    r3.zoom = Math.max(0.4, Math.min(4, r3.zoom * Math.exp(-e.deltaY * 0.0012)));
    render3D();
  }, { passive: false });

  // per-plane slice sliders live in the viewport headers
  $('slider-axial').addEventListener('input',
    e => setCursor(view.cursor.x, view.cursor.y, +e.target.value));
  $('slider-sagittal').addEventListener('input',
    e => setCursor(+e.target.value, view.cursor.y, view.cursor.z));
  $('slider-coronal').addEventListener('input',
    e => setCursor(view.cursor.x, +e.target.value, view.cursor.z));
  $('crosshair-toggle').addEventListener('change', e => {
    view.crosshair = e.target.checked;
    renderAll();
  });

  $('win-slider').addEventListener('input', e => setWindowLevel(+e.target.value, view.level));
  $('lev-slider').addEventListener('input', e => setWindowLevel(view.window, +e.target.value));
  const presets = $('presets');
  for (const pz of PRESETS) {
    const b = document.createElement('button');
    b.textContent = pz.name;
    b.dataset.w = pz.window; b.dataset.l = pz.level;
    b.addEventListener('click', () => setWindowLevel(pz.window, pz.level));
    presets.appendChild(b);
  }

  $('alpha-slider').addEventListener('input', e => {
    view.alpha = +e.target.value / 100;
    $('alpha-val').textContent = `${e.target.value}%`;
    renderAll();
  });
  $('all-on').addEventListener('click', () => setAllVisible(true));
  $('all-off').addEventListener('click', () => setAllVisible(false));

  for (const btn of document.querySelectorAll('.zoom-btns button')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.view;
      const f = btn.classList.contains('zoom-in') ? 1.25 : 1 / 1.25;
      if (key === '3d') {
        r3.zoom = Math.max(0.4, Math.min(4, r3.zoom * f));
        render3D();
      } else {
        view.zoom[key] = Math.max(1, Math.min(6, view.zoom[key] * f));
        applyZoom(key);
      }
    });
  }

  $('change-case').addEventListener('click', showLoader);
}

function initViewer() {
  const { ct, structures, huRange } = app;
  const [nx, ny, nz] = ct.dims;
  const [sx, sy, sz] = ct.spacing;

  $('loader').hidden = true;
  $('viewer').hidden = false;
  $('case-chip').textContent = app.caseName;
  $('case-chip').hidden = false;
  $('change-case').hidden = false;

  // Canvas grids are in voxels; CSS aspect-ratio stretches each view to its
  // true millimetre proportions (the anisotropy fix: 2.5 mm slices vs
  // 0.816 mm in-plane would otherwise squash coronal/sagittal ~3x).
  const defs = [
    { key: 'axial',    w: nx, h: ny, mmW: nx * sx, mmH: ny * sy },
    { key: 'sagittal', w: ny, h: nz, mmW: ny * sy, mmH: nz * sz },
    { key: 'coronal',  w: nx, h: nz, mmW: nx * sx, mmH: nz * sz },
  ];
  view.zoom = { axial: 1, sagittal: 1, coronal: 1 };
  r3.zoom = 1;
  for (const d of defs) {
    const canvas = $(`canvas-${d.key}`);
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    canvas.width = d.w; canvas.height = d.h;
    canvas.style.aspectRatio = `${d.mmW} / ${d.mmH}`;
    const ctx = canvas.getContext('2d');
    views[d.key] = { key: d.key, canvas, ctx, w: d.w, h: d.h,
                     imageData: ctx.createImageData(d.w, d.h) };
  }
  rebuildLuts();
  buildLegend();

  $('volume-meta').innerHTML =
    `${ct.filename} · ${ct.datatypeLabel}<br>` +
    `${nx} × ${ny} × ${nz} voxels<br>` +
    `${sx.toFixed(3)} × ${sy.toFixed(3)} × ${sz.toFixed(3)} mm/voxel<br>` +
    `HU ${huRange[0].toFixed(0)} to ${huRange[1].toFixed(0)} · ` +
    `${structures.length} structures`;

  $('slider-axial').max = nz - 1;
  $('slider-sagittal').max = nx - 1;
  $('slider-coronal').max = ny - 1;
  $('alpha-slider').value = Math.round(view.alpha * 100);
  $('alpha-val').textContent = `${Math.round(view.alpha * 100)}%`;

  view.cursor = { x: nx >> 1, y: ny >> 1, z: nz >> 1 };
  setWindowLevel(400, 40);   // abdomen preset; also triggers the first render
}

bindUI();
