/* Keep static comparison galleries from starting many MuseScore/WASM instances at once. */
(() => {
  const style = document.createElement("style");
  style.textContent = ".load-comparison{margin:0 0 10px;padding:.55rem .75rem;border:1px solid #285d3d;border-radius:4px;background:#edf3ef;color:#183c28;font-weight:650;cursor:pointer}.lazy-score-placeholder{height:500px;display:grid;place-items:center;border:1px solid #ddd;background:#fafcfb;color:#59615e}@media(max-width:700px){.lazy-score-placeholder{height:330px}}";
  (document.head || document.documentElement).append(style);
  const placeholder = message => {
    const node = document.createElement("div");
    node.className = "lazy-score-placeholder";
    node.textContent = message;
    return node;
  };

  window.installLazyScoreEditors = (root = document) => {
    let active = null;
    for (const source of root.querySelectorAll("iframe[data-score-editor]")) {
      const card = source.closest(".case, .card") || source.parentElement;
      const slot = document.createElement("div");
      slot.className = "lazy-score-slot";
      slot.dataset.src = source.dataset.scoreEditor;
      slot.dataset.title = source.title || "MusicXML comparison";
      slot.append(placeholder("Editor not loaded."));

      const button = document.createElement("button");
      button.type = "button";
      button.className = "load-comparison";
      button.textContent = "Load comparison";
      button.addEventListener("click", () => {
        if (active && active.slot !== slot) {
          active.slot.replaceChildren(placeholder("Comparison unloaded to keep memory use bounded."));
          active.button.disabled = false;
          active.button.textContent = "Load comparison";
        }
        if (active?.slot === slot) return;
        const frame = document.createElement("iframe");
        frame.src = slot.dataset.src;
        frame.title = slot.dataset.title;
        slot.replaceChildren(frame);
        button.disabled = true;
        button.textContent = "Comparison loaded";
        active = { slot, button };
      });
      source.replaceWith(slot);
      slot.before(button);
      if (card) card.classList.add("lazy-score-card");
    }
  };

  // Two older galleries use document.write to add their cards. Intercept only their
  // score-editor frames before the browser can start their WASM-backed documents.
  const write = document.write.bind(document);
  document.write = (...parts) => {
    const markup = parts.join("").replace(
      /<iframe\s+src=("score-editor\/index\.html\?[^"<>]+")/g,
      "<iframe data-score-editor=$1"
    );
    write(markup);
    queueMicrotask(() => window.installLazyScoreEditors());
  };
})();
