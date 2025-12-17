const express = require("express");

const cors = require("cors");



const app = express();



app.use(cors());

app.use(express.json());



app.get("/health", (req, res) => {

  res.json({ ok: true });

});



/**

 * Input convention:

 *  - impact_x_in: + = impact RIGHT of aimpoint, - = LEFT

 *  - impact_y_in: + = impact HIGH of aimpoint,  - = LOW

 *

 * Output convention (dial direction):

 *  - Dial the direction you want the impact to move (opposite of observed offset).

 */

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



  const windage_clicks_signed = (-x_moa) / click_value_moa;

  const elevation_clicks_signed = (-y_moa) / click_value_moa;



  const windage = formatDial("windage", windage_clicks_signed);

  const elevation = formatDial("elevation", elevation_clicks_signed);



  return res.json({ windage, elevation });

});



function formatDial(axis, clicksSigned) {

  const abs = Math.abs(clicksSigned);



  // Always two decimals (your standard)

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
