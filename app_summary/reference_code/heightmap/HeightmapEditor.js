/**
 * HeightmapEditor — Part 1: load an image and turn it into a normalized,
 * single-channel height buffer (Float32Array, 0..1) with non-destructive tonal
 * adjustments and a live preview.
 *
 * Approach decision: decode with a 2D canvas (one drawImage), cache the source
 * luminance once, then run the tonal pipeline per-pixel in plain JS into a
 * Float32Array. No WebGL pass, no extra deps.
 *   - We need a CPU float buffer anyway (the projector samples it per vertex), so
 *     a shader pass would just force a GPU->CPU readback. Per-pixel JS gives us
 *     the buffer directly.
 *   - At <=1024px the whole pipeline is a few ms; debounce slider changes and it
 *     stays responsive. `process()` is pure (src luminance in, out buffer out),
 *     so adjustments never compound — re-run from the cached source every time.
 */

const REC709 = [0.2126, 0.7152, 0.0722]; // luminance weights (desaturate colour)

export class HeightmapEditor {
  constructor({ maxSize = 1024 } = {}) {
    this.maxSize = maxSize;          // longest-edge cap for the working buffer
    this.width = 0;
    this.height = 0;
    this.srcLum = null;              // Float32Array, source luminance 0..1 (immutable after load)
    this.out = null;                 // Float32Array, processed height 0..1 (what Part 2 samples)
    this.previewCanvas = null;       // optional <canvas> to paint the preview into
    this.onChange = null;            // callback(out, width, height) after every process()

    // non-destructive adjustment params (see _tone() for the exact pipeline/order)
    this.params = {
      black: 0, white: 1,            // input level remap (clamp/stretch)
      brightness: 0,                 // "lights": additive offset, -1..1
      contrast: 1,                   // multiplier around mid-grey, 0..2 (1 = none)
      shadows: 0, highlights: 0,     // tonal lift/cut, -1..1 each
      invert: false,
    };
  }

  /** Decode a File / Blob / URL / HTMLImageElement into the cached luminance buffer. */
  async load(source) {
    const img = await toImage(source);
    // fit into maxSize while keeping aspect; round to >=1px
    const scale = Math.min(1, this.maxSize / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (data[p] * REC709[0] + data[p + 1] * REC709[1] + data[p + 2] * REC709[2]) / 255;
    }
    this.width = w; this.height = h;
    this.srcLum = lum;
    this.out = new Float32Array(w * h);
    this.process();
    return this;
  }

  /** Patch params and re-run the pipeline. Call from slider handlers (debounced). */
  setParams(patch) {
    Object.assign(this.params, patch);
    this.process();
  }

  /** Run the tonal pipeline src -> out (pure; always from the cached source). */
  process() {
    if (!this.srcLum) return;
    const p = this.params, src = this.srcLum, out = this.out;
    const invBW = 1 / Math.max(1e-4, p.white - p.black); // black/white remap denom
    for (let i = 0; i < src.length; i++) {
      out[i] = this._tone(src[i], p, invBW);
    }
    this._paintPreview();
    this.onChange?.(out, this.width, this.height);
  }

  /** Single-pixel tonal transform. Documented order; everything clamps 0..1 at the end. */
  _tone(L, p, invBW) {
    // 1) input levels: remap [black,white] -> [0,1]
    L = (L - p.black) * invBW;
    L = L < 0 ? 0 : L > 1 ? 1 : L;
    // 2) shadows / highlights: weighted lift or cut of the dark / light ends
    const ws = (1 - L) * (1 - L);    // weight concentrated in shadows
    const wh = L * L;                // weight concentrated in highlights
    L += p.shadows * ws + p.highlights * wh;
    // 3) contrast around mid-grey, then brightness ("lights") as an offset
    L = (L - 0.5) * p.contrast + 0.5 + p.brightness;
    // 4) invert
    if (p.invert) L = 1 - L;
    // 5) clamp to the 0..1 height range
    return L < 0 ? 0 : L > 1 ? 1 : L;
  }

  /** Attach a <canvas> to receive the live preview (sized to the buffer). */
  setPreviewCanvas(canvas) {
    this.previewCanvas = canvas;
    this._paintPreview();
  }

  _paintPreview() {
    const c = this.previewCanvas;
    if (!c || !this.out) return;
    c.width = this.width; c.height = this.height;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.width, this.height);
    const d = img.data, out = this.out;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const v = (out[i] * 255) | 0;
      d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** Normalize the many accepted source types into a decoded HTMLImageElement. */
function toImage(source) {
  if (source instanceof HTMLImageElement && source.complete) return Promise.resolve(source);
  return new Promise((resolve, reject) => {
    const url = (source instanceof Blob) ? URL.createObjectURL(source) : source;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (source instanceof Blob) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { if (source instanceof Blob) URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
