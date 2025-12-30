// server.js — SCZN3 SEC Backend (BULL_LOCKED_V1)
// Always returns JSON
// POST /api/sec (multipart form-data field: "image")
//
// BULL LOGIC (deterministic):
// - Find 4 corner fiducials (black squares) to define the inner target rectangle.
// - Detect bullet-hole blobs (filters out lines/grid artifacts).
// - Compute group center in inches.
// - POIB convention: Right +, Up +
// - Dial/correction = move group to bull (opposite of POIB):
//     clicksSigned.windage  > 0 => RIGHT, < 0 => LEFT
//     clicksSigned.elevation > 0 => UP,    < 0 => DOWN
//
// NOTE: If holesDetected is huge (like 18), your image has line artifacts being detected.
// This code reduces that by filtering long/thin blobs and excluding fiducial zones,
// but you still want clean photos/crops for best results.

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "BULL_LOCKED_V1";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// CORS (allow your static UI)
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

// ---------- helpers ----------
function round2num(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}
function fmt2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "NaN";
  return (Math.round(x * 100) / 100).toFixed(2);
}

function parseTargetSizeSpec(specRaw) {
  const s = String(specRaw ?? "").trim().toLowerCase().replace("×", "x");
  if (!s) return { ok: false, reason: "TARGET_SIZE_REQUIRED" };

  // Accept: "8.5x11", "8.5 x 11", "11", "23"
  const compact = s.replace(/\s+/g, "");
  if (compact === "11") return { ok: true, targetSizeSpec: "11", widthIn: 8.5, heightIn: 11 };
  if (compact === "8.5x11" || compact === "8.5x11.0" || compact === "8.50x11" || compact === "8.50x11.0")
    return { ok: true, targetSizeSpec: "8.5x11", widthIn: 8.5, heightIn: 11 };

  if (compact === "23") return { ok: true, targetSizeSpec: "23", widthIn: 23, heightIn: 23 };
  if (compact === "23x23") return { ok: true, targetSizeSpec: "23x23", widthIn: 23, heightIn: 23 };

  const m = compact.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      return { ok: true, targetSizeSpec: `${a}x${b}`, widthIn: a, heightIn: b };
    }
  }

  return { ok: false, reason: "TARGET_SIZE_UNSUPPORTED", raw: s };
}

function inchesPerClickAtYards(yards, clickValueMoa) {
  const y = Number(yards);
  const c = Number(clickValueMoa);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  if (!Number.isFinite(c) || c <= 0) return NaN;
  const inchesPerMoa = 1.047 * (y / 100);
  return inchesPerMoa * c;
}

