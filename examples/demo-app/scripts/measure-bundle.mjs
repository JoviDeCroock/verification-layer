import { stat } from "node:fs/promises";

const file = new URL("../public/app.js", import.meta.url);
const measurement = await stat(file);
console.log(JSON.stringify({ value: measurement.size, unit: "bytes", file: "public/app.js" }));
