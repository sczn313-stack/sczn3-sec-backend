// server.js (ESM)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();
app.use(cors());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
  DISTANCE_YARDS: numEnv("DISTANCE_YARDS", 100),
  MOA_PER_CLICK: numEnv("MOA_PER_CLICK", 0.25), // quarter MOA default
  TARGET_WIDTH_IN: numEnv("TARGET_WIDTH_IN", 23),

  MIN_SHOTS: Math.round(numEnv("MIN_SHOTS", 3)),
  MAX_SHOTS: Math.round(numEnv("MAX_SHOTS", 7)),
  MAX_ABS_CLICKS: numEnv("MAX_ABS_CLICKS", 80),

  PAPER_WHITE_THRESH: Math.round(numEnv("PAPER_WHITE_THRESH", 230)), // 0..255
  PAPER_WHITE_FRAC_MIN: numEnv("PAPER_WHITE_FRAC_MIN", 0.28),

  DARK_THRESH: Math.round(numEnv("DARK_THRESH", 80)), // 0..255
  DARK_FRAC_MAX: numEnv("DARK_FRAC_MAX", 0.25),

  CLUSTER_RADIUS_IN: numEnv("CLUSTER_RADIUS_IN", 8), // cluster radius in inches
};

function clampAbs(x, absMax) {
  if (!Number.isFinite(x)) return 0;
  if (x > absMax) return absMax;
  if (x < -absMax) return -absMax;
  return x;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function inchesPerClick(distanceYards, moaPerClick) {
  // 1 MOA ≈ 1.047" at 100 yards
  return 1.047 * moaPerClick * (distanceYards / 100);
}

async function decodeGrayscale(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // Convert RGBA -> grayscale 0..255
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    // luminance
    gray[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  return { gray, width: w, height: h };
}

function rowWhiteFrac(gray, w, y, whiteThresh) {
  let white = 0;
  const base = y * w;
  for (let x = 0; x < w; x++) {
    if (gray[base + x] >= whiteThresh) white++;
  }
  return white / w;
}

function colWhiteFrac(gray, w, h, x, whiteThresh) {
  let white = 0;
  for (let y = 0; y < h; y++) {
    if (gray[y * w + x] >= whiteThresh) white++;
  }
  return white / h;
}

function findPaperBounds(gray, w, h) {
  const wt = CONFIG.PAPER_WHITE_THRESH;
  const minFrac = CONFIG.PAPER_WHITE_FRAC_MIN;

  let top = 0;
  for (let y = 0; y < h; y++) {
    if (rowWhiteFrac(gray, w, y, wt) >= minFrac) {
      top = y;
      break;
    }
  }

  let bottom = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    if (rowWhiteFrac(gray, w, y, wt) >= minFrac) {
      bottom = y;
      break;
    }
  }

  let left = 0;
  for (let x = 0; x < w; x++) {
    if (colWhiteFrac(gray, w, h, x, wt) >= minFrac) {
      left = x;
      break;
    }
  }

  let right = w - 1;
  for (let x = w - 1; x >= 0; x--) {
    if (colWhiteFrac(gray, w, h, x, wt) >= minFrac) {
      right = x;
      break;
    }
  }

  // Sanity
  const rw = Math.max(1, right - left + 1);
  const rh = Math.max(1, bottom - top + 1);
  return { left, top, width: rw, height: rh };
}

function regionStats(gray, w, region) {
  const { left, top, width, height } = region;
  const total = width * height;

  let white = 0;
  let dark = 0;

  for (let y = 0; y < height; y++) {
    const yy = top + y;
    const base = yy * w + left;
    for (let x = 0; x < width; x++) {
      const v = gray[base + x];
      if (v >= CONFIG.PAPER_WHITE_THRESH) white++;
      if (v <= CONFIG.DARK_THRESH) dark++;
    }
  }

  return {
    whiteFrac: white / total,
    darkFrac: dark / total,
  };
}

function detectShots(gray, w, region) {
  const { left, top, width, height } = region;

  // Build a downsampled dark-pixel grid
  const step = Math.max(1, Math.floor(Math.max(width, height) / 800));
  const gw = Math.max(1, Math.floor(width / step));
  const gh = Math.max(1, Math.floor(height / step));

  const dark = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = left + Math.min(width - 1, gx * step + Math.floor(step / 2));
      const py = top + Math.min(height - 1, gy * step + Math.floor(step / 2));
      const v = gray[py * w + px];
      dark[gy * gw + gx] = v <= CONFIG.DARK_THRESH ? 1 : 0;
    }
  }

  // Connected components on the grid
  const seen = new Uint8Array(gw * gh);
  const points = [];

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || seen[i]) continue;

    // BFS
    const q = [i];
    seen[i] = 1;

    let count = 0;
    let sumX = 0;
    let sumY = 0;

    while (q.length) {
      const idx = q.pop();
      const y = Math.floor(idx / gw);
      const x = idx - y * gw;

      count++;
      sumX += x;
      sumY += y;

      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nidx = ny * gw + nx;
        if (seen[nidx] || !dark[nidx]) continue;
        seen[nidx] = 1;
        q.push(nidx);
      }
    }

    // Filter blob sizes (in grid-cells)
    // These are intentionally broad because phone photos vary a lot.
    if (count < 3) continue;
    if (count > 4000) continue;

    const cx = sumX / count;
    const cy = sumY / count;

    // Convert back to original pixel coords (center of the component in region space)
    const px = left + cx * step;
    const py = top + cy * step;

    points.push({ x: px, y: py, size: count });
  }

  return points;
}

