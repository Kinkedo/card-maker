// Card Composer (AI cutout) - Vanilla JS
// Uses Transformers.js (UMD build) + briaai/RMBG-1.4
// NOTE: This is a practical starter. Depending on the Transformers.js output schema,
// you may want to tweak mask handling for best results on your device/model.

const $ = (sel) => document.querySelector(sel);

const els = {
  frameInput: $('#frameInput'),
  charInput: $('#charInput'),
  useDemoFrame: $('#useDemoFrame'),
  openCamera: $('#openCamera'),
  startCam: $('#startCam'),
  snap: $('#snap'),
  stopCam: $('#stopCam'),
  video: $('#video'),

  srcCanvas: $('#srcCanvas'),
  prepCanvas: $('#prepCanvas'),
  cutCanvas: $('#cutCanvas'),

  runCutout: $('#runCutout'),
  cancelRun: $('#cancelRun'),
  deviceSelect: $('#deviceSelect'),
  inferSize: $('#inferSize'),

  brightness: $('#brightness'),
  contrast: $('#contrast'),
  gamma: $('#gamma'),
  sharpen: $('#sharpen'),
  bgNormalize: $('#bgNormalize'),
  autoCrop: $('#autoCrop'),
  applyPrep: $('#applyPrep'),
  resetPrep: $('#resetPrep'),
  bVal: $('#bVal'),
  cVal: $('#cVal'),
  gVal: $('#gVal'),
  sVal: $('#sVal'),

  composeCanvas: $('#composeCanvas'),
  fitToFrame: $('#fitToFrame'),
  centerChar: $('#centerChar'),
  flipH: $('#flipH'),
  exportPng: $('#exportPng'),
  shareBtn: $('#shareBtn'),
  downloadLink: $('#downloadLink'),

  log: $('#log'),
};

const ctxSrc = els.srcCanvas.getContext('2d');
const ctxPrep = els.prepCanvas.getContext('2d');
const ctxCut = els.cutCanvas.getContext('2d');
const ctxComp = els.composeCanvas.getContext('2d');

let frameImg = null;
let srcImg = null;

let prepBitmap = null;     // ImageBitmap of preprocessed char image (resized/cropped)
let cutoutCanvas = null;   // Offscreen canvas holding RGBA cutout

let segmenter = null;
let abortController = null;

const state = {
  // transform applied to cutout when drawing on compose canvas
  tx: 0,
  ty: 0,
  scale: 1,
  rotation: 0,
  flipX: false,
};

