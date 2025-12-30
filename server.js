/**
 * SCZN3 SEC Backend (PIPE) — “BULL LOGIC” LOCKED
 *
 * Conventions (LOCKED):
 * - POIB inches:
 *      x: Right +, Left -
 *      y: Up +, Down -
 * - Correction = move POIB to bull => correction = (0 - POIB) = -POIB
 * - Dial directions from CORRECTION signs (deterministic):
 *      windage  + => RIGHT,  - => LEFT
 *      elevation+ => UP,     - => DOWN
 *
 * NOTE:
 * - Image pixel Y grows DOWN.
 * - We flip exactly once when creating POIB.y (so POIB.y grows UP).
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

const BUILD_TAG = "BULL_LOGIC_LOCKED_v1_COMMONJS_NODE20";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

const app = express();
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------- helpers ----------
function n(x, fallback = NaN) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function round2(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function fmt2(x) {
  return round2(x).toFixed(2);
}

function parseTargetSpec(raw) {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  // Accept: "11", "8.5x11", "8.5×11", "8½x11"
  if (!s) return { ok: false, reason: "Target size required (ex: 8.5x11 or 11)." };

  const normalized = s
    .replace("×", "x")
    .replace("8½", "8.5")
    .replace("8.5x11", "8.5x11");

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const side = n(normalized);
    if (!Number.isFinite(side) || side <= 0) return { ok: false, reason: "Bad target size number." };
    // If user gives only 11, assume letter long side = 11, short = 8.5
    if (Math.abs(side - 11) < 0.01) return { ok: true, long: 11, short: 8.5, spec: "8.5x11" };
    // Otherwise treat as square-ish “long side”
    return { ok: true, long: side, short: side, spec: String(side) };
  }

  const m = normalized.match(/^(\d+(\.\d+)?)(x)(\d+(\.\d+)?)$/);
  if (!m) return { ok: false, reason: "Bad target size format. Use 8.5x11 or 11." };

  const a = n(m[1]);
  const b = n(m[4]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return { ok: false, reason: "Bad target size numbers." };
  }

  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return { ok: true, long, short, spec: `${short}x${long}` };
}

function inchesPerMoaAtYards(yards) {
  const y = n(yards);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  // True MOA: 1.047" at 100 yards
  return 1.047 * (y / 100);
}

function dialText(axisName, clicksSigned) {
  // clicksSigned is CORRECTION clicks
  const c = n(clicksSigned, 0);
  const mag = Math.abs(round2(c));
  if (axisName === "windage") {
    const dir = c < 0 ? "LEFT" : c > 0 ? "RIGHT" : "CENTER";
    return `${dir} ${mag.toFixed(2)} clicks`;
  }
  if (axisName === "elevation") {
    const dir = c < 0 ? "DOWN" : c > 0 ? "UP" : "LEVEL";
    return `${dir} ${mag.toFixed(2)} clicks`;
  }
  return `${mag.toFixed(2)} clicks`;
}

// ---------- minimal hole detection (for your clean test target images) ----------
// This is intentionally simple + deterministic for the “Grid Bull (Zeroing)” test images.
// If you later want perspective correction (photo at an angle), we can add fiducial-based warp.
async function detectHolesAndGroupCenter(buffer) {
  // normalize size for stable thresholds
  const resized = sharp(buffer).rotate().resize({ width: 1200, withoutEnlargement: true });

  const meta = await resized.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  if (!width || !height) {
    return { ok: false, reason: "IMAGE_READ_FAILED" };
  }

  const raw = await resized.raw().toBuffer(); // RGB/RGBA depending
  const channels = meta.channels || 3;

  // grayscale + threshold
  // Exclusion zones: borders + QR corner area + corner fiducials
  const borderX = Math.floor(width * 0.05);
  const borderY = Math.floor(height * 0.05);

  const qrX0 = Math.floor(width * 0.70);
  const qrY0 = Math.floor(height * 0.70);

  function isExcluded(x, y) {
    if (x < borderX || x > width - borderX) return true;
    if (y < borderY || y > height - borderY) return true;
    // QR region
    if (x > qrX0 && y > qrY0) return true;
    // corner fiducials (black squares) — crude boxes
    const box = Math.floor(Math.min(width, height) * 0.10);
    if (x < box && y < box) return true;
    if (x > width - box && y < box) return true;
    if (x < box && y > height - box) return true;
    if (x > width - box && y > height - box) return true;
    return false;
  }

  // Build a binary mask for “dark pixels”
  const dark = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = raw[idx] || 0;
      const g = raw[idx + 1] || 0;
      const b = raw[idx + 2] || 0;
      const gray = (r + g + b) / 3;

      if (isExcluded(x, y)) continue;

      // threshold tuned for your clean “test ready” target screenshots
      if (gray < 60) dark[y * width + x] = 1;
    }
  }

  // Connected components (4-neighbor) to find blobs (holes)
  const visited = new Uint8Array(width * height);
  const holes = [];

  function pushIfHole(area, sumX, sumY) {
    // Filter sizes — adjust if needed
    // Too small = noise; too big = thick grid lines / bull rings
    if (area < 80) return;
    if (area > 6000) return;

    const cx = sumX / area;
    const cy = sumY / area;

    // Additional reject: near center rings (bull rings are dark arcs)
    const dx = cx - width / 2;
    const dy = cy - height / 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < Math.min(width, height) * 0.08) return; // avoid center dot/rings

    holes.push({ cx, cy, area });
  }

  const q = [];
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || visited[i]) continue;

    // BFS flood fill
    visited[i] = 1;
    q.length = 0;
    q.push(i);

    let area = 0;
    let sumX = 0;
    let sumY = 0;

    while (q.length) {
      const p = q.pop();
      area++;

      const y = Math.floor(p / width);
      const x = p - y * width;

      sumX += x;
      sumY += y;

      // neighbors
      const left = p - 1;
      const right = p + 1;
      const up = p - width;
      const down = p + width;

      if (x > 0 && dark[left] && !visited[left]) {
        visited[left] = 1;
        q.push(left);
      }
      if (x < width - 1 && dark[right] && !visited[right]) {
        visited[right] = 1;
        q.push(right);
      }
      if (y > 0 && dark[up] && !visited[up]) {
        visited[up] = 1;
        q.push(up);
      }
      if (y < height - 1 && dark[down] && !visited[down]) {
        visited[down] = 1;
        q.push(down);
      }
    }

    pushIfHole(area, sumX, sumY);
  }

  if (!holes.length) {
    return { ok: false, reason: "HOLES_NOT_FOUND", width, height, holesDetected: 0 };
  }

  // Group center = average of hole centroids
  let sx = 0,
    sy = 0;
  for (const h of holes) {
    sx += h.cx;
    sy += h.cy;
  }
  const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };

  return {
    ok: true,
    width,
    height,
    holesDetected: holes.length,
    holes,
    groupCenterPx,
    centerPx: { x: width / 2, y: height / 2 }
  };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, service: SERVICE_NAME, status: "alive", build: BUILD_TAG }));
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    // Inputs
    const distanceYards = n(req.body?.distanceYards ?? 100, 100);
    const clickValueMoa = n(req.body?.clickValueMoa ?? 0.25, 0.25);
    const targetSpecRaw = req.body?.targetSizeInches ?? req.body?.targetSize ?? "8.5x11";

    const targetSpec = parseTargetSpec(targetSpecRaw);
    if (!targetSpec.ok) {
      res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "BAD_TARGET_SPEC", message: targetSpec.reason },
        })
      );
      return;
    }

    if (!req.file?.buffer) {
      res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "NO_IMAGE", message: "POST multipart/form-data with field name: image" },
        })
      );
      return;
    }

    // Detect holes + group center
    const det = await detectHolesAndGroupCenter(req.file.buffer);
    if (!det.ok) {
      res.status(200).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          computeStatus: "FAILED_HOLES",
          error: { code: det.reason, message: "No bullet holes detected. Use a clean, front-on target image." },
          detect: {
            normalized: { width: det.width, height: det.height },
            holesDetected: det.holesDetected,
          },
          sec: { distanceYards, clickValueMoa, targetSizeInches: targetSpec.long },
        })
      );
      return;
    }

    // Map pixels -> inches (simple scale; best for clean scans/screenshots)
    // Determine physical width/height based on image orientation
    const imgW = det.width;
    const imgH = det.height;

    const physLong = targetSpec.long;
    const physShort = targetSpec.short;

    const physW = imgW >= imgH ? physLong : physShort;
    const physH = imgW >= imgH ? physShort : physLong;

    const inchesPerPxX = physW / imgW;
    const inchesPerPxY = physH / imgH;

    // Bull center in pixels = image center
    const bullPx = det.centerPx;

    // Delta from bull to group center in IMAGE coordinates (Y down)
    const dxImgIn = (det.groupCenterPx.x - bullPx.x) * inchesPerPxX; // right +, left -
    const dyImgIn = (det.groupCenterPx.y - bullPx.y) * inchesPerPxY; // down +, up -

    // POIB inches (SCZN3 coords): x right + ; y up +  (flip once here)
    const poibInches = {
      x: round2(dxImgIn),
      y: round2(-dyImgIn)
    };

    // ---------- BULL LOGIC (deterministic, no “sometimes backwards”) ----------
    // Correction inches = move cluster to bull => -POIB
    const corrIn = {
      x: round2(-poibInches.x),
      y: round2(-poibInches.y)
    };

    // Convert inches -> clicks (True MOA)
    const inchesPerMoa = inchesPerMoaAtYards(distanceYards);
    const inchesPerClick = inchesPerMoa * clickValueMoa;

    if (!Number.isFinite(inchesPerClick) || inchesPerClick <= 0) {
      res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "BAD_MOA", message: "distanceYards and clickValueMoa must be valid." },
        })
      );
      return;
    }

    // Signed CORRECTION clicks
    const clicksSigned = {
      windage: round2(corrIn.x / inchesPerClick),
      elevation: round2(corrIn.y / inchesPerClick)
    };

    // Minimal “Scope Clicks”
    const scopeClicksMinimal = {
      windage: clicksSigned.windage < 0 ? `LEFT ${fmt2(Math.abs(clicksSigned.windage))} clicks`
             : clicksSigned.windage > 0 ? `RIGHT ${fmt2(Math.abs(clicksSigned.windage))} clicks`
             : `CENTER 0.00 clicks`,
      elevation: clicksSigned.elevation < 0 ? `DOWN ${fmt2(Math.abs(clicksSigned.elevation))} clicks`
              : clicksSigned.elevation > 0 ? `UP ${fmt2(Math.abs(clicksSigned.elevation))} clicks`
              : `LEVEL 0.00 clicks`
    };

    // Also provide “dial” strings derived ONLY from clicksSigned (same truth source)
    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation)
    };

    res.status(200).send(
      JSON.stringify({
        ok: true,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        received: {
          field: "image",
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          bytes: req.file.size
        },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeInches: targetSpec.long
        },
        computeStatus: "COMPUTED_FROM_IMAGE",
        poibInches,
        clicksSigned,
        dial,
        scopeClicksMinimal,
        detect: {
          normalized: { width: det.width, height: det.height },
          holesDetected: det.holesDetected,
          groupCenterPx: det.groupCenterPx,
          bullCenterPx: bullPx
        }
      })
    );
  } catch (e) {
    res.status(500).send(
      JSON.stringify({
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "SERVER_ERROR", message: String(e?.message || e) },
      })
    );
  }
});

// Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT} (${BUILD_TAG})`);
});
