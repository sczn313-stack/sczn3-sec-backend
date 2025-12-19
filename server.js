import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// =========================
// SCZN3 defaults
// =========================
const DISTANCE_YARDS = Number(process.env.DISTANCE_YARDS ?? 100);
const MOA_PER_CLICK = Number(process.env.MOA_PER_CLICK ?? 0.25);
const TARGET_WIDTH_IN = Number(process.env.TARGET_WIDTH_IN ?? 23);

// =========================
// Detection / validation tuning
// =========================
const MAX_W = Number(process.env.MAX_W ?? 1400);
const INK_PAD_PCT = Number(process.env.INK_PAD_PCT ?? 0.03);

const OTSU_CLAMP_MIN = Number(process.env.OTSU_CLAMP_MIN ?? 35);
const OTSU_CLAMP_MAX = Number(process.env.OTSU_CLAMP_MAX ?? 150);

const MIN_SHOTS = Number(process.env.MIN_SHOTS ?? 3);
const MAX_SHOTS = Number(process.env.MAX_SHOTS ?? 7);

const MIN_AREA_PCT = Number(process.env.MIN_AREA_PCT ?? 0.00003);
const MAX_AREA_PCT = Number(process.env.MAX_AREA_PCT ?? 0.006);
const MAX_ASPECT = Number(process.env.MAX_ASPECT ?? 3.0);
const MIN_FILL = Number(process.env.MIN_FILL ?? 0.20);

const MAX_ABS_CLICKS = Number(process.env.MAX_ABS_CLICKS ?? 80);

// “Is this really a target?” bbox gates
const MIN_BBOX_AREA_FRAC = Number(process.env.MIN_BBOX_AREA_FRAC ?? 0.18);
const BBOX_ASPECT_MIN = Number(process.env.BBOX_ASPECT_MIN ?? 0.80);
const BBOX_ASPECT_MAX = Number(process.env.BBOX_ASPECT_MAX ?? 1.25);

// NEW: Paper/Ink gate (prevents random photos)
const PAPER_WHITE_THRESH = Number(process.env.PAPER_WHITE_THRESH ?? 230);
const PAPER_WHITE_FRAC_MIN = Number(process.env.PAPER_WHITE_FRAC_MIN ?? 0.28); // % of pixels that look like paper
const DARK_THRESH = Number(process.env.DARK_THRESH ?? 80);
const DARK_FRAC_MAX = Number(process.env.DARK_FRAC_MAX ?? 0.25); // random photos often exceed this

// NEW: Noise gate (random textures create tons of blobs)
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 60);

app.get("/", (req, res) => res.status(200).send("SCZN3 SEC Backend is up"));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    routes: ["GET /", "GET /api/health", "POST /api/sec"],
    config: {
      DISTANCE_YARDS,
      MOA_PER_CLICK,
      TARGET_WIDTH_IN,
      MIN_SHOTS,
      MAX_SHOTS,
      MAX_ABS_CLICKS,
      PAPER_WHITE_THRESH,
      PAPER_WHITE_FRAC_MIN,
      DARK_THRESH,
      DARK_FRAC_MAX,
      MAX_CANDIDATES,
    },
  });
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function inchesPerMOA(distanceYds) {
  return 1.047 * (distanceYds / 100);
}

function otsuThreshold(grayArray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grayArray.length; i++) hist[grayArray[i]]++;

  const total = grayArray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let wF = 0;

  let varMax = -1;
  let threshold = 90;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > varMax) {
      varMax = between;
      threshold = t;
    }
  }
  return threshold;
}

function findBBoxNotWhite(gray, w, h, notWhiteThresh = 235) {
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < notWhiteThresh) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  return { minX, minY, maxX, maxY, width: bw, height: bh };
}

