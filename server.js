// server.js (CommonJS)

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();

// --- CORS (allow your static site to call this API) ---
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.options("*", cors());

// --- middleware ---
app.use(express.json());

// --- health check (keep permanently) ---
app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// --- quick root check ---
app.get("/", (_req, res) => {
  return res.status(200).send("SCZN3 SEC Backend is up");
});

// --- upload endpoint (matches your Upload Test page) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

function handleUpload(req, res) {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No file received. Expected field name: file" });
  }

  return res.status(200).json({
    ok: true,
    received: {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    },
  });
}

// Accept BOTH routes in case your frontend uses either
app.post("/upload", upload.single("file"), handleUpload);
app.post("/api/upload", upload.single("file"), handleUpload);

// --- Render port binding ---
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
