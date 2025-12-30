/* server.js — SCZN3 SEC Backend (BULL LOGIC LOCK)
 *
 * Core promise:
 *  - Directions are ALWAYS "move the cluster to the bull".
 *  - Y flip happens EXACTLY ONCE when creating POIB (image Y grows down, POIB Y grows up).
 *  - Dial text is derived ONLY from clicksSigned signs:
 *      windage: + = RIGHT,  - = LEFT
 *      elevation:+ = UP,     - = DOWN
 *
 * Endpoint:
 *  - GET  /                 -> alive status
 *  - POST /api/sec          -> multipart/form-data field "image"
 *      optional fields: distanceYards, clickValueMoa, targetSizeSpec
 *
 * targetSizeSpec examples:
 *  - "23"        (square 23x23)
 *  - "8.5x11"    (portrait 8.5 by 11)
 *  - "11x8.5"    (landscape)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

const SERVICE_NAME = "sczn3-sec-backend-pipe";
const BUILD_TAG = "BULL_LOGIC_LOCK_v1";

const app = express();
app.use(cors({ origin: true, credentials: false }));

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.get("/", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, service: SERVICE_NAME, status: "alive", build: BUILD_TAG }));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ------------------------------
// Helpers
// ------------------------------
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function fmt2(n) {
  return round2(n).toFixed(2);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseTargetSpec(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return { ok: true, kind: "square", wIn: 23, hIn: 23, spec: "23", note: "defaulted_to_23" };

  // "23"
  if (/^\d+(\.\d+)?$/.test(s)) {
    const x = Number(s);
    if (!Number.isFinite(x) || x <= 0) return { ok: false, reason: "BAD_TARGET_SIZE" };
    return { ok: true, kind: "square", wIn: x, hIn: x, spec: s };
  }

  // "8.5x11" or "8.5×11"
  const norm = s.replace("×", "x").replace(/\s+/g, "");
  const m = norm.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (!m) return { ok: false, reason: "BAD_TARGET_SIZE_SPEC" };

  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return { ok: false, reason: "BAD_TARGET_SIZE_SPEC" };

  return { ok: true, kind: "rect", wIn: a, hIn: b, spec: norm };
}

function inchesPerClickAtYards(distanceYards, clickValueMoa) {
  // True MOA: 1 MOA = 1.047" at 100 yards
  const y = Number(distanceYards);
  const c = Number(clickValueMoa);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  if (!Number.isFinite(c) || c <= 0) return NaN;
  return 1.047 * (y / 100) * c;
}

// Build binary mask of "dark" pixels from RGBA
function buildDarkMask(rgba, w, h, thr) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    // quick luminance
    const lum = (r * 30 + g * 59 + b * 11) / 100;
    mask[i] = lum < thr ? 1 : 0;
  }
  return mask;
}

// Row/col sums for crosshair detection (darkest column/row)
function findCrosshairCenter(mask, w, h) {
  const col = new Uint32Array(w);
  const row = new Uint32Array(h);

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const v = mask[base + x];
      rowSum += v;
      col[x] += v;
    }
    row[y] = rowSum;
  }

  let bestX = 0, bestCol = -1;
  for (let x = 0; x < w; x++) {
    if (col[x] > bestCol) {
      bestCol = col[x];
      bestX = x;
    }
  }

  let bestY = 0, bestRow = -1;
  for (let y = 0; y < h; y++) {
    if (row[y] > bestRow) {
      bestRow = row[y];
      bestY = y;
    }
  }

  return { x: bestX, y: bestY, colStrength: bestCol, rowStrength: bestRow };
}

// Connected components on a binary mask (4-neighborhood)
function connectedComponents(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const comps = [];

  const stack = [];
  const push = (idx) => stack.push(idx);
  const pop = () => stack.pop();

  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || visited[i]) continue;

    visited[i] = 1;
    push(i);

    let area = 0;
    let sumX = 0, sumY = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;

    while (stack.length) {
      const idx = pop();
      area++;

      const y = Math.floor(idx / w);
      const x = idx - y * w;

      sumX += x;
      sumY += y;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      // neighbors
      const left = idx - 1;
      const right = idx + 1;
      const up = idx - w;
      const down = idx + w;

      if (x > 0 && mask[left] && !visited[left]) { visited[left] = 1; push(left); }
      if (x < w - 1 && mask[right] && !visited[right]) { visited[right] = 1; push(right); }
      if (y > 0 && mask[up] && !visited[up]) { visited[up] = 1; push(up); }
      if (y < h - 1 && mask[down] && !visited[down]) { visited[down] = 1; push(down); }
    }

    const boxW = (maxX - minX + 1);
    const boxH = (maxY - minY + 1);
    const cx = sumX / area;
    const cy = sumY / area;
    const fill = area / (boxW * boxH);

    comps.push({
      area,
      cx, cy,
      minX, minY, maxX, maxY,
      boxW, boxH,
      fill,
    });
  }

  return comps;
}

function pickCornerFiducials(comps, w, h) {
  // Corner zones
  const zx = Math.floor(w * 0.25);
  const zy = Math.floor(h * 0.25);

  function bestInZone(x0, y0, x1, y1) {
    let best = null;
    for (const c of comps) {
      if (c.cx < x0 || c.cx > x1 || c.cy < y0 || c.cy > y1) continue;
      // fiducials are dense squares
      if (c.fill < 0.35) continue;
      if (c.area < 100) continue;
      // avoid gigantic components
      if (c.boxW > w * 0.4 || c.boxH > h * 0.4) continue;

      if (!best || c.area > best.area) best = c;
    }
    return best;
  }

  const tl = bestInZone(0, 0, zx, zy);
  const tr = bestInZone(w - zx, 0, w - 1, zy);
  const bl = bestInZone(0, h - zy, zx, h - 1);
  const br = bestInZone(w - zx, h - zy, w - 1, h - 1);

  const found = !!(tl && tr && bl && br);
  return { found, tl, tr, bl, br };
}

function distance(a, b) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function deriveDial(clicksSigned) {
  const w = clicksSigned.windage;
  const e = clicksSigned.elevation;

  const windDir = w > 0 ? "RIGHT" : w < 0 ? "LEFT" : "CENTER";
  const elevDir = e > 0 ? "UP" : e < 0 ? "DOWN" : "LEVEL";

  return {
    windage: `${windDir} ${fmt2(Math.abs(w))} clicks`,
    elevation: `${elevDir} ${fmt2(Math.abs(e))} clicks`,
  };
}

// ------------------------------
// Main API
// ------------------------------
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const distanceYards = num(req.body?.distanceYards, 100);
    const clickValueMoa = num(req.body?.clickValueMoa, 0.25);
    const specRaw = req.body?.targetSizeSpec ?? req.body?.targetSize ?? req.body?.targetSizeInches ?? "23";
    const parsedSpec = parseTargetSpec(specRaw);

    if (!req.file?.buffer) {
      return res.status(400).send(JSON.stringify({
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "NO_IMAGE", message: "POST multipart/form-data with field name 'image'." },
      }));
    }

    if (!parsedSpec.ok) {
      return res.status(400).send(JSON.stringify({
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: parsedSpec.reason, message: "Bad targetSizeSpec. Use '23' or '8.5x11'." },
      }));
    }

    // Downscale for speed but keep enough detail
    const img = sharp(req.file.buffer).rotate(); // respect EXIF rotation
    const meta = await img.metadata();

    const resized = img.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
    const { data: rgba, info } = await resized.raw().toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // Build dark mask
    const DARK_THR = 70; // strict enough to ignore light grid; keeps bullet marks + fiducials + crosshair
    const mask = buildDarkMask(rgba, w, h, DARK_THR);

    // Components
    const comps = connectedComponents(mask, w, h);

    // Crosshair center = bull
    const center = findCrosshairCenter(mask, w, h);
    const bullPx = { x: center.x, y: center.y };

    // Fiducials for scale (preferred)
    const fids = pickCornerFiducials(comps, w, h);

    // Determine intended inch width/height for scale
    // If rect, we keep as given. If square, wIn=hIn.
    let specWIn = parsedSpec.wIn;
    let specHIn = parsedSpec.hIn;

    // If the image is portrait but spec is landscape, keep spec as-is;
    // congruence gate will flag aspect mismatch, but we still compute.
    const imgAspect = w / h;
    const specAspect = specWIn / specHIn;

    const incongruence = [];

    // Aspect congruence gate
    if (Math.abs(imgAspect - specAspect) > 0.18) {
      incongruence.push({
        code: "TARGET_ASPECT_INCONGRUENT",
        imgAspect: round2(imgAspect),
        specAspect: round2(specAspect),
        spec: parsedSpec.spec,
        fix: "Select the target size that matches the uploaded target (ex: 23 for square targets, 8.5x11 for portrait paper).",
      });
    }

    // pixelsPerInch
    let pixelsPerInch = NaN;
    let fiducials = null;

    if (fids.found) {
      // Use fiducial-to-fiducial distances (in pixels) divided by inch dimensions from spec
      const pxW = (distance(fids.tl, fids.tr) + distance(fids.bl, fids.br)) / 2;
      const pxH = (distance(fids.tl, fids.bl) + distance(fids.tr, fids.br)) / 2;

      const ppiX = pxW / specWIn;
      const ppiY = pxH / specHIn;
      pixelsPerInch = (ppiX + ppiY) / 2;

      fiducials = {
        found: true,
        tl: { x: round2(fids.tl.cx), y: round2(fids.tl.cy) },
        tr: { x: round2(fids.tr.cx), y: round2(fids.tr.cy) },
        bl: { x: round2(fids.bl.cx), y: round2(fids.bl.cy) },
        br: { x: round2(fids.br.cx), y: round2(fids.br.cy) },
        pxW: round2(pxW),
        pxH: round2(pxH),
      };
    } else {
      // Fallback: use whole image bounds as if they were the target bounds
      // (Less accurate; flagged)
      const ppiX = w / specWIn;
      const ppiY = h / specHIn;
      pixelsPerInch = (ppiX + ppiY) / 2;

      incongruence.push({
        code: "FIDUCIALS_NOT_FOUND",
        fix: "Ensure the 4 black corner squares are visible in the photo/screenshot. Otherwise scale may be inaccurate.",
      });

      fiducials = { found: false };
    }

    // Hole candidates:
    // Keep mid-size blobs, not giant rings/lines, not corner fiducials.
    const holes = [];
    const maxDim = Math.min(w, h);

    for (const c of comps) {
      // exclude very small noise
      if (c.area < 35) continue;

      // exclude corner regions (fiducials)
      const cornerMarginX = Math.floor(w * 0.18);
      const cornerMarginY = Math.floor(h * 0.18);
      const inLeft = c.cx < cornerMarginX;
      const inRight = c.cx > (w - cornerMarginX);
      const inTop = c.cy < cornerMarginY;
      const inBottom = c.cy > (h - cornerMarginY);
      if ((inLeft && inTop) || (inRight && inTop) || (inLeft && inBottom) || (inRight && inBottom)) continue;

      // exclude giant components (bull rings / big lines)
      if (c.boxW > maxDim * 0.35 || c.boxH > maxDim * 0.35) continue;

      // holes tend to be denser than thin grid lines
      if (c.fill < 0.10) continue;

      holes.push(c);
    }

    if (holes.length === 0) {
      return res.status(200).send(JSON.stringify({
        ok: true,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        received: { originalname: req.file.originalname, mimetype: req.file.mimetype, bytes: req.file.size },
        sec: { distanceYards, clickValueMoa, targetSizeSpec: parsedSpec.spec, targetWIn: specWIn, targetHIn: specHIn },
        computeStatus: "FAILED_HOLES",
        error: { code: "HOLES_NOT_FOUND", message: "No bullet holes detected (dark blobs). Try a clearer image or thicker marks." },
        detect: {
          normalized: { width: w, height: h },
          bullPx,
          pixelsPerInch: round2(pixelsPerInch),
          fiducials,
          holesDetected: 0,
          incongruence,
        },
      }));
    }

    // Group center = average centroid of holes
    let sx = 0, sy = 0;
    for (const h0 of holes) { sx += h0.cx; sy += h0.cy; }
    const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };

    // Convert to inches relative to bull
    // dxIn: right +
    // dyImgIn: down +
    const dxIn = (groupCenterPx.x - bullPx.x) / pixelsPerInch;
    const dyImgIn = (groupCenterPx.y - bullPx.y) / pixelsPerInch;

    // POIB inches:
    // x: right +
    // y: up +  (flip exactly once here)
    const poibInches = {
      x: round2(dxIn),
      y: round2(-dyImgIn),
    };

    // Correction inches = bull - POIB  =>  -POIB
    // clicksSigned:
    // windage: + RIGHT, - LEFT
    // elevation:+ UP,   - DOWN
    const inPerClick = inchesPerClickAtYards(distanceYards, clickValueMoa);

    if (!Number.isFinite(inPerClick) || inPerClick <= 0) {
      return res.status(400).send(JSON.stringify({
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "BAD_CLICK_PARAMS", message: "distanceYards and clickValueMoa must be positive numbers." },
      }));
    }

    const clicksSigned = {
      windage: round2((-poibInches.x) / inPerClick),
      elevation: round2((-poibInches.y) / inPerClick),
    };

    const dial = deriveDial(clicksSigned);

    // Direction congruence gate (optional cross-check with “move-to-bull” logic)
    // Expected:
    //   group right -> LEFT
    //   group left  -> RIGHT
    //   group above -> DOWN
    //   group below -> UP
    const expectedWind =
      dxIn > 0 ? "LEFT" : dxIn < 0 ? "RIGHT" : "CENTER";
    const expectedElev =
      dyImgIn > 0 ? "UP" : dyImgIn < 0 ? "DOWN" : "LEVEL";

    const dialWind = dial.windage.split(" ")[0];
    const dialElev = dial.elevation.split(" ")[0];

    if (dialWind !== expectedWind) {
      incongruence.push({
        code: "WINDAGE_DIRECTION_INCONGRUENT",
        expected: expectedWind,
        backendDial: dialWind,
        fix: "Backend direction math is inconsistent (should never happen in this build). If you see this, redeploy and retest.",
      });
    }
    if (dialElev !== expectedElev) {
      incongruence.push({
        code: "ELEVATION_DIRECTION_INCONGRUENT",
        expected: expectedElev,
        backendDial: dialElev,
        fix: "Backend direction math is inconsistent (should never happen in this build). If you see this, redeploy and retest.",
      });
    }

    // Final response (minimal + debug-friendly)
    return res.status(200).send(JSON.stringify({
      ok: true,
      service: SERVICE_NAME,
      build: BUILD_TAG,
      received: {
        field: "image",
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        bytes: req.file.size,
      },
      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeSpec: parsedSpec.spec,
        targetWIn: specWIn,
        targetHIn: specHIn,
      },
      computeStatus: "COMPUTED_FROM_IMAGE",
      manualPoibIgnored: true,
      poibInches,
      clicksSigned,
      dial,
      detect: {
        normalized: { width: w, height: h },
        bullPx: { x: round2(bullPx.x), y: round2(bullPx.y) },
        groupCenterPx: { x: round2(groupCenterPx.x), y: round2(groupCenterPx.y) },
        pixelsPerInch: round2(pixelsPerInch),
        fiducials,
        holesDetected: holes.length,
        incongruence,
      },
    }));
  } catch (err) {
    return res.status(500).send(JSON.stringify({
      ok: false,
      service: SERVICE_NAME,
      build: BUILD_TAG,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    }));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // Keep this tiny (Render logs)
  console.log(`${SERVICE_NAME} listening on ${PORT} (${BUILD_TAG})`);
});
