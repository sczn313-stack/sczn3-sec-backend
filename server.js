import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

// Root route: shows what routes are live (so you can confirm deploy)
app.get("/", (req, res) => {
res.json({
ok: true,
service: "sczn3-sec-backend",
routes: ["/health", "/api/sec/compute", "/api/sec/compute-test"],
});
});

app.get("/health", (req, res) => {
res.json({ ok: true });
});

// GET test route (browser-friendly)
app.get("/api/sec/compute-test", (req, res) => {
const impact_x_in = -2.0; // LEFT
const impact_y_in = 1.5; // HIGH
const distance_yards = 100;
const click_value_moa = 0.25;

const inchesPerMOA = 1.047 * (distance_yards / 100);
const x_moa = impact_x_in / inchesPerMOA;
const y_moa = impact_y_in / inchesPerMOA;

const windage = formatDial("windage", (-x_moa) / click_value_moa);
const elevation = formatDial("elevation", (-y_moa) / click_value_moa);

res.json({
input: { impact_x_in, impact_y_in, distance_yards, click_value_moa },
windage,
elevation,
});
});

// POST real compute route
app.post("/api/sec/compute", (req, res) => {
const { impact_x_in, impact_y_in, distance_yards, click_value_moa } = req.body || {};

const nums = [impact_x_in, impact_y_in, distance_yards, click_value_moa];
if (nums.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
return res.status(400).json({ error: "All inputs must be finite numbers." });
}
if (distance_yards <= 0) return res.status(400).json({ error: "distance_yards must be > 0" });
if (click_value_moa <= 0) return res.status(400).json({ error: "click_value_moa must be > 0" });

const inchesPerMOA = 1.047 * (distance_yards / 100);
const x_moa = impact_x_in / inchesPerMOA;
const y_moa = impact_y_in / inchesPerMOA;

const windage = formatDial("windage", (-x_moa) / click_value_moa);
const elevation = formatDial("elevation", (-y_moa) / click_value_moa);

return res.json({ windage, elevation });
});

function formatDial(axis, clicksSigned) {
const abs = Math.abs(clicksSigned);
const clicks = abs.toFixed(2);

if (abs < 0.0005) {
return { direction: axis === "windage" ? "RIGHT" : "UP", clicks: "0.00" };
}

const direction =
axis === "windage"
? clicksSigned > 0
? "RIGHT"
: "LEFT"
: clicksSigned > 0
? "UP"
: "DOWN";

return { direction, clicks };
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`SEC backend listening on ${port}`));
