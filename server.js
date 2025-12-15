import express from "express";

import cors from "cors";

import multer from "multer";



const app = express();

const PORT = process.env.PORT || 10000;



app.use(cors({ origin: true }));

app.use(express.json());



const upload = multer({

  storage: multer.memoryStorage(),

  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB

});



// --------------------

// ROOT + HEALTH CHECKS

// --------------------

app.get("/", (req, res) => {

  res.json({ status: "ok", service: "SCZN3 backend" });

});



app.get("/health", (req, res) => {

  res.json({ ok: true });

});



// --------------------

// UPLOAD TEST ENDPOINT

// --------------------

app.post("/api/upload", upload.single("image"), (req, res) => {

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

});



// --------------------

// SEC ENDPOINT (stub)

// --------------------

app.post("/api/sec", upload.single("image"), (req, res) => {

  try {

    if (!req.file) {

      return res.status(400).json({ ok: false, error: "No file uploaded" });

    }



    // TODO later: SCZN3 math using req.file.buffer



    // Customer-facing output: clicks only, two decimals

    return res.json({

      ok: true,

      up: "0.00",

      right: "0.00",

    });

  } catch (err) {

    console.error("SEC ERROR:", err);

    return res.status(500).json({ ok: false, error: "Internal server error" });

  }

});



// --------------------

// START SERVER

// --------------------

app.listen(PORT, () => {

  console.log(`SCZN3 backend listening on port ${PORT}`);

});