function connectedComponents(mask, w, h, region) {
  const visited = new Uint8Array(w * h);
  const comps = [];
  const { minX, minY, maxX, maxY } = region;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i0 = y * w + x;
      if (!mask[i0] || visited[i0]) continue;

      const stack = [i0];
      visited[i0] = 1;

      let area = 0, sumX = 0, sumY = 0;
      let bx0 = w, by0 = h, bx1 = -1, by1 = -1;

      while (stack.length) {
        const i = stack.pop();
        area++;

        const ix = i % w;
        const iy = (i / w) | 0;

        sumX += ix;
        sumY += iy;

        if (ix < bx0) bx0 = ix;
        if (iy < by0) by0 = iy;
        if (ix > bx1) bx1 = ix;
        if (iy > by1) by1 = iy;

        const left = i - 1, right = i + 1, up = i - w, down = i + w;

        if (ix > minX && mask[left] && !visited[left]) { visited[left] = 1; stack.push(left); }
        if (ix < maxX && mask[right] && !visited[right]) { visited[right] = 1; stack.push(right); }
        if (iy > minY && mask[up] && !visited[up]) { visited[up] = 1; stack.push(up); }
        if (iy < maxY && mask[down] && !visited[down]) { visited[down] = 1; stack.push(down); }
      }

      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      const fill = area / (bw * bh);
      const aspect = Math.max(bw / bh, bh / bw);

      comps.push({ area, cx: sumX / area, cy: sumY / area, bx0, by0, bx1, by1, bw, bh, fill, aspect });
    }
  }
  return comps;
}

