export type HalftoneWorkerRequest =
  | {
      type: 'init-offscreen';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'load-image';
      bitmap: ImageBitmap;
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'compute-pixels';
      pixels: Uint8ClampedArray;
      gridCols: number;
      gridRows: number;
      cell: number;
      box: [number, number, number, number];
    }
  | {
      type: 'render';
      progress: number;
    }
  | {
      type: 'resize';
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'dispose';
    };

export type HalftoneWorkerResponse =
  | {
      type: 'ready';
      mode: 'offscreen' | 'buffer';
      dotCount: number;
    }
  | {
      type: 'buffers';
      xs: Float32Array;
      ys: Float32Array;
      radii: Float32Array;
      luminance: Float32Array;
      colors: Uint8Array;
      cell: number;
      box: [number, number, number, number];
    }
  | {
      type: 'error';
      message: string;
    };

interface WorkerSelf {
  postMessage(message: HalftoneWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HalftoneWorkerRequest>) => void,
  ): void;
}

const workerSelf = self as unknown as WorkerSelf;

interface HalftoneDotField {
  xs: Float32Array;
  ys: Float32Array;
  radii: Float32Array;
  luminance: Float32Array;
  colors: Uint8Array;
  cell: number;
  box: [number, number, number, number];
}

let outputCanvas: OffscreenCanvas | null = null;
let outputCtx: OffscreenCanvasRenderingContext2D | null = null;
let storedBitmap: ImageBitmap | null = null;
let dotField: HalftoneDotField | null = null;
let canvasWidth = 0;
let canvasHeight = 0;
let currentDpr = 1;
let lastProgress = -1;

function computeCoverBox(
  targetW: number,
  targetH: number,
  srcW: number,
  srcH: number,
): [number, number, number, number] {
  if (srcW <= 0 || srcH <= 0) {
    const drawH = targetH * 0.92;
    const drawW = (drawH * 2) / 3;
    return [(targetW - drawW) / 2, targetH - drawH - targetH * 0.02, drawW, drawH];
  }
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  return [(targetW - drawW) / 2, (targetH - drawH) / 2, drawW, drawH];
}

function buildDotFieldFromRgba(
  data: Uint8ClampedArray,
  cols: number,
  rows: number,
  cell: number,
  box: [number, number, number, number],
): HalftoneDotField {
  const totalCells = cols * rows;
  const luminance = new Float32Array(totalCells);

  // First pass: count visible cells & populate luminance Float32Array (0.3*R + 0.59*G + 0.11*B)
  let activeCount = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const idx = y * cols + x;
      const offset = idx * 4;
      const alpha = (data[offset + 3] ?? 0) / 255;
      const lum =
        ((data[offset] ?? 0) * 0.3 +
          (data[offset + 1] ?? 0) * 0.59 +
          (data[offset + 2] ?? 0) * 0.11) /
        255;
      luminance[idx] = lum;
      if (alpha >= 0.15) {
        activeCount += 1;
      }
    }
  }

  const xs = new Float32Array(activeCount);
  const ys = new Float32Array(activeCount);
  const radii = new Float32Array(activeCount);
  const colors = new Uint8Array(activeCount * 3);

  let writeIdx = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const idx = y * cols + x;
      const offset = idx * 4;
      const alpha = (data[offset + 3] ?? 0) / 255;
      if (alpha < 0.15) continue;

      const lum = luminance[idx] ?? 0.5;
      xs[writeIdx] = x * cell + cell * 0.5;
      ys[writeIdx] = y * cell + cell * 0.5;
      radii[writeIdx] = (0.35 + (1 - lum) * 0.65) * alpha;

      // Warm Atelier linen tint matching legacy pointillism palette
      colors[writeIdx * 3] = Math.min(255, ((data[offset] ?? 0) * 0.7 + 60) | 0);
      colors[writeIdx * 3 + 1] = Math.min(255, ((data[offset + 1] ?? 0) * 0.7 + 50) | 0);
      colors[writeIdx * 3 + 2] = Math.min(255, ((data[offset + 2] ?? 0) * 0.7 + 30) | 0);
      writeIdx += 1;
    }
  }

  return { xs, ys, radii, luminance, colors, cell, box };
}

function sampleBitmapToField(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  dpr: number,
): HalftoneDotField | null {
  if (typeof OffscreenCanvas === 'undefined' || width <= 0 || height <= 0) {
    return null;
  }

  const cell = Math.max(4, Math.round(5.5 * dpr));
  const cols = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(1, Math.floor(height / cell));
  const box = computeCoverBox(width, height, bitmap.width, bitmap.height);

  const sampleCanvas = new OffscreenCanvas(cols, rows);
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sampleCtx) {
    return null;
  }

  sampleCtx.clearRect(0, 0, cols, rows);
  sampleCtx.drawImage(
    bitmap,
    box[0] / cell,
    box[1] / cell,
    box[2] / cell,
    box[3] / cell,
  );
  const imgData = sampleCtx.getImageData(0, 0, cols, rows).data;
  return buildDotFieldFromRgba(imgData, cols, rows, cell, box);
}

