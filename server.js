/* ============================================================================
SCZN3 SEC Backend — server.js (FULL FILE)
- GET /          -> "SCZN3 SEC Backend is up"
- GET /healthz   -> { ok: true }
- POST /api/sec  -> multipart/form-data (field name must be: file)

Key fix vs common bug:
- Uses separate X/Y scaling (inPerPxX, inPerPxY) so elevation isn’t distorted when
  the detected region isn’t perfectly square.

Defaults (normalized):
- distanceYards = 100
- moaPerClick   = 0.25
============================================================================ */

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");

let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  // If sharp isn't installed, server will still run but /api/sec will error.
  sharp = null;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB
  },
});

const TARGET_WIDTH_IN = 23;
const TARGET_HEIGHT_IN = 23;

// 1 MOA ≈ 1.047" at 100 yards
function inchesPerMoa(distanceYards) {
  return (Number(distanceYards) * 1.047) / 100;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.toLowerCase() === "true" || v === "1" || v.toLowerCase() === "yes";
  return false;
}

/**
 * Convert image to grayscale raw pixels with optional downscale for speed.
 * Returns: { w, h, gray } where gray is Uint8Array length w*h (0=black,255=white)
 */
async function decodeToGray(buffer) {
  if (!sharp) {
    throw new Error("sharp is not installed. Install it or switch pipeline to an installed image lib.");
  }

  // Downscale large images to keep CPU reasonable
  const meta = await sharp(buffer).metadata();
  let w = meta.width || 0;
  let h = meta.height || 0;
  if (!w || !h) throw new Error("Could not read image dimensions.");

  const maxEdge = 1800;
  let resizeW = w;
  let resizeH = h;
  if (Math.max(w, h) > maxEdge) {
    const scale = maxEdge / Math.max(w, h);
    resizeW = Math.round(w * scale);
    resizeH = Math.round(h * scale);
  }

  const { data, info } = await sharp(buffer)
    .rotate() // respect EXIF orientation
    .resize(resizeW, resizeH, { fit: "inside" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    w: info.width,
    h: info.height,
    gray: new Uint8Array(data),
  };
}

/**
 * Find a "target-like" region (bounding box) based on dark border pixels.
 * Very simple heuristic:
 * - Identify pixels below a dynamic threshold (dark)
 * - Get bounding box of those pixels
 * - Compute areaFrac + aspect ratio
 */
function detectTargetRegion(gray, w, h) {
  // Build histogram for threshold
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  // Find threshold so that ~3–6% of pixels are considered "dark"
  const total = gray.length;
  let cum = 0;
  let threshold = 120; // fallback
  const targetDarkFrac = 0.04;
  for (let t = 0; t < 256; t++) {
    cum += hist[t];
    if (cum / total >= targetDarkFrac) {
      threshold = t;
      break;
    }
  }
  threshold = clamp(threshold + 20, 60, 180); // bump slightly (borders can be lighter)

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let darkCount = 0;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = gray[row + x];
      if (v <= threshold) {
        darkCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return {
      ok: false,
      error: "No dark structure found.",
      debug: { threshold, darkFrac: 0, areaFrac: 0, aspect: 0 },
    };
  }

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;

  const areaFrac = (boxW * boxH) / (w * h);
  const aspect = boxW / boxH;
  const darkFrac = darkCount / total;
  const whiteFrac = 1 - darkFrac;

  // Heuristics similar to what you’ve seen in debug:
  // - Need most of frame to be target
  // - Aspect should be roughly square (but allow some perspective)
  const looksLikeFullTarget = areaFrac >= 0.60 && aspect >= 0.70 && aspect <= 1.45;

  if (!looksLikeFullTarget) {
    return {
      ok: false,
      error: "Image rejected: does not look like a full target in-frame.",
      debug: {
        threshold,
        whiteFrac: Number(whiteFrac.toFixed(2)),
        darkFrac: Number(darkFrac.toFixed(2)),
        areaFrac: Number(areaFrac.toFixed(2)),
        aspect: Number(aspect.toFixed(2)),
      },
    };
  }

  return {
    ok: true,
    region: { x: minX, y: minY, width: boxW, height: boxH },
    debug: {
      threshold,
      whiteFrac: Number(whiteFrac.toFixed(2)),
      darkFrac: Number(darkFrac.toFixed(2)),
      areaFrac: Number(areaFrac.toFixed(2)),
      aspect: Number(aspect.toFixed(2)),
    },
  };
}

/**
 * Detect bullet holes as dark blobs inside the detected target region.
 * Simple connected-components over a downsampled mask for speed.
 */
function detectShots(gray, w, h, region, threshold) {
  // Work only inside region
  const rx0 = region.x;
  const ry0 = region.y;
  const rx1 = region.x + region.width - 1;
  const ry1 = region.y + region.height - 1;

  // Build binary mask (dark pixels)
  const mask = new Uint8Array(region.width * region.height);
  let idx = 0;
  let candidates = 0;

  for (let y = ry0; y <= ry1; y++) {
    const row = y * w;
    for (let x = rx0; x <= rx1; x++) {
      const v = gray[row + x];
      const on = v <= threshold ? 1 : 0;
      mask[idx++] = on;
      if (on) candidates++;
    }
  }

  // Connected components on mask
  const rw = region.width;
  const rh = region.height;
  const visited = new Uint8Array(mask.length);

  function at(x, y) {
    return mask[y * rw + x];
  }

  const blobs = [];

  const qx = [];
  const qy = [];

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const mIndex = y * rw + x;
      if (!mask[mIndex] || visited[mIndex]) continue;

      // BFS
      visited[mIndex] = 1;
      qx.length = 0;
      qy.length = 0;
      qx.push(x);
      qy.push(y);

      let count = 0;
      let sumX = 0;
      let sumY = 0;

      while (qx.length) {
        const cx = qx.pop();
        const cy = qy.pop();
        count++;
        sumX += cx;
        sumY += cy;

        // 4-neighbor
        const n1x = cx - 1, n1y = cy;
        const n2x = cx + 1, n2y = cy;
        const n3x = cx, n3y = cy - 1;
        const n4x = cx, n4y = cy + 1;

        if (n1x >= 0) {
          const i = n1y * rw + n1x;
          if (at(n1x, n1y) && !visited[i]) { visited[i] = 1; qx.push(n1x); qy.push(n1y); }
        }
        if (n2x < rw) {
          const i = n2y * rw + n2x;
          if (at(n2x, n2y) && !visited[i]) { visited[i] = 1; qx.push(n2x); qy.push(n2y); }
        }
        if (n3y >= 0) {
          const i = n3y * rw + n3x;
          if (at(n3x, n3y) && !visited[i]) { visited[i] = 1; qx.push(n3x); qy.push(n3y); }
        }
        if (n4y < rh) {
          const i = n4y * rw + n4x;
          if (at(n4x, n4y) && !visited[i]) { visited[i] = 1; qx.push(n4x); qy.push(n4y); }
        }
      }

      // Filter out tiny noise & huge border blobs
      // (These bounds are intentionally broad; tune later if needed)
      if (count >= 20 && count <= 1200) {
        blobs.push({
          area: count,
          cx: sumX / count,
          cy: sumY / count,
        });
      }
    }
  }

  // Convert blob centers to absolute image coords
  const shots = blobs.map(b => ({
    area: b.area,
    x: rx0 + b.cx,
    y: ry0 + b.cy,
  }));

  return {
    shots,
    candidates,
  };
}

