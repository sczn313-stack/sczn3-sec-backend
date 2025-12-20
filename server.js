/**
 * SCZN3 SEC Backend — server.js (CLEAN)
 *
 * Endpoints:
 * - GET  /            -> plain text up
 * - GET  /api/health  -> minimal health
 * - POST /api/sec     -> multipart/form-data field name: "file"
 *                        returns ONLY: { ok, units, convention, sec:{ windage_clicks, elevation_clicks } }
 *
 * Math:
 * inchesPerClick = 1.047 * MOA_PER_CLICK * (DISTANCE_YARDS / 100)
 * Pixels -> inches uses TARGET_WIDTH_IN / detectedTargetRegionWidthPx
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

// ----------------------------
// Config (env overrides allowed)
// ----------------------------
const DISTANCE_YARDS = num(process.env.DISTANCE_YARDS, 100);
const MOA_PER_CLICK = num(process.env.MOA_PER_CLICK, 0.25);
const TARGET_WIDTH_IN = num(process.env.TARGET_WIDTH_IN, 23);

const MIN_SHOTS = int(process.env.MIN_SHOTS, 3);
const MAX_SHOTS = int(process.env.MAX_SHOTS, 7);
const MAX_ABS_CLICKS = num(process.env.MAX_ABS_CLICKS, 80);

const PAPER_WHITE_THRESH = int(process.env.PAPER_WHITE_THRESH, 230);
const DARK_THRESH = int(process.env.DARK_THRESH, 80);

const AREA_FRAC_MIN = num(process.env.AREA_FRAC_MIN, 0.60);
const ASPECT_MIN = num(process.env.ASPECT_MIN, 0.85);
const ASPECT_MAX = num(process.env.ASPECT_MAX, 1.15);

const MAX_PROCESS_W = int(process.env.MAX_PROCESS_W, 1100);
const PORT = int(process.env.PORT, 10000);

// ----------------------------
// App + middleware
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ----------------------------
// Helpers
// ----------------------------
function num(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
function inchesPerClick(distanceYards, moaPerClick) {
  // 1 MOA ~= 1.047" at 100 yards
  return 1.047 * moaPerClick * (distanceYards / 100);
}
function isWhite(r, g, b) {
  return r >= PAPER_WHITE_THRESH && g >= PAPER_WHITE_THRESH && b >= PAPER_WHITE_THRESH;
}
function isDark(r, g, b) {
  return r <= DARK_THRESH && g <= DARK_THRESH && b <= DARK_THRESH;
}

async function loadRGBA(buffer) {
  let img = sharp(buffer, { failOnError: false }).rotate(); // respect EXIF
  const meta = await img.metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  if (!w0 || !h0) throw new Error("Could not read image dimensions.");

  if (w0 > MAX_PROCESS_W) {
    img = img.resize({ width: MAX_PROCESS_W, withoutEnlargement: true });
  }

  const outMeta = await img.metadata();
  const w = outMeta.width;
  const h = outMeta.height;

  const data = await img.ensureAlpha().raw().toBuffer(); // RGBA
  return { data: new Uint8Array(data), w, h };
}

function findNonWhiteBBox(rgba, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    let row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (!isWhite(r, g, b)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const areaFrac = (width * height) / (w * h);
  const aspect = width / height;

  return { x0: minX, y0: minY, x1: maxX, y1: maxY, width, height, areaFrac, aspect };
}

function findDarkBlobs(rgba, w, h, bbox) {
  const { x0, y0, x1, y1 } = bbox;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;

  const mask = new Uint8Array(bw * bh);

  for (let y = 0; y < bh; y++) {
    const yy = y0 + y;
    let row = (yy * w + x0) * 4;
    for (let x = 0; x < bw; x++) {
      const i = row + x * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const idx = y * bw + x;
      if (isDark(r, g, b)) mask[idx] = 1;
    }
  }

  const visited = new Uint8Array(bw * bh);
  const blobs = [];
  const stack = [];

  const minArea = 12;     // reject tiny noise
  const maxArea = 20000;  // reject huge fills

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const idx = y * bw + x;
      if (!mask[idx] || visited[idx]) continue;

      visited[idx] = 1;
      stack.push(idx);

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / bw);
        const cx = cur - cy * bw;

        area++;
        sumX += cx;
        sumY += cy;

        if (cx > 0) {
          const n = cur - 1;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
        if (cx + 1 < bw) {
          const n = cur + 1;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
        if (cy > 0) {
          const n = cur - bw;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
        if (cy + 1 < bh) {
          const n = cur + bw;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }

      if (area >= minArea && area <= maxArea) {
        blobs.push({
          area,
          cx: x0 + (sumX / area),
          cy: y0 + (sumY / area),
        });
      }
    }
  }

  return blobs;
}

async function computeSEC(buffer, opts) {
  const convention = String(opts.convention || "DIAL_TO_CENTER").toUpperCase();
  const distanceYards = num(opts.distanceYards, DISTANCE_YARDS);
  const moaPerClick = num(opts.moaPerClick, MOA_PER_CLICK);
  const targetWidthIn = num(opts.targetWidthIn, TARGET_WIDTH_IN);

  const { data, w, h } = await loadRGBA(buffer);
  const bbox = findNonWhiteBBox(data, w, h);

  if (!bbox) {
    const e = new Error("Image rejected: does not look like a full target in-frame.");
    e.status = 422;
    throw e;
  }

  if (bbox.areaFrac < AREA_FRAC_MIN || bbox.aspect < ASPECT_MIN || bbox.aspect > ASPECT_MAX) {
    const e = new Error("Image rejected: does not look like a full target in-frame.");
    e.status = 422;
    throw e;
  }

  const blobs = findDarkBlobs(data, w, h, bbox);
  blobs.sort((a, b) => b.area - a.area);

  if (blobs.length < MIN_SHOTS) {
    const e = new Error(`Image rejected: not enough shots detected (${blobs.length}).`);
    e.status = 422;
    throw e;
  }

  const used = blobs.slice(0, MAX_SHOTS);

  let shotCx = 0;
  let shotCy = 0;
  for (const s of used) {
    shotCx += s.cx;
    shotCy += s.cy;
  }
  shotCx /= used.length;
  shotCy /= used.length;

  const targetCx = bbox.x0 + bbox.width / 2;
  const targetCy = bbox.y0 + bbox.height / 2;

  const dxPx = shotCx - targetCx;
  const dyPx = shotCy - targetCy;

  const inPerPx = targetWidthIn / bbox.width;
  const dxIn = dxPx * inPerPx;
  const dyIn = dyPx * inPerPx;

  const ipc = inchesPerClick(distanceYards, moaPerClick);

  // Convention defaults to DIAL_TO_CENTER:
  // dxIn > 0 (impact right) -> dial left (negative wind)
  // dyIn < 0 (impact high)  -> dial down (negative elev)
  let windClicks = 0;
  let elevClicks = 0;

  if (convention === "DIAL_TO_GROUP") {
    windClicks = dxIn / ipc;
    elevClicks = dyIn / ipc;
  } else {
    windClicks = -dxIn / ipc;
    elevClicks = dyIn / ipc;
  }

  windClicks = clamp(windClicks, -MAX_ABS_CLICKS, MAX_ABS_CLICKS);
  elevClicks = clamp(elevClicks, -MAX_ABS_CLICKS, MAX_ABS_CLICKS);

  return {
    units: "CLICKS",
    convention,
    sec: {
      windage_clicks: round2(windClicks),
      elevation_clicks: round2(elevClicks),
    },
  };
}

// ----------------------------
// Routes
// ----------------------------
app.get("/", (_req, res) => {
  res.type("text/plain").send("SCZN3 SEC Backend is up");
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/sec", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: "No image uploaded. Field name must be: file",
      });
    }

    const convention = req.body?.convention || req.query?.convention || "DIAL_TO_CENTER";
    const distanceYards =
      req.body?.distanceYards || req.body?.distance_yards || req.query?.distanceYards || req.query?.distance_yards;
    const moaPerClick =
      req.body?.moaPerClick || req.body?.moa_per_click || req.query?.moaPerClick || req.query?.moa_per_click;
    const targetWidthIn =
      req.body?.targetWidthIn || req.body?.target_width_in || req.query?.targetWidthIn || req.query?.target_width_in;

    const out = await computeSEC(req.file.buffer, {
      convention,
      distanceYards,
      moaPerClick,
      targetWidthIn,
    });

    res.json({
      ok: true,
      units: out.units,
      convention: out.convention,
      sec: out.sec,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Server error",
    });
  }
});

// ----------------------------
// Start
// ----------------------------
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on :${PORT}`);
});
