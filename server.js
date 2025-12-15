/ backend/server.js

const express = require("express");

const cors = require("cors");

const multer = require("multer");



const app = express();

const PORT = process.env.PORT || 3000;



// Middleware

app.use(cors({ origin: true }));

app.use(express.json({ limit: "10mb" }));



// Multer (memory upload)

const upload = multer({

  storage: multer.memoryStorage(),

  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB

});



// Health check

app.get("/", (req, res) => {

  res.json({ status: "ok", service: "SCZN3 backend" });

});



// Simple upload endpoint (expects form-data key: "image")

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



// Placeholder analyze endpoint (expects form-data key: "target")

app.post("/api/analyze", upload.single("target"), (req, res) => {

  if (!req.file) {

    return res.status(400).json({ ok: false, error: "No file uploaded" });

  }



  
