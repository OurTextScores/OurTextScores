import fs from "node:fs";
import path from "node:path";

describe("next.config.mjs rewrites", () => {
  it("excludes score-editor api routes from the backend catch-all rewrite", () => {
    const configPath = path.join(process.cwd(), "next.config.mjs");
    const source = fs.readFileSync(configPath, "utf8");

    expect(source).toContain("source: '/api/:path((?!auth|proxy|score-editor).*)*'");
  });
});