// -------------------------- logging --------------------------
function log(msg) {
  const t = new Date().toLocaleTimeString();
  els.log.textContent += `[${t}] ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}
function setEnabled(el, v) { el.disabled = !v; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// -------------------------- image loading --------------------------
async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // keep url until decode ok
  }
}

function drawContain(ctx, img, w, h, bg = '#0b0f14') {
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = bg;
  ctx.fillRect(0,0,w,h);
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function makeDemoFrame() {
  // Simple demo frame (placeholder) so the app can be tested immediately.
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d');

  // background gradient
  const grad = g.createLinearGradient(0,0,0,c.height);
  grad.addColorStop(0, '#162033');
  grad.addColorStop(1, '#0b0f14');
  g.fillStyle = grad;
  g.fillRect(0,0,c.width,c.height);

  // frame border
  g.strokeStyle = '#d9e7ff';
  g.lineWidth = 14;
  g.strokeRect(30, 30, c.width-60, c.height-60);

  // inner border
  g.strokeStyle = '#2b3a52';
  g.lineWidth = 6;
  g.strokeRect(55, 55, c.width-110, c.height-110);

  // title plate
  g.fillStyle = 'rgba(232,238,247,0.9)';
  g.fillRect(80, 80, c.width-160, 90);
  g.fillStyle = '#0b0f14';
  g.font = '700 42px system-ui, sans-serif';
  g.fillText('DEMO CARD', 110, 140);

  // foot text
  g.fillStyle = 'rgba(169,182,200,0.9)';
  g.font = '600 22px system-ui, sans-serif';
  g.fillText('Upload your frame image to replace this.', 110, c.height - 90);

  const img = new Image();
  img.src = c.toDataURL('image/png');
  return img;
}

// -------------------------- preprocessing --------------------------
function applyPreprocessFromUI() {
  if (!srcImg) return;
  const b = parseInt(els.brightness.value, 10);
  const c = parseInt(els.contrast.value, 10);
  const g = parseInt(els.gamma.value, 10) / 100;
  const sharp = parseInt(els.sharpen.value, 10) / 100;
  const normalize = els.bgNormalize.checked;
  const autoCrop = els.autoCrop.checked;

  els.bVal.textContent = String(b);
  els.cVal.textContent = String(c);
  els.gVal.textContent = g.toFixed(2);
  els.sVal.textContent = sharp.toFixed(2);

  // work canvas
  const maxSide = 1400; // for preprocessing preview; final infer size handled later
  const s = Math.min(1, maxSide / Math.max(srcImg.width, srcImg.height));
  const w0 = Math.round(srcImg.width * s);
  const h0 = Math.round(srcImg.height * s);

  const c0 = document.createElement('canvas');
  c0.width = w0; c0.height = h0;
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  x0.drawImage(srcImg, 0, 0, w0, h0);

  // optional background normalization (remove lighting gradient)
  if (normalize) {
    const blur = document.createElement('canvas');
    blur.width = w0; blur.height = h0;
    const xb = blur.getContext('2d', { willReadFrequently: true });
    xb.drawImage(c0, 0, 0);

    // cheap blur via multiple passes
    xb.globalAlpha = 0.5;
    for (let i = 0; i < 6; i++) {
      const dx = (i % 3) - 1;
      const dy = Math.floor(i / 3) - 1;
      xb.drawImage(blur, dx*6, dy*6);
    }
    xb.globalAlpha = 1;

    const im = x0.getImageData(0,0,w0,h0);
    const bm = xb.getImageData(0,0,w0,h0);
    const d = im.data;
    const bd = bm.data;
    for (let i=0; i<d.length; i+=4) {
      // subtract blurred (background) and re-center
      d[i]   = clamp(d[i]   - (bd[i]   - 128), 0, 255);
      d[i+1] = clamp(d[i+1] - (bd[i+1] - 128), 0, 255);
      d[i+2] = clamp(d[i+2] - (bd[i+2] - 128), 0, 255);
    }
    x0.putImageData(im, 0, 0);
  }

  // brightness/contrast + gamma
  const im = x0.getImageData(0,0,w0,h0);
  const d = im.data;

  // contrast formula (simple)
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const bf = b;

  for (let i=0; i<d.length; i+=4) {
    let r = d[i], gg = d[i+1], bb = d[i+2];

    r = clamp(cf * (r - 128) + 128 + bf, 0, 255);
    gg = clamp(cf * (gg - 128) + 128 + bf, 0, 255);
    bb = clamp(cf * (bb - 128) + 128 + bf, 0, 255);

    // gamma correction
    r = clamp(255 * Math.pow(r/255, 1/g), 0, 255);
    gg = clamp(255 * Math.pow(gg/255, 1/g), 0, 255);
    bb = clamp(255 * Math.pow(bb/255, 1/g), 0, 255);

    d[i] = r; d[i+1] = gg; d[i+2] = bb;
  }
  x0.putImageData(im, 0, 0);

  // unsharp mask (simple) for edges
  if (sharp > 0.001) {
    const blurred = document.createElement('canvas');
    blurred.width = w0; blurred.height = h0;
    const xb = blurred.getContext('2d', { willReadFrequently: true });
    xb.drawImage(c0, 0, 0); // start with original, but we'll blur current c0
    xb.clearRect(0,0,w0,h0);
    xb.drawImage(c0, 0, 0); // not used
    xb.clearRect(0,0,w0,h0);
    xb.drawImage(c0,0,0);

    // blur the processed c0 by drawing it with offsets
    xb.clearRect(0,0,w0,h0);
    xb.globalAlpha = 0.25;
    xb.drawImage(c0, -2, 0);
    xb.drawImage(c0, 2, 0);
    xb.drawImage(c0, 0, -2);
    xb.drawImage(c0, 0, 2);
    xb.globalAlpha = 1;

    const a = x0.getImageData(0,0,w0,h0);
    const b2 = xb.getImageData(0,0,w0,h0);
    const ad = a.data, bd = b2.data;
    const amount = sharp * 1.8;
    for (let i=0; i<ad.length; i+=4) {
      ad[i]   = clamp(ad[i]   + (ad[i]   - bd[i])   * amount, 0, 255);
      ad[i+1] = clamp(ad[i+1] + (ad[i+1] - bd[i+1]) * amount, 0, 255);
      ad[i+2] = clamp(ad[i+2] + (ad[i+2] - bd[i+2]) * amount, 0, 255);
    }
    x0.putImageData(a,0,0);
  }

  // auto-crop by content (simple threshold on luminance variance)
  let crop = { x:0,y:0,w:w0,h:h0 };
  if (autoCrop) {
    const imgD = x0.getImageData(0,0,w0,h0).data;
    const thresh = 16; // edge/background difference
    let minX=w0, minY=h0, maxX=0, maxY=0;

    // estimate background as median of borders (use few samples)
    function lumAt(px,py){
      const idx = (py*w0+px)*4;
      const r=imgD[idx], g=imgD[idx+1], b=imgD[idx+2];
      return 0.2126*r + 0.7152*g + 0.0722*b;
    }
    const samples = [];
    for (let i=0;i<50;i++){
      const px = Math.floor((i/49)*(w0-1));
      samples.push(lumAt(px,0), lumAt(px,h0-1));
      const py = Math.floor((i/49)*(h0-1));
      samples.push(lumAt(0,py), lumAt(w0-1,py));
    }
    samples.sort((a,b)=>a-b);
    const bg = samples[Math.floor(samples.length/2)];

    for (let y=0;y<h0;y+=2){
      for (let x=0;x<w0;x+=2){
        const l = lumAt(x,y);
        if (Math.abs(l - bg) > thresh){
          if (x<minX) minX=x;
          if (y<minY) minY=y;
          if (x>maxX) maxX=x;
          if (y>maxY) maxY=y;
        }
      }
    }
    if (maxX>minX && maxY>minY){
      const pad = 18;
      minX = clamp(minX-pad,0,w0-1);
      minY = clamp(minY-pad,0,h0-1);
      maxX = clamp(maxX+pad,0,w0-1);
      maxY = clamp(maxY+pad,0,h0-1);
      crop = { x:minX, y:minY, w:(maxX-minX+1), h:(maxY-minY+1) };
    }
  }

  // finalize prep canvas for preview (square)
  const out = document.createElement('canvas');
  out.width = crop.w; out.height = crop.h;
  out.getContext('2d').drawImage(c0, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

  // show preview (contain in thumb canvas)
  drawContain(ctxPrep, out, els.prepCanvas.width, els.prepCanvas.height, '#0b0f14');

  // store for later (bitmap)
  prepBitmap = out;
  redrawCompose();
  return out;
}

function resetPreprocessUI() {
  els.brightness.value = 0;
  els.contrast.value = 20;
  els.gamma.value = 110;
  els.sharpen.value = 35;
  els.bgNormalize.checked = true;
  els.autoCrop.checked = true;
  applyPreprocessFromUI();
}

// -------------------------- AI cutout (RMBG) --------------------------
async function ensureSegmenter() {
  if (segmenter) return segmenter;

  const T = window.transformers;
  if (!T) throw new Error('Transformers.js が読み込めませんでした。ネットワーク/HTTPS を確認してください。');

  // Some sensible defaults for browser usage
  // (These are safe even if ignored by current version.)
  try {
    T.env.allowLocalModels = false;
  } catch {}

  const deviceSel = els.deviceSelect.value;
  const device = deviceSel === 'auto' ? undefined : deviceSel;

  log('モデルを読み込み中…（初回は時間がかかります）');
  // Use image-segmentation pipeline with RMBG model
  // Depending on runtime, device:'webgpu' may be faster if supported.
  segmenter = await T.pipeline('image-segmentation', 'briaai/RMBG-1.4', {
    ...(device ? { device } : {}),
  });

  log('モデル準備OK');
  return segmenter;
}

async function runCutout() {
  if (!srcImg || !prepBitmap) return;

  setEnabled(els.runCutout, false);
  setEnabled(els.cancelRun, true);

  abortController = new AbortController();

  try {
    const inferSide = parseInt(els.inferSize.value, 10);

    // resize prepBitmap to inference size (keep aspect)
    const inC = document.createElement('canvas');
    const s = Math.min(1, inferSide / Math.max(prepBitmap.width, prepBitmap.height));
    const w = Math.max(8, Math.round(prepBitmap.width * s));
    const h = Math.max(8, Math.round(prepBitmap.height * s));
    inC.width = w; inC.height = h;
    inC.getContext('2d').drawImage(prepBitmap, 0, 0, w, h);

    const seg = await ensureSegmenter();

    log(`推論開始（${w}x${h}）…`);
    const result = await seg(inC, { signal: abortController.signal });

    // Normalize output to a mask canvas (0..255 alpha)
    // Transformers.js image-segmentation output commonly is an array of segments.
    // RMBG typically returns a single mask.
    const maskCanvas = await outputToMaskCanvas(result, w, h);

    // Create RGBA cutout: original (inC) with alpha from mask
    cutoutCanvas = document.createElement('canvas');
    cutoutCanvas.width = w; cutoutCanvas.height = h;
    const gx = cutoutCanvas.getContext('2d', { willReadFrequently:true });
    gx.drawImage(inC,0,0);
    const im = gx.getImageData(0,0,w,h);
    const md = maskCanvas.getContext('2d', { willReadFrequently:true }).getImageData(0,0,w,h).data;
    const d = im.data;
    for (let i=0;i<d.length;i+=4){
      d[i+3] = md[i]; // use R channel as alpha
    }
    gx.putImageData(im,0,0);

    // show cutout preview (contain)
    drawContain(ctxCut, cutoutCanvas, els.cutCanvas.width, els.cutCanvas.height, '#0b0f14');

    // enable compose tools
    setEnabled(els.fitToFrame, true);
    setEnabled(els.centerChar, true);
    setEnabled(els.flipH, true);
    setEnabled(els.exportPng, true);
    setEnabled(els.shareBtn, !!navigator.share);

    // reset transform roughly
    state.scale = 1;
    state.rotation = 0;
    state.flipX = false;
    state.tx = els.composeCanvas.width / 2;
    state.ty = els.composeCanvas.height / 2;

    redrawCompose();
    log('切り抜き完了');
  } catch (e) {
    if (e?.name === 'AbortError') {
      log('キャンセルしました');
    } else {
      console.error(e);
      log(`エラー: ${e?.message ?? e}`);
      log('ヒント: iOS/古い端末で重い場合は「推論サイズ」を512、デバイスをwasmにして試してください。');
    }
  } finally {
    abortController = null;
    setEnabled(els.runCutout, !!srcImg);
    setEnabled(els.cancelRun, false);
  }
}

async function outputToMaskCanvas(result, w, h) {
  // Try several known shapes of transformers.js segmentation outputs.
  // Return a canvas where mask is in RGB (same value) and alpha=255.

  // 1) Array of segments with .mask (RawImage)
  if (Array.isArray(result) && result.length) {
    const item = result[0];
    if (item?.mask) {
      return await rawImageToCanvas(item.mask, w, h);
    }
    if (item?.segmentation) {
      return await rawImageToCanvas(item.segmentation, w, h);
    }
    if (item?.data) {
      return dataToMaskCanvas(item.data, w, h);
    }
  }

  // 2) Direct object with .mask
  if (result?.mask) {
    return await rawImageToCanvas(result.mask, w, h);
  }
  if (result?.segmentation) {
    return await rawImageToCanvas(result.segmentation, w, h);
  }
  if (result?.data) {
    return dataToMaskCanvas(result.data, w, h);
  }

  // 3) Fallback: if it's already ImageData-like
  if (result instanceof ImageData) {
    const c = document.createElement('canvas');
    c.width = result.width; c.height = result.height;
    c.getContext('2d').putImageData(result,0,0);
    return c;
  }

  throw new Error('セグメンテーション出力の形式が想定外でした。script.js の outputToMaskCanvas を調整してください。');
}

async function rawImageToCanvas(raw, w, h) {
  // Transformers.js RawImage has .toCanvas() in many builds; otherwise may expose .data
  const c = document.createElement('canvas');

  // If toCanvas exists, use it.
  if (typeof raw?.toCanvas === 'function') {
    const out = await raw.toCanvas();
    c.width = out.width; c.height = out.height;
    c.getContext('2d').drawImage(out,0,0);
    // ensure size
    if (c.width !== w || c.height !== h) {
      const r = document.createElement('canvas');
      r.width = w; r.height = h;
      r.getContext('2d').drawImage(c, 0, 0, w, h);
      return r;
    }
    return c;
  }

  // If it looks like typed array
  if (raw?.data && raw?.width && raw?.height) {
    return dataToMaskCanvas(raw.data, raw.width, raw.height, w, h);
  }

  throw new Error('RawImage をCanvasに変換できませんでした。');
}

function dataToMaskCanvas(data, inW, inH, outW = inW, outH = inH) {
  // data may be float 0..1 or 0..255
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const x = c.getContext('2d', { willReadFrequently: true });

  // build ImageData at inW/inH then scale if needed
  const tmp = document.createElement('canvas');
  tmp.width = inW; tmp.height = inH;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  const im = tctx.createImageData(inW, inH);
  const d = im.data;

  const n = inW * inH;
  for (let i=0;i<n;i++){
    let v = data[i];
    if (v <= 1.001) v = v * 255;
    v = clamp(Math.round(v),0,255);
    const j = i*4;
    d[j] = v; d[j+1]=v; d[j+2]=v; d[j+3]=255;
  }
  tctx.putImageData(im,0,0);

  if (outW !== inW || outH !== inH) {
    x.drawImage(tmp, 0,0,outW,outH);
  } else {
    x.drawImage(tmp,0,0);
  }
  return c;
}

// -------------------------- composition canvas --------------------------
function redrawCompose() {
  const W = els.composeCanvas.width;
  const H = els.composeCanvas.height;

  ctxComp.clearRect(0,0,W,H);
  ctxComp.fillStyle = '#0b0f14';
  ctxComp.fillRect(0,0,W,H);

  // draw frame as base
  if (frameImg) {
    ctxComp.drawImage(frameImg, 0, 0, W, H);
  } else {
    // placeholder
    ctxComp.fillStyle = '#111a27';
    ctxComp.fillRect(0,0,W,H);
    ctxComp.fillStyle = '#a9b6c8';
    ctxComp.font = '700 28px system-ui';
    ctxComp.fillText('Load frame image', 40, 80);
  }

  // draw cutout
  if (cutoutCanvas) {
    const img = cutoutCanvas;

    ctxComp.save();
    ctxComp.translate(state.tx, state.ty);
    ctxComp.rotate(state.rotation);
    ctxComp.scale(state.scale * (state.flipX ? -1 : 1), state.scale);
    ctxComp.translate(-img.width/2, -img.height/2);
    ctxComp.drawImage(img, 0, 0);
    ctxComp.restore();
  }
}

function fitCharToFrame() {
  if (!cutoutCanvas) return;
  const W = els.composeCanvas.width;
  const H = els.composeCanvas.height;

  const margin = 120; // leave borders
  const targetW = W - margin*2;
  const targetH = H - margin*2;

  const s = Math.min(targetW / cutoutCanvas.width, targetH / cutoutCanvas.height);
  state.scale = s;
  state.rotation = 0;
  state.tx = W/2;
  state.ty = H/2 + 40;
  redrawCompose();
}

function centerChar() {
  const W = els.composeCanvas.width;
  const H = els.composeCanvas.height;
  state.tx = W/2;
  state.ty = H/2;
  redrawCompose();
}

function flipHorizontal() {
  state.flipX = !state.flipX;
  redrawCompose();
}

// -------------------------- pointer gestures --------------------------
const pointers = new Map();
let gesture = null;

els.composeCanvas.addEventListener('pointerdown', (e) => {
  els.composeCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    gesture = {
      type: 'drag',
      startX: p.x,
      startY: p.y,
      startTx: state.tx,
      startTy: state.ty,
    };
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    gesture = makePinchGesture(p1, p2);
  }
});

els.composeCanvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !cutoutCanvas) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1 && gesture?.type === 'drag') {
    const p = [...pointers.values()][0];
    const dx = p.x - gesture.startX;
    const dy = p.y - gesture.startY;
    state.tx = gesture.startTx + dx;
    state.ty = gesture.startTy + dy;
    redrawCompose();
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    if (!gesture || gesture.type !== 'pinch') gesture = makePinchGesture(p1, p2);

    const cur = pinchMetrics(p1, p2);
    const scaleMul = cur.dist / gesture.startDist;
    const rotDelta = cur.ang - gesture.startAng;

    state.scale = clamp(gesture.startScale * scaleMul, 0.05, 30);
    state.rotation = gesture.startRot + rotDelta;

    // translate by centroid delta
    state.tx = gesture.startTx + (cur.cx - gesture.startCx);
    state.ty = gesture.startTy + (cur.cy - gesture.startCy);

    redrawCompose();
  }
});

els.composeCanvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    gesture = {
      type: 'drag',
      startX: p.x,
      startY: p.y,
      startTx: state.tx,
      startTy: state.ty,
    };
  } else if (pointers.size === 0) {
    gesture = null;
  }
});

els.composeCanvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) gesture = null;
});

function pinchMetrics(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  return { dist, ang, cx, cy };
}
function makePinchGesture(p1, p2) {
  const m = pinchMetrics(p1, p2);
  return {
    type: 'pinch',
    startDist: m.dist,
    startAng: m.ang,
    startCx: m.cx,
    startCy: m.cy,
    startScale: state.scale,
    startRot: state.rotation,
    startTx: state.tx,
    startTy: state.ty,
  };
}

// -------------------------- export / share --------------------------
function exportPNG() {
  const a = els.downloadLink;
  els.composeCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, 'image/png');
}

async function shareImage() {
  if (!navigator.share) {
    log('この端末は共有APIに未対応です。');
    return;
  }
  const blob = await new Promise((resolve) => els.composeCanvas.toBlob(resolve, 'image/png'));
  if (!blob) return;

  const file = new File([blob], 'card.png', { type: 'image/png' });
  try {
    await navigator.share({ files: [file], title: 'card', text: 'カード画像' });
    log('共有しました（写真に保存を選べる端末もあります）');
  } catch (e) {
    log('共有をキャンセルしました');
  }
}

// -------------------------- camera --------------------------
let mediaStream = null;

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    els.video.srcObject = mediaStream;
    await els.video.play();
    setEnabled(els.snap, true);
    setEnabled(els.stopCam, true);
    log('カメラ開始');
  } catch (e) {
    log(`カメラ起動失敗: ${e?.message ?? e}`);
  }
}

function stopCamera() {
  if (!mediaStream) return;
  mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  els.video.srcObject = null;
  setEnabled(els.snap, false);
  setEnabled(els.stopCam, false);
  log('カメラ停止');
}

async function snapCamera() {
  if (!els.video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = els.video.videoWidth;
  c.height = els.video.videoHeight;
  c.getContext('2d').drawImage(els.video, 0, 0);
  const img = new Image();
  img.src = c.toDataURL('image/jpeg', 0.92);
  await img.decode();
  await setCharImage(img);
}

// -------------------------- event wiring --------------------------
async function setFrameImage(img) {
  frameImg = img;

  // If frame image size differs, we will draw stretched to compose canvas size.
  redrawCompose();
  setEnabled(els.fitToFrame, !!cutoutCanvas);
  log(`枠読み込み: ${img.width}x${img.height}`);
}

async function setCharImage(img) {
  srcImg = img;

  drawContain(ctxSrc, srcImg, els.srcCanvas.width, els.srcCanvas.height, '#0b0f14');

  setEnabled(els.applyPrep, true);
  setEnabled(els.resetPrep, true);
  setEnabled(els.runCutout, true);

  // run preprocessing immediately
  applyPreprocessFromUI();

  // clear old cutout
  cutoutCanvas = null;
  ctxCut.clearRect(0,0,els.cutCanvas.width,els.cutCanvas.height);
  setEnabled(els.exportPng, false);
  setEnabled(els.shareBtn, false);
  setEnabled(els.fitToFrame, false);
  setEnabled(els.centerChar, false);
  setEnabled(els.flipH, false);

  log(`キャラ読み込み: ${img.width}x${img.height}`);
}

els.frameInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const img = await fileToImage(f);
  await setFrameImage(img);
});

els.charInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const img = await fileToImage(f);
  await setCharImage(img);
});

els.useDemoFrame.addEventListener('click', async () => {
  const img = makeDemoFrame();
  await img.decode();
  await setFrameImage(img);
});

els.openCamera.addEventListener('click', () => {
  els.charInput.click();
});

els.startCam.addEventListener('click', startCamera);
els.stopCam.addEventListener('click', stopCamera);
els.snap.addEventListener('click', snapCamera);

els.applyPrep.addEventListener('click', applyPreprocessFromUI);
els.resetPrep.addEventListener('click', resetPreprocessUI);

for (const id of ['brightness','contrast','gamma','sharpen','bgNormalize','autoCrop']) {
  els[id].addEventListener('input', () => {
    if (!srcImg) return;
    applyPreprocessFromUI();
  });
}

els.runCutout.addEventListener('click', runCutout);
els.cancelRun.addEventListener('click', () => {
  if (abortController) abortController.abort();
});

els.fitToFrame.addEventListener('click', fitCharToFrame);
els.centerChar.addEventListener('click', centerChar);
els.flipH.addEventListener('click', flipHorizontal);

els.exportPng.addEventListener('click', exportPNG);
els.shareBtn.addEventListener('click', shareImage);

// init
(async function init(){
  log('起動しました');
  const demo = makeDemoFrame();
  await demo.decode();
  await setFrameImage(demo);

  // initial values
  els.bVal.textContent = els.brightness.value;
  els.cVal.textContent = els.contrast.value;
  els.gVal.textContent = (parseInt(els.gamma.value,10)/100).toFixed(2);
  els.sVal.textContent = (parseInt(els.sharpen.value,10)/100).toFixed(2);

  // place char transform defaults
  state.tx = els.composeCanvas.width/2;
  state.ty = els.composeCanvas.height/2;

  redrawCompose();
})();
