import express from "express";

import cors from "cors";

import multer from "multer";



const app = express();

const PORT = process.env.PORT || 10000;



app.use(cors({ origin: true }));

app.use(express.json());



// Multer: keep uploads in memory (good for now)

const upload = multer({

  storage: multer.memoryStorage(),

  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB

});



// ---------- GET: sanity routes ----------

app.get("/", (req, res) => {

  res.json({ status: "ok", service: "SCZN3 backend" });

});



app.get("/health", (req, res) => {

  res.json({ ok: true });

});



// ---------- POST: upload test ----------

app.post("/api/upload", upload.single("image"), (req, res) => {

  try {

    if (!req.file) {

      return res.status(400).json({ ok: false, error: "No file uploaded" });

    }



    return res.json({

      ok: true,

      message: "Image received",

      filename: req.file.originalname,

      mimetype: req.file.mimetype,

      size: req.file.size,

    });

  } catch (err) {

    return res.status(500).json({ ok: false, error: "Upload failed" });

  }

});



// ---------- POST: SEC stub (fake clicks) ----------

app.post("/api/sec", upload.single("image"), (req, res) => {

  try {

    if (!req.file) {

      return res.status(400).json({ ok: false, error: "No file uploaded" });

    }



    // Fake non-zero click outputs (string w/ 2 decimals)

    // Use fixed values so your frontend is easy to test.

    return res.json({

      ok: true,

      up: "1.25",

      right: "-0.75",

    });

  } catch (err) {

    return res.status(500).json({ ok: false, error: "SEC failed" });

  }

});



app.listen(PORT, () => {

  console.log(`SCZN3 backend listening on ${PORT}`);

});
