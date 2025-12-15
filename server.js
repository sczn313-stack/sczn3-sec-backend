import express from "express";

import cors from "cors";

import multer from "multer";



const app = express();

const PORT = process.env.PORT || 10000;



app.use(cors({ origin: true }));

app.use(express.json());



const upload = multer({

  storage: multer.memoryStorage(),

  limits: { fileSize: 10 * 1024 * 1024 } // 10MB

});



app.get("/__build", (req, res) => {

  res.json({ build: "sec-fakeclicks-v1" });

});



app.get("/", (req, res) => {

  res.json({ status: "ok", service: "SCZN3 backend" });

});



app.get("/health", (req, res) => {

  res.json({ ok: true });

});



app.post("/api/upload", upload.single("image"), (req, res) => {

  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });



  res.json({

    ok: true,

    message: "Image received",

    filename: req.file.originalname,

    mimetype: req.file.mimetype,

    size: req.file.size

  });

});



app.post("/api/sec", upload.single("image"), (req, res) => {

  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });



  // fake demo clicks (two decimals)

  const up = 1.25;

  const right = -0.75;



  res.json({ ok: true, up: up.toFixed(2), right: right.toFixed(2) });

});



app.listen(PORT, () => console.log(`SCZN3 backend running on port ${PORT}`));
