// server.js
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();

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

// Simple health + route list
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    routes: ["GET /", "GET /api/health", "POST /api/upload", "POST /api/sec"],
  });
});

// Upload test endpoint
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

// SEC endpoint (placeholder response so the pipeline works end-to-end)
app.post("/api/sec", upload.single("file"), (req, res) => {
  // Accept file OR JSON. For now we just prove the endpoint works.
  const hasFile = !!req.file;

  res.json({
    ok: true,
    mode: hasFile ? "multipart" : "json",
    sec: {
      windage_clicks: -0.25,
      elevation_clicks: +0.50,
    },
    note: "SEC endpoint is live (placeholder output). Wire real SCZN3 math next.",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
