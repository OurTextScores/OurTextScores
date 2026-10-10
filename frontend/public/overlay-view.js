/* Draws two renderings of the same page as stacked system crops with the differences boxed.
   Data comes from devs-assets/ots-homr-overlay/manifest.json (built by services/ots-homr-modal/overlay). */
(() => {
  const BASE = "devs-assets/ots-homr-overlay/";
  const KINDS = {
    engines: [["notes", "Notes or rhythm", "#d93025"], ["beam", "Beaming", "#1a73e8"], ["marks", "Ties and slurs", "#9334e6"]],
    review: [["lyric", "Added lyrics", "#188038"], ["direction", "Added directions and dynamics", "#e37400"]],
  };
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  function crop(side, system, label, mode, drawHighlights) {
    const x = system.x0 - 90, y = system.y - 150, w = system.x1 - system.x0 + 180, h = system.h + 330;
    const wrap = el("div", { class: "sys" });
    wrap.append(el("span", { class: "tag" }, label));
    const svg = svgEl("svg", { viewBox: `${x} ${y} ${w} ${h}`, role: "img", "aria-label": label });
    svg.append(svgEl("image", { href: BASE + side.svg, x: 0, y: 0, width: side.width, height: side.height }));
    if (drawHighlights) {
      const inside = (b) => b.y + b.h > y && b.y < y + h && b.x + b.w > x && b.x < x + w;
      for (const m of side.fallbackMeasures.filter(inside))
        svg.append(svgEl("rect", { x: m.x, y: m.y - 20, width: m.w, height: m.h + 40, class: `hl fb ${m.kind}` }));
      for (const b of side.boxes.filter(inside))
        svg.append(svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: `hl ${b.kind}${b.weak ? " weak" : ""}` }));
    }
    wrap.append(svg);
    return wrap;
  }

  function caseNode(c, mode, labels) {
    const section = el("section", { class: "case" });
    const head = el("div", { class: "head" });
    head.append(el("b", {}, c.title));
    section.append(head);
    const chips = el("div", { class: "chips" });
    for (const [kind, name, color] of KINDS[mode]) {
      const n = c.counts[kind] || 0;
      if (!n) continue;
      const chip = el("button", { type: "button", class: "chip on", style: `--c:${color}` }, `${name}: ${n}`);
      chip.addEventListener("click", () => {
        chip.classList.toggle("on");
        section.classList.toggle(`hide-${kind}`, !chip.classList.contains("on"));
      });
      chips.append(chip);
    }
    if (!chips.children.length) chips.append(el("span", { class: "none" }, "No differences found."));
    section.append(chips);
    const count = Math.max(c.left.systems.length, c.right.systems.length);
    for (let i = 0; i < count; i += 1) {
      const row = el("div", { class: "pair" });
      if (c.left.systems[i]) row.append(crop(c.left, c.left.systems[i], labels[0], mode, mode === "engines"));
      if (c.right.systems[i]) row.append(crop(c.right, c.right.systems[i], labels[1], mode, true));
      section.append(row);
    }
    return section;
  }

  window.renderOverlay = async (root, mode, intro, labels) => {
    const manifest = await fetch(BASE + "manifest.json", { cache: "no-store" }).then((r) => r.json());
    const data = manifest[mode];
    const style = el("style");
    const rules = KINDS[mode].map(([kind, , color]) => `.hl.${kind}{fill:${color};fill-opacity:.2;stroke:${color};stroke-width:3}.hide-${kind} .hl.${kind}{display:none}.chip[style*="${color}"].on{background:${color};color:#fff}`).join("");
    style.textContent = `body{margin:0;font:15px system-ui;color:#1c2321}.case{border:1px solid #d8dfda;margin:18px 0;padding:14px}.head{display:flex;gap:1rem}.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:8px 0 12px}.chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:.2rem .7rem;font:inherit;cursor:pointer}.none{color:#59615e}.pair{margin:6px 0 14px;border-top:1px solid #eef1ef}.sys{position:relative;margin-top:6px}.sys svg{display:block;width:100%;height:auto;background:#fff;border:1px solid #e3e8e5}.tag{position:absolute;top:4px;left:6px;z-index:1;background:#183c28;color:#fff;border-radius:3px;padding:1px 7px;font-size:12px}small{color:#59615e}.hl.fb{fill:none;stroke:#59615e;stroke-width:3;stroke-dasharray:14 10}${rules}.hl.weak{fill:none!important;stroke-dasharray:8 8;stroke-width:3}`;
    document.head.append(style);
    root.append(intro(data));
    for (const c of data.cases) root.append(caseNode(c, mode, labels));
  };
})();
