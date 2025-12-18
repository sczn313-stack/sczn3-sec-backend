
// server.js
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health / home
app.get("/", (req, res) => {
  res.status(200).send("SCZN3 SEC Backend is up");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Upload endpoint (matches frontend /api/upload)
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file received (field name must be 'file')." });
  }

  return res.status(200).json({
    ok: true,
    received: {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    },
  });
});

// SEC endpoint (matches frontend /api/sec)
app.post("/api/sec", (req, res) => {
  // Placeholder response so the pipeline works end-to-end.
  // Replace this logic later with your real SEC math.
  return res.status(200).json({
    ok: true,
    sec: {
      windage_clicks: 0.0,
      elevation_clicks: 0.0,
    },
    note: "SEC endpoint is wired. Math not implemented yet.",
  });
});

// Helpful 404 for anything else
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
