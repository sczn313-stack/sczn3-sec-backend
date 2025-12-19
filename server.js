// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();

// =====================
// Config (SCZN3 defaults)
// =====================
const DISTANCE_YARDS = Number(process.env.DISTANCE_YARDS ?? 100);
const MOA_PER_CLICK = Number(process.env.MOA_PER_CLICK ?? 0.25);
const TARGET_WIDTH_IN = Number(process.env.TARGET_WIDTH_IN ?? 23);

// Image / detection tuning
const MAX_W = Number(process.env.MAX_W ?? 1200);          // downscale for speed
const DARK_THRESH = Number(process.env.DARK_THRESH ?? 70); // 0..255 lower = darker
const MIN_BLOB_AREA = Number(process.env.MIN_BLOB_AREA ?? 25);
const MAX_BLOB_AREA = Number(process.env.MAX_BLOB_AREA ?? 2500);
const MAX_ASPECT = Number(process.env.MAX_ASPECT ?? 3.0);
const MIN_FILL = Number(process.env.MIN_FILL ?? 0.20);
const MIN_SHOTS = Number(process.env.MIN_SHOTS ?? 3);
const MAX_SHOTS = Number(process.env.MAX_SHOTS ?? 7);

function clampNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

// CORS: allow all for now (safe for dev). Tighten later.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

app.get("/", (req, res) => {
  res.status(200).send("SCZN3 SEC Backend is up");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    routes: ["GET /", "GET /api/health", "POST /api/upload", "POST /api/sec"],
  });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file received (field name must be: file)" });
  }

  res.json({
    ok: true,
    received: {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    },
  });
});

function findBBoxOfDark(gray, w, h, thresh) {
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < thresh) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function connectedComponents(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const comps = [];

  const idxToXY = (i) => [i % w, (i / w) | 0];

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i]) continue;

    const stack = [i];
    visited[i] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;

    while (stack.length) {
      const cur = stack.pop();
      area++;

      const x = cur % w;
      const y = (cur / w) | 0;

      sumX += x;
      sumY += y;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      // 4-neighbors
      const left = cur - 1;
      const right = cur + 1;
      const up = cur - w;
      const down = cur + w;

      if (x > 0 && mask[left] && !visited[left]) { visited[left] = 1; stack.push(left); }
      if (x < w - 1 && mask[right] && !visited[right]) { visited[right] = 1; stack.push(right); }
      if (y > 0 && mask[up] && !visited[up]) { visited[up] = 1; stack.push(up); }
      if (y < h - 1 && mask[down] && !visited[down]) { visited[down] = 1; stack.push(down); }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fill = area / (bw * bh);

    comps.push({
      area,
      cx: sumX / area,
      cy: sumY / area,
      minX, minY, maxX, maxY,
      bw, bh,
      aspect: Math.max(bw / bh, bh / bw),
      fill,
    });
  }

  return comps;
}

function pickTightestCluster(points, kMax) {
  if (points.length <= kMax) return points;

  // provisional center
  const mx = points.reduce((a, p) => a + p.cx, 0) / points.length;
  const my = points.reduce((a, p) => a + p.cy, 0) / points.length;

  const scored = points
    .map((p) => ({ p, d2: (p.cx - mx) ** 2 + (p.cy - my) ** 2 }))
    .sort((a, b) => a.d2 - b.d2);

  return scored.slice(0, kMax).map((s) => s.p);
}

function inchesPerMOA(distanceYds) {
  // 1 MOA at 100 yards ≈ 1.047 inches
  return 1.047 * (distanceYds / 100);
}

