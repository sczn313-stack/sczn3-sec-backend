// server.js
const express = require("express");

const app = express();

// ---- middleware ----
app.use(express.json());

// ---- health check (keep permanently) ----
app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// ---- optional root (nice for quick browser check) ----
app.get("/", (_req, res) => {
  return res.status(200).send("SCZN3 SEC Backend is running.");
});

// ---- Render port binding ----
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SCZN3 SEC Backend listening on port ${PORT}`);
});
