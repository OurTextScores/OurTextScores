/* Draws, for each line of a scanned page, the scan next to the two readings of that line with the differences boxed.
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

  function scanCell(scan, label) {
    const cell = el("div", { class: "cell" });
    cell.append(el("span", { class: "tag" }, label));
    if (scan) cell.append(el("img", { src: BASE + scan.src, alt: label, loading: "lazy" }));
    else cell.append(el("div", { class: "noscan" }, "The scan's lines do not match this reading."));
    return cell;
  }

  function readingCell(side, label, drawHighlights) {
    const c = side.content;
    const cell = el("div", { class: "cell" });
    cell.append(el("span", { class: "tag" }, label));
    const svg = svgEl("svg", { viewBox: `${c.x} ${c.y} ${c.w} ${c.h}`, role: "img", "aria-label": label });
    svg.append(svgEl("image", { href: BASE + side.svg, x: 0, y: 0, width: side.width, height: side.height }));
    if (drawHighlights) {
      for (const m of side.fallbackMeasures) svg.append(svgEl("rect", { x: m.x, y: m.y - 20, width: m.w, height: m.h + 40, class: `hl fb ${m.kind}` }));
      for (const b of side.boxes) svg.append(svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: `hl ${b.kind}${b.weak ? " weak" : ""}` }));
    }
    cell.append(svg);
    return cell;
  }

  function rowNode(row, index, mode, labels) {
    const wrap = el("div", { class: "row" });
    const grid = el("div", { class: "grid" });
    grid.append(scanCell(row.scan, "Scan"));
    grid.append(readingCell(row.left, labels[0], mode === "engines"));
    grid.append(readingCell(row.right, labels[1], true));
    wrap.append(grid);
    const bar = el("div", { class: "bar" });
    bar.append(el("span", { class: "linelabel" }, `Line ${index + 1}`));
    const enlarge = el("button", { type: "button", class: "small" }, "Enlarge");
    enlarge.addEventListener("click", () => {
      const on = wrap.classList.toggle("stack");
      enlarge.textContent = on ? "Side by side" : "Enlarge";
    });
    bar.append(enlarge);
    const q = (p) => encodeURIComponent("/" + BASE + p);
    const href = `score-editor/index.html?compareLeft=${q(row.editor.left)}&compareRight=${q(row.editor.right)}&leftLabel=${encodeURIComponent(labels[0])}&rightLabel=${encodeURIComponent(labels[1])}`;
    bar.append(el("a", { href, target: "_blank", rel: "noopener", class: "small" }, "Open this line in the editor"));
    wrap.append(bar);
    return wrap;
  }

  function caseNode(c, mode, labels) {
    const section = el("section", { class: "case" });
    section.append(el("div", { class: "head" }, ""));
    section.firstChild.append(el("b", {}, c.title));
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
    c.rows.forEach((row, i) => section.append(rowNode(row, i, mode, labels)));
    return section;
  }

  window.renderOverlay = async (root, mode, intro, labels) => {
    const manifest = await fetch(BASE + "manifest.json", { cache: "no-store" }).then((r) => r.json());
    const data = manifest[mode];
    const rules = KINDS[mode].map(([kind, , color]) => `.hl.${kind}{fill:${color};fill-opacity:.2;stroke:${color};stroke-width:3}.hide-${kind} .hl.${kind}{display:none}.chip[style*="${color}"].on{background:${color};color:#fff}`).join("");
    const style = el("style");
    style.textContent = `body{margin:0;font:15px system-ui;color:#1c2321}.case{border:1px solid #d8dfda;margin:18px 0;padding:14px}.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:8px 0 12px}.chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:.2rem .7rem;font:inherit;cursor:pointer}.none{color:#59615e}.row{margin:0 0 6px;padding:8px 0;border-top:1px solid #eef1ef}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:start}.stack .grid{grid-template-columns:minmax(0,1fr)}.cell{position:relative}.cell img,.cell svg{display:block;width:100%;height:auto;background:#fff;border:1px solid #e3e8e5}.tag{position:absolute;top:3px;left:4px;z-index:1;background:#183c28;color:#fff;border-radius:3px;padding:0 6px;font-size:11px}.noscan{border:1px dashed #cdd5d0;color:#59615e;padding:2rem 1rem;font-size:13px}.bar{display:flex;gap:.8rem;align-items:center;margin-top:4px;font-size:13px}.linelabel{color:#59615e}.small{font:inherit;font-size:13px;border:1px solid #b9c4be;background:#fff;border-radius:4px;padding:.1rem .55rem;cursor:pointer;color:#183c28;text-decoration:none}small{color:#59615e}.hl.fb{fill:none;stroke:#59615e;stroke-width:3;stroke-dasharray:14 10}${rules}.hl.weak{fill:none!important;stroke-dasharray:8 8;stroke-width:3}@media(max-width:800px){.grid{grid-template-columns:minmax(0,1fr)}}`;
    document.head.append(style);
    root.append(intro(data));
    for (const c of data.cases) root.append(caseNode(c, mode, labels));
  };
})();
