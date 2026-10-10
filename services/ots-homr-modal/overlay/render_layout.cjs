// Render a MusicXML file with webmscore and write <out>.svg plus <out>.layout.json: measure boxes, notehead
// positions and staff-line bands, in SVG units. Run with node >= 21 as: node -r ./nonav.cjs render_layout.cjs in.xml out
const WebMscore = require("webmscore");
const fs = require("fs");

(async () => {
  await WebMscore.ready;
  const [input, out] = process.argv.slice(2);
  const score = await WebMscore.load("musicxml", fs.readFileSync(input), [], false);
  const svg = await score.saveSvg(0, true);
  const positions = JSON.parse(await score.savePositions(false));
  const pages = await score.npages();
  const heads = [...svg.matchAll(/<path class="Note" transform="matrix\(([^)]*)\)"/g)].map((m) => {
    const p = m[1].split(",").map(Number);
    return { x: p[4], y: p[5] };
  });
  const rests = [...svg.matchAll(/<path class="Rest" transform="matrix\(([^)]*)\)"/g)].map((m) => {
    const p = m[1].split(",").map(Number);
    return { x: p[4], y: p[5] };
  });
  const lines = [...svg.matchAll(/<polyline class="StaffLines"[^>]*points="([^"]*)"/g)].map((m) => {
    const [a, b] = m[1].trim().split(/\s+/).map((s) => s.split(",").map(Number));
    return { x1: a[0], x2: b[0], y: a[1] };
  });
  const size = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  fs.writeFileSync(out + ".svg", svg);
  fs.writeFileSync(
    out + ".layout.json",
    JSON.stringify({ pages, width: Number(size[1]), height: Number(size[2]), measures: positions.elements, heads, rests, lines })
  );
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
