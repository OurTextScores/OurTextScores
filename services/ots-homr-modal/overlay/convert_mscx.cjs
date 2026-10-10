// MuseScore .mscx -> MusicXML with webmscore (run with node >= 21 and nonav.cjs): node -r ./nonav.cjs convert_mscx.cjs in.mscx out.musicxml
const WebMscore = require("webmscore");
const fs = require("fs");
(async () => {
  await WebMscore.ready;
  const [input, out] = process.argv.slice(2);
  const score = await WebMscore.load("mscx", fs.readFileSync(input), [], false);
  fs.writeFileSync(out, Buffer.from(await score.saveXml()));
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