function pickCluster(points, region) {
  if (points.length === 0) return { used: [], center: null };

  // Prefer larger blobs first (helps ignore tiny noise)
  const pts = [...points].sort((a, b) => b.size - a.size).slice(0, 200);

  const radiusPx = (CONFIG.CLUSTER_RADIUS_IN / CONFIG.TARGET_WIDTH_IN) * region.width;

  // Find densest point by neighbor count within radius
  let bestIdx = 0;
  let bestCount = -1;

  for (let i = 0; i < pts.length; i++) {
    let c = 0;
    for (let j = 0; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      const dy = pts[j].y - pts[i].y;
      if (dx * dx + dy * dy <= radiusPx * radiusPx) c++;
    }
    if (c > bestCount) {
      bestCount = c;
      bestIdx = i;
    }
  }

  const seed = pts[bestIdx];

  // Collect cluster points around seed
  const cluster = pts
    .map((p) => {
      const dx = p.x - seed.x;
      const dy = p.y - seed.y;
      const d2 = dx * dx + dy * dy;
      return { ...p, d2 };
    })
    .filter((p) => p.d2 <= radiusPx * radiusPx)
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, CONFIG.MAX_SHOTS);

  if (cluster.length < CONFIG.MIN_SHOTS) return { used: [], center: null };

  // Cluster center
  let sx = 0,
    sy = 0;
  for (const p of cluster) {
    sx += p.x;
    sy += p.y;
  }
  const center = { x: sx / cluster.length, y: sy / cluster.length };

  return { used: cluster, center };
}

function computeSEC({ shotCenterPx, region }) {
  const targetCx = region.left + region.width / 2;
  const targetCy = region.top + region.height / 2;

  const dxPx = shotCenterPx.x - targetCx;
  const dyPx = shotCenterPx.y - targetCy;

  const inPerPx = CONFIG.TARGET_WIDTH_IN / region.width;

  const dxIn = dxPx * inPerPx;
  const dyIn = dyPx * inPerPx;

  const ipc = inchesPerClick(CONFIG.DISTANCE_YARDS, CONFIG.MOA_PER_CLICK);

  // Convention: DIAL_TO_CENTER (move impact to center)
  // +dxIn => impacts RIGHT => dial LEFT => negative clicks => invert windage
  // +dyIn => impacts LOW (down) => dial UP? (depends on scope convention)
  // Your UI arrows currently match keeping elevation sign as dyIn.
  const windage = clampAbs(-dxIn / ipc, CONFIG.MAX_ABS_CLICKS);
  const elevation = clampAbs(dyIn / ipc, CONFIG.MAX_ABS_CLICKS);

  return {
    dxPx,
    dyPx,
    dxIn,
    dyIn,
    windage_clicks: round2(windage),
    elevation_clicks: round2(elevation),
  };
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("up");
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    routes: ["GET /", "GET /api/health", "POST /api/sec"],
    config: {
      DISTANCE_YARDS: CONFIG.DISTANCE_YARDS,
      MOA_PER_CLICK: CONFIG.MOA_PER_CLICK,
      TARGET_WIDTH_IN: CONFIG.TARGET_WIDTH_IN,
      MIN_SHOTS: CONFIG.MIN_SHOTS,
      MAX_SHOTS: CONFIG.MAX_SHOTS,
      MAX_ABS_CLICKS: CONFIG.MAX_ABS_CLICKS,
      PAPER_WHITE_THRESH: CONFIG.PAPER_WHITE_THRESH,
      PAPER_WHITE_FRAC_MIN: CONFIG.PAPER_WHITE_FRAC_MIN,
      DARK_THRESH: CONFIG.DARK_THRESH,
      DARK_FRAC_MAX: CONFIG.DARK_FRAC_MAX,
      CLUSTER_RADIUS_IN: CONFIG.CLUSTER_RADIUS_IN,
    },
  });
});

app.post("/api/sec", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: 'No image uploaded. Field name must be: "file"' });
    }

    const { gray, width: w, height: h } = await decodeGrayscale(req.file.buffer);

    const region = findPaperBounds(gray, w, h);
    const areaFrac = (region.width * region.height) / (w * h);
    const aspect = region.width / region.height;

    // Basic “full target in-frame” checks
    if (areaFrac < 0.6 || aspect < 0.75 || aspect > 1.33) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: does not look like a full target in-frame.",
        debug: { areaFrac: round2(areaFrac), aspect: round2(aspect) },
      });
    }

    const stats = regionStats(gray, w, region);
    if (stats.darkFrac > CONFIG.DARK_FRAC_MAX) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: too much dark area (likely not a paper target).",
        debug: { darkFrac: round2(stats.darkFrac), whiteFrac: round2(stats.whiteFrac) },
      });
    }

    const candidates = detectShots(gray, w, region);
    const cluster = pickCluster(candidates, region);

    if (!cluster.center) {
      return res.status(422).json({
        ok: false,
        error: `Image rejected: not enough shots detected (${cluster.used.length}).`,
        debug: { shotsDetected: candidates.length, shotsUsed: cluster.used.length },
      });
    }

    const sec = computeSEC({ shotCenterPx: cluster.center, region });

    return res.json({
      ok: true,
      units: "CLICKS",
      convention: "DIAL_TO_CENTER",
      sec: {
        windage_clicks: sec.windage_clicks,
        elevation_clicks: sec.elevation_clicks,
      },
      // dev-only helpers (your UI can ignore these; Hoppscotch can show them)
      debug: {
        whiteFrac: round2(stats.whiteFrac),
        darkFrac: round2(stats.darkFrac),
        shotsDetected: candidates.length,
        shotsUsed: cluster.used.length,
        dxPx: round2(sec.dxPx),
        dyPx: round2(sec.dyPx),
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error processing image.",
      debug: { message: err?.message || String(err) },
    });
  }
});

const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on ${PORT}`);
});