function renderOffscreenFrame(progress: number, force = false): void {
  if (!outputCtx || !outputCanvas || !dotField) return;
  const clamped = Math.max(0, Math.min(1, progress));
  if (!force && Math.abs(lastProgress - clamped) < 0.004) return;
  lastProgress = clamped;

  const ctx = outputCtx;
  const w = outputCanvas.width;
  const h = outputCanvas.height;
  const [bx, by, bw, bh] = dotField.box;

  ctx.clearRect(0, 0, w, h);

  // Smoothstep photography convergence from 0.40 -> 0.85 matching legacy main.js
  const photoT = Math.max(0, Math.min(1, (clamped - 0.4) / 0.45));
  const photoAlpha = photoT * photoT * (3 - 2 * photoT);

  if (photoAlpha > 0 && storedBitmap) {
    ctx.globalAlpha = photoAlpha;
    ctx.drawImage(storedBitmap, bx, by, bw, bh);
  }

  const dotsAlpha = 1 - photoAlpha;
  if (dotsAlpha <= 0.002) {
    ctx.globalAlpha = 1;
    return;
  }

  ctx.globalAlpha = dotsAlpha;
  const { xs, ys, radii, colors, cell } = dotField;
  const scale = 0.8 + clamped * 0.9;
  const count = xs.length;

  for (let i = 0; i < count; i += 1) {
    const r = cell * 0.5 * Math.sqrt(radii[i] ?? 0) * scale;
    if (r < 0.4) continue;
    const cOff = i * 3;
    ctx.fillStyle = `rgb(${colors[cOff]},${colors[cOff + 1]},${colors[cOff + 2]})`;
    ctx.beginPath();
    ctx.arc(xs[i] ?? 0, ys[i] ?? 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

workerSelf.addEventListener('message', (event: MessageEvent<HalftoneWorkerRequest>) => {
  const msg = event.data;

  try {
    if (msg.type === 'init-offscreen') {
      outputCanvas = msg.canvas;
      canvasWidth = Math.max(1, Math.round(msg.width));
      canvasHeight = Math.max(1, Math.round(msg.height));
      currentDpr = Math.max(1, Math.min(msg.dpr, 2));
      outputCanvas.width = canvasWidth;
      outputCanvas.height = canvasHeight;
      outputCtx = outputCanvas.getContext('2d');
      return;
    }

    if (msg.type === 'load-image') {
      canvasWidth = Math.max(1, Math.round(msg.width));
      canvasHeight = Math.max(1, Math.round(msg.height));
      currentDpr = Math.max(1, Math.min(msg.dpr, 2));

      if (storedBitmap) {
        storedBitmap.close();
      }
      storedBitmap = msg.bitmap;

      const field = sampleBitmapToField(
        storedBitmap,
        canvasWidth,
        canvasHeight,
        currentDpr,
      );
      if (!field) {
        workerSelf.postMessage({
          type: 'error',
          message: 'OffscreenCanvas sampling unavailable in worker',
        });
        return;
      }

      if (outputCanvas && outputCtx) {
        outputCanvas.width = canvasWidth;
        outputCanvas.height = canvasHeight;
        dotField = field;
        renderOffscreenFrame(lastProgress < 0 ? 0 : lastProgress, true);
        workerSelf.postMessage({
          type: 'ready',
          mode: 'offscreen',
          dotCount: field.xs.length,
        });
      } else {
        // Fallback mode when transferControlToOffscreen is unavailable:
        // transfer Float32Array luminance & dot buffers back to main thread.
        storedBitmap.close();
        storedBitmap = null;
        workerSelf.postMessage(
          {
            type: 'buffers',
            xs: field.xs,
            ys: field.ys,
            radii: field.radii,
            luminance: field.luminance,
            colors: field.colors,
            cell: field.cell,
            box: field.box,
          },
          [
            field.xs.buffer,
            field.ys.buffer,
            field.radii.buffer,
            field.luminance.buffer,
            field.colors.buffer,
          ],
        );
      }
      return;
    }

    if (msg.type === 'compute-pixels') {
      const field = buildDotFieldFromRgba(
        msg.pixels,
        msg.gridCols,
        msg.gridRows,
        msg.cell,
        msg.box,
      );
      workerSelf.postMessage(
        {
          type: 'buffers',
          xs: field.xs,
          ys: field.ys,
          radii: field.radii,
          luminance: field.luminance,
          colors: field.colors,
          cell: field.cell,
          box: field.box,
        },
        [
          field.xs.buffer,
          field.ys.buffer,
          field.radii.buffer,
          field.luminance.buffer,
          field.colors.buffer,
        ],
      );
      return;
    }

    if (msg.type === 'resize') {
      canvasWidth = Math.max(1, Math.round(msg.width));
      canvasHeight = Math.max(1, Math.round(msg.height));
      currentDpr = Math.max(1, Math.min(msg.dpr, 2));
      if (outputCanvas) {
        outputCanvas.width = canvasWidth;
        outputCanvas.height = canvasHeight;
      }
      if (storedBitmap) {
        const field = sampleBitmapToField(
          storedBitmap,
          canvasWidth,
          canvasHeight,
          currentDpr,
        );
        if (field) {
          dotField = field;
          renderOffscreenFrame(lastProgress < 0 ? 0 : lastProgress, true);
        }
      }
      return;
    }

    if (msg.type === 'render') {
      renderOffscreenFrame(msg.progress, false);
      return;
    }

    if (msg.type === 'dispose') {
      if (storedBitmap) {
        storedBitmap.close();
        storedBitmap = null;
      }
      dotField = null;
      outputCtx = null;
      outputCanvas = null;
      lastProgress = -1;
    }
  } catch (err) {
    workerSelf.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Halftone worker error',
    });
  }
});