// =====================
// REAL SEC endpoint
// =====================
app.post("/api/sec", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No image uploaded. Field name must be: file" });
    }

    // Decode + downscale + grayscale
    const img = sharp(req.file.buffer).rotate();
    const meta = await img.metadata();

    const resized = img.resize({ width: MAX_W, withoutEnlargement: true });

    const { data, info } = await resized
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // Find target-ish bbox (dark pixels)
    const bbox = findBBoxOfDark(data, w, h, DARK_THRESH);
    if (!bbox || bbox.width < 200 || bbox.height < 200) {
      return res.status(422).json({
        ok: false,
        error: "Could not detect target area. Try a clearer photo with the full target in frame.",
      });
    }

    const targetCx = bbox.minX + bbox.width / 2;
    const targetCy = bbox.minY + bbox.height / 2;

    // Create binary mask of dark pixels INSIDE bbox (saves work + reduces background noise)
    const mask = new Uint8Array(w * h);
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        const i = y * w + x;
        mask[i] = data[i] < DARK_THRESH ? 1 : 0;
      }
    }

    // Connected components
    const comps = connectedComponents(mask, w, h);

    // Filter for "hole-like" blobs
    const candidates = comps.filter((c) => {
      if (c.area < MIN_BLOB_AREA || c.area > MAX_BLOB_AREA) return false;
      if (c.aspect > MAX_ASPECT) return false;
      if (c.fill < MIN_FILL) return false;

      // also avoid huge structures (like thick borders) by excluding very large bbox
      if (c.bw > bbox.width * 0.20 || c.bh > bbox.height * 0.20) return false;

      // keep inside bbox (already mostly true)
      if (c.cx < bbox.minX || c.cx > bbox.maxX || c.cy < bbox.minY || c.cy > bbox.maxY) return false;
      return true;
    });

    if (candidates.length < MIN_SHOTS) {
      return res.status(422).json({
        ok: false,
        error: `Not enough shots detected (${candidates.length}). Need at least ${MIN_SHOTS}. Use a clearer target photo with visible holes.`,
        debug: {
          candidates: candidates.length,
          w, h,
          bbox,
        },
      });
    }

    // Outlier control: keep tightest cluster up to MAX_SHOTS
    const cluster = pickTightestCluster(candidates, MAX_SHOTS);

    // POI balance (centroid of cluster)
    const poiCx = cluster.reduce((a, p) => a + p.cx, 0) / cluster.length;
    const poiCy = cluster.reduce((a, p) => a + p.cy, 0) / cluster.length;

    // Pixel offsets from target center
    const dxPx = poiCx - targetCx; // +right
    const dyPx = poiCy - targetCy; // +down

    // Scale pixels -> inches using target bbox width
    const inchPerPx = TARGET_WIDTH_IN / bbox.width;
    const dxIn = dxPx * inchPerPx; // +right
    const dyIn = dyPx * inchPerPx; // +down

    // Convert inches -> MOA -> clicks
    const inPerMoa = inchesPerMOA(DISTANCE_YARDS);

    const windMoa = dxIn / inPerMoa; // +right impacts
    const elevMoa = dyIn / inPerMoa; // +down impacts

    // Corrections in clicks to move impacts to center:
    // - Wind: impacts right => dial left => negative
    // - Elev: impacts low (down) => dial up => positive
    const windClicks = -(windMoa / MOA_PER_CLICK);
    const elevClicks = +(elevMoa / MOA_PER_CLICK);

    res.json({
      ok: true,
      sec: {
        windage_clicks: Number(windClicks.toFixed(2)),
        elevation_clicks: Number(elevClicks.toFixed(2)),
      },
      debug: {
        image: { inW: meta.width, inH: meta.height, outW: w, outH: h },
        bbox,
        shots_detected: candidates.length,
        shots_used: cluster.length,
        offsets: {
          dxPx: Number(dxPx.toFixed(1)),
          dyPx: Number(dyPx.toFixed(1)),
          dxIn: Number(dxIn.toFixed(2)),
          dyIn: Number(dyIn.toFixed(2)),
        },
        config: {
          DISTANCE_YARDS,
          MOA_PER_CLICK,
          TARGET_WIDTH_IN,
          DARK_THRESH,
          MIN_BLOB_AREA,
          MAX_BLOB_AREA,
          MAX_ASPECT,
          MIN_FILL,
        },
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "SEC processing failed",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