function dialText(axis, signedClicks) {
  const v = Number(signedClicks);
  if (!Number.isFinite(v)) return `${axis.toUpperCase()}: NaN clicks`;
  const mag = Math.abs(v);
  const dir = axis === "windage" ? (v >= 0 ? "RIGHT" : "LEFT") : (v >= 0 ? "UP" : "DOWN");
  return `${dir} ${fmt2(mag)} clicks`;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ---------- image + blob detection (pure JS) ----------
// Strategy:
// 1) Downscale for speed.
// 2) Threshold dark pixels.
// 3) Connected-components to get blobs.
// 4) Identify 4 fiducials (largest blobs near corners).
// 5) Filter remaining blobs to likely holes (not thin lines, not huge, not in fiducial zones).
async function detectBlobsFromImage(buffer) {
  // Resize to keep work bounded (important on Render)
  const MAX_W = 900;

  const { data, info } = await sharp(buffer)
    .rotate() // respect EXIF orientation
    .resize({ width: MAX_W, withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("rgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // Make a binary mask: "dark pixel" = 1
  // Threshold tuned for printed targets. Adjust if needed.
  const DARK_T = 70;

  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    // luma
    const gray = (r * 299 + g * 587 + b * 114) / 1000;
    mask[i] = gray < DARK_T ? 1 : 0;
  }

  // Connected components (8-neighbor)
  const visited = new Uint8Array(w * h);
  const blobs = [];

  // Limits to avoid runaway on large line components
  const HARD_MAX_AREA = Math.floor((w * h) * 0.08); // 8% of image

  const stack = []; // reused
  for (let y = 0; y < h; y++) {
    let row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (!mask[idx] || visited[idx]) continue;

      // BFS/DFS
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      let tooBig = false;

      while (stack.length) {
        const cur = stack.pop();
        area++;
        if (area > HARD_MAX_AREA) {
          tooBig = true;
          // we still drain stack but don't keep stats further
        }

        const cy = Math.floor(cur / w);
        const cx = cur - cy * w;

        if (!tooBig) {
          sumX += cx;
          sumY += cy;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
        }

        // neighbors (8)
        for (let ny = cy - 1; ny <= cy + 1; ny++) {
          if (ny < 0 || ny >= h) continue;
          const nrow = ny * w;
          for (let nx = cx - 1; nx <= cx + 1; nx++) {
            if (nx < 0 || nx >= w) continue;
            const nidx = nrow + nx;
            if (!mask[nidx] || visited[nidx]) continue;
            visited[nidx] = 1;
            stack.push(nidx);
          }
        }
      }

      if (tooBig) continue;

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const bboxArea = bboxW * bboxH;
      const fill = bboxArea > 0 ? area / bboxArea : 0;

      blobs.push({
        area,
        cx: sumX / area,
        cy: sumY / area,
        minX,
        minY,
        maxX,
        maxY,
        bboxW,
        bboxH,
        fill,
      });
    }
  }

  // Sort biggest first (for fiducials)
  blobs.sort((a, b) => b.area - a.area);

  // Pick best blob per corner (largest blob whose centroid is in that corner region)
  const cornerRegionX = w * 0.25;
  const cornerRegionY = h * 0.25;

  function cornerKey(b) {
    const left = b.cx < cornerRegionX;
    const right = b.cx > w - cornerRegionX;
    const top = b.cy < cornerRegionY;
    const bottom = b.cy > h - cornerRegionY;
    if (left && top) return "TL";
    if (right && top) return "TR";
    if (left && bottom) return "BL";
    if (right && bottom) return "BR";
    return null;
  }

  const fid = { TL: null, TR: null, BL: null, BR: null };

  for (const b of blobs) {
    const k = cornerKey(b);
    if (!k) continue;
    // fiducials should be fairly square and dense
    const ar = b.bboxW / b.bboxH;
    if (ar < 0.6 || ar > 1.6) continue;
    if (b.fill < 0.55) continue;
    if (!fid[k]) fid[k] = b;
    if (fid.TL && fid.TR && fid.BL && fid.BR) break;
  }

  const fiducialsOk = !!(fid.TL && fid.TR && fid.BL && fid.BR);

  // Define inner rectangle bounds using fiducial centroids (good enough for “mostly straight” photos)
  // If fiducials missing, fallback to full image
  const leftPx = fiducialsOk ? (fid.TL.cx + fid.BL.cx) / 2 : 0;
  const rightPx = fiducialsOk ? (fid.TR.cx + fid.BR.cx) / 2 : w;
  const topPx = fiducialsOk ? (fid.TL.cy + fid.TR.cy) / 2 : 0;
  const bottomPx = fiducialsOk ? (fid.BL.cy + fid.BR.cy) / 2 : h;

  const rect = {
    left: Math.min(leftPx, rightPx),
    right: Math.max(leftPx, rightPx),
    top: Math.min(topPx, bottomPx),
    bottom: Math.max(topPx, bottomPx),
  };

  // Hole candidates:
  // - not too big (avoid fiducials)
  // - not too thin (avoid grid lines)
  // - fairly compact fill
  const minHoleArea = 25;   // tune if needed
  const maxHoleArea = 2500; // tune if needed

  const holes = [];
  for (const b of blobs) {
    // skip fiducials themselves
    if (fiducialsOk) {
      if (b === fid.TL || b === fid.TR || b === fid.BL || b === fid.BR) continue;
    }

    if (b.area < minHoleArea || b.area > maxHoleArea) continue;

    const ar = b.bboxW / b.bboxH;

    // kill long/thin line blobs
    if (b.bboxW > 120 || b.bboxH > 120) continue;
    if (ar < 0.25 || ar > 4.0) continue;

    // fill ratio to reject skinny strokes
    if (b.fill < 0.20) continue;

    // exclude anything too close to fiducial corners (where tick marks & text live)
    const cornerPadX = w * 0.12;
    const cornerPadY = h * 0.12;
    const inCorner =
      (b.cx < cornerPadX && b.cy < cornerPadY) ||
      (b.cx > w - cornerPadX && b.cy < cornerPadY) ||
      (b.cx < cornerPadX && b.cy > h - cornerPadY) ||
      (b.cx > w - cornerPadX && b.cy > h - cornerPadY);
    if (inCorner) continue;

    // keep candidates mainly inside inner rect
    if (b.cx < rect.left || b.cx > rect.right || b.cy < rect.top || b.cy > rect.bottom) continue;

    holes.push({
      cx: b.cx,
      cy: b.cy,
      area: b.area,
      bboxW: b.bboxW,
      bboxH: b.bboxH,
      fill: b.fill,
    });
  }

  return {
    normalized: { width: w, height: h },
    fiducials: fiducialsOk
      ? {
          TL: { x: fid.TL.cx, y: fid.TL.cy, area: fid.TL.area },
          TR: { x: fid.TR.cx, y: fid.TR.cy, area: fid.TR.area },
          BL: { x: fid.BL.cx, y: fid.BL.cy, area: fid.BL.area },
          BR: { x: fid.BR.cx, y: fid.BR.cy, area: fid.BR.area },
        }
      : null,
    rectPx: rect,
    holes,
  };
}

function mapPxToInches(ptPx, rectPx, widthIn, heightIn) {
  const rx = rectPx.right - rectPx.left;
  const ry = rectPx.bottom - rectPx.top;
  if (!(rx > 10 && ry > 10)) return { x: NaN, y: NaN };

  const nx = (ptPx.x - rectPx.left) / rx;   // 0..1 left->right
  const ny = (ptPx.y - rectPx.top) / ry;    // 0..1 top->bottom

  return {
    x: nx * widthIn,
    y: ny * heightIn,
  };
}

function bullInchesForTarget(widthIn, heightIn) {
  // Default: center
  let bx = widthIn / 2;
  let by = heightIn / 2;

  // Locked IGT 8.5x11 Grid v1 bull location (inches)
  // bull at (4.25, 5.50) on an 8.5x11 sheet
  if (Math.abs(widthIn - 8.5) < 0.01 && Math.abs(heightIn - 11) < 0.01) {
    bx = 4.25;
    by = 5.5;
  }

  return { x: bx, y: by };
}

function chooseCluster(holes, maxKeep = 7) {
  if (holes.length <= maxKeep) return holes;

  // pick maxKeep closest to the rough centroid
  let sx = 0,
    sy = 0;
  for (const h of holes) {
    sx += h.cx;
    sy += h.cy;
  }
  const cx = sx / holes.length;
  const cy = sy / holes.length;

  const sorted = [...holes].sort((a, b) => dist2(a.cx, a.cy, cx, cy) - dist2(b.cx, b.cy, cx, cy));
  return sorted.slice(0, maxKeep);
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.status(200).send(
    JSON.stringify(
      {
        ok: true,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        status: "alive",
        hint: "POST multipart to /api/sec with field name 'image'",
      },
      null,
      2
    )
  );
});

// Helpful so you don’t see “Cannot GET /api/sec” and think it’s dead
app.get("/api/sec", (req, res) => {
  res.status(200).send(
    JSON.stringify(
      {
        ok: true,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        note: "Use POST /api/sec (multipart form-data) with image field name 'image'.",
      },
      null,
      2
    )
  );
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const distanceYards = Number(req.body?.distanceYards ?? req.body?.distance ?? 100);
    const clickValueMoa = Number(req.body?.clickValueMoa ?? req.body?.clickValue ?? 0.25);
    const targetSizeSpec = req.body?.targetSizeSpec ?? req.body?.targetSize ?? req.body?.targetSizeInches ?? "";

    const parsed = parseTargetSizeSpec(targetSizeSpec);
    if (!parsed.ok) {
      return res.status(400).send(
        JSON.stringify(
          {
            ok: false,
            service: SERVICE_NAME,
            build: BUILD_TAG,
            computeStatus: "FAILED_INPUT",
            error: { code: parsed.reason, targetSizeSpec },
          },
          null,
          2
        )
      );
    }

    if (!req.file?.buffer) {
      return res.status(400).send(
        JSON.stringify(
          {
            ok: false,
            service: SERVICE_NAME,
            build: BUILD_TAG,
            computeStatus: "FAILED_INPUT",
            error: { code: "IMAGE_REQUIRED", message: "POST multipart field 'image' is required." },
          },
          null,
          2
        )
      );
    }

    const widthIn = parsed.widthIn;
    const heightIn = parsed.heightIn;
    const targetSizeInches = Math.max(widthIn, heightIn);

    const ipc = inchesPerClickAtYards(distanceYards, clickValueMoa);
    if (!Number.isFinite(ipc)) {
      return res.status(400).send(
        JSON.stringify(
          {
            ok: false,
            service: SERVICE_NAME,
            build: BUILD_TAG,
            computeStatus: "FAILED_INPUT",
            error: { code: "BAD_DISTANCE_OR_CLICKVALUE", distanceYards, clickValueMoa },
          },
          null,
          2
        )
      );
    }

    const detect = await detectBlobsFromImage(req.file.buffer);

    // If we found too many “holes”, keep the densest cluster subset
    const holeCandidates = detect.holes;
    if (!holeCandidates.length) {
      return res.status(200).send(
        JSON.stringify(
          {
            ok: true,
            service: SERVICE_NAME,
            build: BUILD_TAG,
            received: {
              originalName: req.file.originalname,
              bytes: req.file.size,
              mimetype: req.file.mimetype,
            },
            sec: { distanceYards, clickValueMoa, targetSizeSpec: parsed.targetSizeSpec, widthIn, heightIn, targetSizeInches },
            computeStatus: "FAILED_HOLES",
            error: { code: "HOLES_NOT_FOUND", message: "No bullet holes detected. Crop tighter and ensure high contrast." },
            detect: {
              normalized: detect.normalized,
              fiducials: detect.fiducials,
              rectPx: detect.rectPx,
              holesDetected: 0,
              holes: [],
            },
          },
          null,
          2
        )
      );
    }

    const clustered = chooseCluster(holeCandidates, 7);

    // group center px = average
    let sx = 0,
      sy = 0;
    for (const h of clustered) {
      sx += h.cx;
      sy += h.cy;
    }
    const groupCenterPx = { x: sx / clustered.length, y: sy / clustered.length };

    // Map to inches (top->bottom y increases down)
    const groupCenterIn = mapPxToInches(groupCenterPx, detect.rectPx, widthIn, heightIn);

    const bullIn = bullInchesForTarget(widthIn, heightIn);

    // POIB inches (Right +, Up +)
    // x: right positive => group - bull
    // y: up positive => bull - group (because inches-y increases downward from top)
    const poibX = groupCenterIn.x - bullIn.x;
    const poibY = bullIn.y - groupCenterIn.y;

    // Correction inches = move impact to bull => negative of POIB
    const corrX = -poibX; // + means dial RIGHT
    const corrY = -poibY; // + means dial UP

    const clicksSigned = {
      windage: round2num(corrX / ipc),
      elevation: round2num(corrY / ipc),
    };

    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation),
    };

    return res.status(200).send(
      JSON.stringify(
        {
          ok: true,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          received: {
            originalName: req.file.originalname,
            bytes: req.file.size,
            mimetype: req.file.mimetype,
          },
          sec: {
            distanceYards,
            clickValueMoa,
            targetSizeSpec: parsed.targetSizeSpec,
            widthIn,
            heightIn,
            targetSizeInches, // IMPORTANT: numeric (fixes your UI "BACKEND_MISSING_TARGET_SIZE")
          },
          computeStatus: "COMPUTED_FROM_IMAGE",
          detect: {
            normalized: detect.normalized,
            fiducials: detect.fiducials,
            rectPx: detect.rectPx,
            holesDetected: clustered.length,
            holes: clustered,
            groupCenterPx,
            groupCenterIn,
            bullIn,
          },
          poibInches: { x: round2num(poibX), y: round2num(poibY) },
          clicksSigned,
          dial,
        },
        null,
        2
      )
    );
  } catch (err) {
    return res.status(500).send(
      JSON.stringify(
        {
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          computeStatus: "FAILED_SERVER",
          error: { code: "SERVER_ERROR", message: String(err?.message || err) },
        },
        null,
        2
      )
    );
  }
});

// Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`${SERVICE_NAME} ${BUILD_TAG} listening on ${PORT}`);
});
