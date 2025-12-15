app.post("/api/sec", upload.single("image"), (req, res) => {

  if (!req.file) {

    return res.status(400).json({ ok: false, error: "No file uploaded" });

  }



  // Deterministic fake clicks based on file size + filename length

  const seed = (req.file.size || 0) + (req.file.originalname?.length || 0);



  // Up: 0.25 to 4.24

  const up = (((seed % 400) / 100) + 0.25).toFixed(2);



  // Right: -0.10 to -3.09

  const right = (-(((seed % 300) / 100) + 0.10)).toFixed(2);



  return res.json({

    ok: true,

    up,

    right,

  });

});