/**
 * Choose shotsUsed and compute POIB (mean center).
 * Keeps it simple: choose up to N closest to target center.
 */
function computePOIB(shots, targetCx, targetCy, maxUse = 7) {
  if (!shots.length) return { ok: false, error: "Image rejected: not enough shots detected (0)." };

  // Sort by distance to target center (bias toward cluster near bull)
  const sorted = shots
    .map(s => {
      const dx = s.x - targetCx;
      const dy = s.y - targetCy;
      return { ...s, d2: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d2 - b.d2);

  const used = sorted.slice(0, Math.min(maxUse, sorted.length));

  let sumX = 0, sumY = 0;
  for (const s of used) {
    sumX += s.x;
    sumY += s.y;
  }

  return {
    ok: true,
    poibCx: sumX / used.length,
    poibCy: sumY / used.length,
    shotsUsed: used.length,
    shotsDetected: shots.length,
  };
}

/**
 * ENGINE: px -> inches -> MOA -> clicks
 * Fix: separate X/Y scale
 */
function computeClicks(params) {
  const {
    poibCx,
    poibCy,
    targetCx,
    targetCy,
    region,
    distanceYards,
    moaPerClick,
    convention,
    flipWindage,
    flipElevation,
  } = params;

  const dxPx = poibCx - targetCx;
  const dyPx = poibCy - targetCy;

  // FIX: separate scaling (X uses region.width; Y uses region.height)
  const inPerPxX = TARGET_WIDTH_IN / region.width;
  const inPerPxY = TARGET_HEIGHT_IN / region.height;

  const dxIn = dxPx * inPerPxX;
  const dyIn = dyPx * inPerPxY;

  const ipm = inchesPerMoa(distanceYards);

  const windMoaRaw = dxIn / ipm;
  const elevMoaRaw = dyIn / ipm;

  const windClicksRaw = windMoaRaw / moaPerClick;
  const elevClicksRaw = elevMoaRaw / moaPerClick;

  let windClicks = windClicksRaw;
  let elevClicks = elevClicksRaw;

  // Convention matches your UI descriptions
  if (convention === "DIAL_TO_CENTER") {
    // impacts RIGHT => dial LEFT  (invert windage)
    // impacts LOW   => dial UP    (keep elev sign; dy+ => + clicks => UP)
    windClicks = -windClicksRaw;
    elevClicks = elevClicksRaw;
  } else if (convention === "DIAL_TO_GROUP") {
    // dial toward impacts:
    // impacts RIGHT => dial RIGHT (keep wind)
    // impacts LOW   => dial DOWN  (invert elev)
    windClicks = windClicksRaw;
    elevClicks = -elevClicksRaw;
  }

  if (flipWindage) windClicks *= -1;
  if (flipElevation) elevClicks *= -1;

  // Round to 2 decimals for SEC
  const windage_clicks = Math.round(windClicks * 100) / 100;
  const elevation_clicks = Math.round(elevClicks * 100) / 100;

  return {
    windage_clicks,
    elevation_clicks,
    debug: {
      dxPx: Number(dxPx.toFixed(2)),
      dyPx: Number(dyPx.toFixed(2)),
      inPerPxX: Number(inPerPxX.toFixed(6)),
      inPerPxY: Number(inPerPxY.toFixed(6)),
      dxIn: Number(dxIn.toFixed(3)),
      dyIn: Number(dyIn.toFixed(3)),
      inchesPerMoa: Number(ipm.toFixed(6)),
      windMoaRaw: Number(windMoaRaw.toFixed(4)),
      elevMoaRaw: Number(elevMoaRaw.toFixed(4)),
      windClicksRaw: Number(windClicksRaw.toFixed(4)),
      elevClicksRaw: Number(elevClicksRaw.toFixed(4)),
    },
  };
}

// -------------------- Routes --------------------

app.get("/", (req, res) => {
  res.type("text").send("SCZN3 SEC Backend is up");
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/sec", upload.single("file"), async (req, res) => {
  try {
    if (!sharp) {
      return res.status(500).json({ ok: false, error: "Server missing dependency: sharp" });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No image uploaded. Field name must be: file" });
    }

    // Defaults (normalized)
    const distanceYards = Number(req.body?.distanceYards ?? 100);
    const moaPerClick = Number(req.body?.moaPerClick ?? 0.25);
    const convention = String(req.body?.convention ?? "DIAL_TO_CENTER");
    const flipWindage = toBool(req.body?.flipWindage ?? false);
    const flipElevation = toBool(req.body?.flipElevation ?? false);

    const { w, h, gray } = await decodeToGray(req.file.buffer);

    // 1) Detect target region
    const regionResult = detectTargetRegion(gray, w, h);
    if (!regionResult.ok) {
      return res.status(422).json({
        ok: false,
        error: regionResult.error,
        debug: regionResult.debug,
      });
    }
    const region = regionResult.region;

    // 2) Target center
    const targetCx = region.x + region.width / 2;
    const targetCy = region.y + region.height / 2;

    // 3) Detect shots
    // Use a slightly darker threshold for shot candidates than border threshold
    const shotThreshold = clamp(regionResult.debug.threshold - 10, 40, 170);
    const shotResult = detectShots(gray, w, h, region, shotThreshold);

    // 4) Compute POIB (mean of chosen shots)
    const poib = computePOIB(shotResult.shots, targetCx, targetCy, 7);
    if (!poib.ok) {
      return res.status(422).json({
        ok: false,
        error: poib.error,
        debug: {
          threshold: shotThreshold,
          candidates: shotResult.candidates,
        },
      });
    }

    // 5) Compute clicks (ENGINE)
    const clicks = computeClicks({
      poibCx: poib.poibCx,
      poibCy: poib.poibCy,
      targetCx,
      targetCy,
      region,
      distanceYards,
      moaPerClick,
      convention,
      flipWindage,
      flipElevation,
    });

    // Response (matches your Hoppscotch + debug panel pattern)
    return res.status(200).json({
      ok: true,
      units: "CLICKS",
      convention,
      sec: {
        windage_clicks: clicks.windage_clicks,
        elevation_clicks: clicks.elevation_clicks,
      },
      debug: {
        ...regionResult.debug,
        shotsDetected: poib.shotsDetected,
        shotsUsed: poib.shotsUsed,
        threshold: shotThreshold,
        ...clicks.debug,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : "Unknown server error";
    return res.status(500).json({ ok: false, error: msg });
  }
});

// -------------------- Start --------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