function pickTightest(points, kMax) {
  if (points.length <= kMax) return points;
  const mx = points.reduce((a, p) => a + p.cx, 0) / points.length;
  const my = points.reduce((a, p) => a + p.cy, 0) / points.length;
  return points
    .map((p) => ({ p, d2: (p.cx - mx) ** 2 + (p.cy - my) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, kMax)
    .map((x) => x.p);
}

app.post("/api/sec", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No image uploaded. Field name must be: file" });
    }

    const img = sharp(req.file.buffer).rotate();

    const { data, info } = await img
      .resize({ width: MAX_W, withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    const inkBox = findBBoxNotWhite(data, w, h, 235);
    if (!inkBox) {
      return res.status(422).json({ ok: false, error: "No target-like region detected (too white / too blank)." });
    }

    const bboxArea = inkBox.width * inkBox.height;
    const imgArea = w * h;
    const areaFrac = bboxArea / imgArea;
    const aspect = inkBox.width / inkBox.height;

    if (areaFrac < MIN_BBOX_AREA_FRAC || aspect < BBOX_ASPECT_MIN || aspect > BBOX_ASPECT_MAX) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: does not look like a full target in-frame.",
        debug: { areaFrac: round2(areaFrac), aspect: round2(aspect) },
      });
    }

    // Square crop
    const padX = Math.round(inkBox.width * INK_PAD_PCT);
    const padY = Math.round(inkBox.height * INK_PAD_PCT);

    let minX = clamp(inkBox.minX - padX, 0, w - 1);
    let minY = clamp(inkBox.minY - padY, 0, h - 1);
    let maxX = clamp(inkBox.maxX + padX, 0, w - 1);
    let maxY = clamp(inkBox.maxY + padY, 0, h - 1);

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const side = Math.min(bw, bh);

    const cx = minX + bw / 2;
    const cy = minY + bh / 2;

    minX = clamp(Math.round(cx - side / 2), 0, w - side);
    minY = clamp(Math.round(cy - side / 2), 0, h - side);
    maxX = minX + side - 1;
    maxY = minY + side - 1;

    const region = { minX, minY, maxX, maxY, width: side, height: side };

    // Region stats (NEW paper/ink gate)
    const regionGray = new Uint8Array(region.width * region.height);
    let k = 0;
    let whiteCount = 0;
    let darkCount = 0;
    for (let y = minY; y <= maxY; y++) {
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        const v = data[row + x];
        regionGray[k++] = v;
        if (v >= PAPER_WHITE_THRESH) whiteCount++;
        if (v <= DARK_THRESH) darkCount++;
      }
    }

    const totalPix = regionGray.length;
    const whiteFrac = whiteCount / totalPix;
    const darkFrac = darkCount / totalPix;

    if (whiteFrac < PAPER_WHITE_FRAC_MIN || darkFrac > DARK_FRAC_MAX) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: crop does not look like a paper target (background/texture too complex).",
        debug: { whiteFrac: round2(whiteFrac), darkFrac: round2(darkFrac) },
      });
    }

    // Otsu threshold
    let t = otsuThreshold(regionGray);
    t = clamp(t, OTSU_CLAMP_MIN, OTSU_CLAMP_MAX);

    const mask = new Uint8Array(w * h);
    for (let y = minY; y <= maxY; y++) {
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        mask[i] = data[i] < t ? 1 : 0;
      }
    }

    const comps = connectedComponents(mask, w, h, region);

    const targetArea = region.width * region.height;
    const minArea = Math.round(targetArea * MIN_AREA_PCT);
    const maxArea = Math.round(targetArea * MAX_AREA_PCT);

    const margin = Math.max(10, Math.round(region.width * 0.01));

    const candidates = comps.filter((c) => {
      if (c.area < minArea || c.area > maxArea) return false;
      if (c.aspect > MAX_ASPECT) return false;
      if (c.fill < MIN_FILL) return false;

      if (c.bx0 <= minX + margin) return false;
      if (c.by0 <= minY + margin) return false;
      if (c.bx1 >= maxX - margin) return false;
      if (c.by1 >= maxY - margin) return false;

      return true;
    });

    // Noise gate (NEW)
    if (candidates.length > MAX_CANDIDATES) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: too many candidate marks (image is noisy / not a clean target photo).",
        debug: { candidates: candidates.length, threshold: t },
      });
    }

    if (candidates.length < MIN_SHOTS) {
      return res.status(422).json({
        ok: false,
        error: `Image rejected: not enough shots detected (${candidates.length}).`,
        debug: { threshold: t, candidates: candidates.length },
      });
    }

    const chosen = pickTightest(candidates, MAX_SHOTS);

    const shotCx = chosen.reduce((a, p) => a + p.cx, 0) / chosen.length;
    const shotCy = chosen.reduce((a, p) => a + p.cy, 0) / chosen.length;

    const targetCx = minX + region.width / 2;
    const targetCy = minY + region.height / 2;

    const dxPx = shotCx - targetCx;
    const dyPx = shotCy - targetCy;

    const inPerPx = TARGET_WIDTH_IN / region.width;
    const dxIn = dxPx * inPerPx;
    const dyIn = dyPx * inPerPx;

    const ipm = inchesPerMOA(DISTANCE_YARDS);
    const dxMOA = dxIn / ipm;
    const dyMOA = dyIn / ipm;

    const dxClicks = dxMOA / MOA_PER_CLICK;
    const dyClicks = dyMOA / MOA_PER_CLICK;

    // Dial-to-center convention
    let windageClicks = -dxClicks;
    let elevationClicks = +dyClicks;

    if (Math.abs(windageClicks) > MAX_ABS_CLICKS || Math.abs(elevationClicks) > MAX_ABS_CLICKS) {
      return res.status(422).json({
        ok: false,
        error: "Image rejected: computed correction exceeds sane limits (likely not a valid target/shot set).",
        debug: {
          windageClicks: round2(windageClicks),
          elevationClicks: round2(elevationClicks),
          shotsUsed: chosen.length,
          threshold: t,
        },
      });
    }

    windageClicks = round2(windageClicks);
    elevationClicks = round2(elevationClicks);

    return res.json({
      ok: true,
      units: "CLICKS",
      convention: "DIAL_TO_CENTER",
      sec: { windage_clicks: windageClicks, elevation_clicks: elevationClicks },
      debug: {
        whiteFrac: round2(whiteFrac),
        darkFrac: round2(darkFrac),
        shotsDetected: candidates.length,
        shotsUsed: chosen.length,
        threshold: t,
        dxPx: round2(dxPx),
        dyPx: round2(dyPx),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "SEC failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SCZN3 SEC Backend listening on port ${PORT}`));
