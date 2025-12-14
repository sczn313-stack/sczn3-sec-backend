// SCZN3 Shooter Experience Card (SEC) Backend API
// Simple Express server with a demo /api/sec endpoint

import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "SCZN3 SEC Backend",
    message: "After-Shot Intelligence online",
  });
});

// Helper: format all click values to two decimals as strings
function toTwoDecimals(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return "0.00";
  return num.toFixed(2);
}

// Core SEC endpoint (temporary DEMO logic)
app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    const requestedIndex = body.sec_index || "SEC-001";

    const result = {
      windage_clicks: toTwoDecimals(body.windage_clicks ?? 1.25),
      elevation_clicks: toTwoDecimals(body.elevation_clicks ?? -0.75),
      sec_index: requestedIndex,
    };

    res.json({
      ok: true,
      sec: result,
    });
  } catch (err) {
    console.error("Error in /api/sec:", err);
    res.status(500).json({
      ok: false,
      error: "Internal SEC backend error",
    });
  }
});

// Start server // --- Upload endpoint (must be ABOVE app.listen) ---
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }

  return res.json({
    ok: true,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});
// --- Upload endpoint (must be ABOVE app.listen) ---
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

  return res.json({
    ok: true,
    message: "Image received",
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on port ${PORT}`);
});
