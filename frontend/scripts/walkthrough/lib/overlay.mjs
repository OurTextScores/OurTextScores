/**
 * Runs inside every page and frame that is being recorded (Playwright `addInitScript`).
 *
 * A headless browser draws no pointer and makes no sound, so the recording would show a
 * UI changing by itself in silence. This adds what a viewer needs to follow along:
 *
 *  - a drawn cursor that follows the real mouse events, with a ripple on click;
 *  - a badge naming each key as it is pressed;
 *  - a ring that can be put around an element ("callout");
 *  - a tap on the page's Web Audio output, recorded so playback can be heard.
 *
 * It must not change how the page behaves: everything it draws ignores pointer events and
 * lives in one shadow root, and it is installed only when the recorder asks (after the app
 * has rendered), so it never takes part in the app's own first render.
 *
 * This function is serialised and evaluated in the page: it cannot use anything from the
 * enclosing module.
 */
export function overlayInit(options) {
  if (window.__wt) return;
  const wt = (window.__wt = { taps: [], keysEnabled: true, installed: false });

  // ---------------------------------------------------------------- audio tap
  // Patched before the app runs, so the first AudioContext it creates is already covered.
  //
  // What the app sends to the speakers is also sent to an AudioWorklet that copies it out,
  // each run of sound stamped with the wall clock. A MediaRecorder is not used: an app may
  // suspend its AudioContext between sounds (this editor does), a recorder simply stops
  // receiving data while it is suspended, and its file then has the silences squeezed out.
  // Everything after the first pause would play early.
  if (options.audio && typeof AudioWorkletNode !== 'undefined') {
    const WORKLET = `
      class WalkthroughTap extends AudioWorkletProcessor {
        constructor() {
          super();
          this.left = new Float32Array(4096);
          this.right = new Float32Array(4096);
          this.filled = 0;
          this.period = 0;
          this.lastOffset = null;
        }
        flush() {
          if (!this.filled) return;
          const left = this.left.slice(0, this.filled);
          const right = this.right.slice(0, this.filled);
          this.port.postMessage(
            { period: this.period, contextTime: this.startTime, wallMs: this.startWall, left, right },
            [left.buffer, right.buffer],
          );
          this.filled = 0;
        }
        process(inputs) {
          const input = inputs[0];
          const l = input && input[0];
          if (!l) { this.flush(); return true; }
          const r = input[1] || l;
          let peak = 0;
          for (let i = 0; i < l.length; i += 8) { const a = Math.abs(l[i]) + Math.abs(r[i]); if (a > peak) peak = a; }
          if (peak < 1e-5) { this.flush(); return true; }
          // The context clock freezes while suspended and the wall clock does not, so a jump in
          // their difference means the context was suspended in between: a new period.
          const now = Date.now();
          const offset = now - currentTime * 1000;
          if (this.lastOffset !== null && Math.abs(offset - this.lastOffset) > 120) { this.flush(); this.period++; }
          this.lastOffset = offset;
          if (this.filled === 0) { this.startTime = currentTime; this.startWall = now; }
          this.left.set(l, this.filled);
          this.right.set(r, this.filled);
          this.filled += l.length;
          if (this.filled + 128 > this.left.length) this.flush();
          return true;
        }
      }
      registerProcessor('walkthrough-tap', WalkthroughTap);`;
    const taps = new Map();
    wt.audioChunks = [];

    const prepare = (context) => {
      if (taps.has(context)) return taps.get(context);
      const tap = { context, node: null, pending: [] };
      taps.set(context, tap);
      wt.taps.push(tap);
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      context.audioWorklet
        .addModule(url)
        .then(() => {
          tap.node = new AudioWorkletNode(context, 'walkthrough-tap', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 2,
            channelCountMode: 'explicit',
          });
          tap.node.port.onmessage = (event) => {
            wt.audioChunks.push({ ...event.data, sampleRate: context.sampleRate });
          };
          for (const source of tap.pending) originalConnect.call(source, tap.node);
          tap.pending = [];
        })
        .catch((error) => console.warn('[walkthrough] audio tap failed to load', error));
      return tap;
    };

    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function connect(target, ...rest) {
      const result = originalConnect.call(this, target, ...rest);
      try {
        if (typeof AudioDestinationNode !== 'undefined' && target instanceof AudioDestinationNode) {
          const tap = prepare(target.context);
          if (tap.node) originalConnect.call(this, tap.node);
          else tap.pending.push(this);
        }
      } catch (error) {
        console.warn('[walkthrough] audio tap failed', error);
      }
      return result;
    };

    // Load the worklet as soon as a context exists, so it is ready before the first sound.
    const NativeAudioContext = window.AudioContext;
    if (NativeAudioContext) {
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) {
          super(...args);
          try {
            prepare(this);
          } catch (error) {
            console.warn('[walkthrough] audio tap failed', error);
          }
        }
      };
    }

    /** Hands over up to `max` captured runs of sound as 16-bit stereo, base64-encoded. */
    wt.drainAudio = (max = 40) =>
      wt.audioChunks.splice(0, max).map((chunk) => {
        const frames = chunk.left.length;
        const pcm = new Int16Array(frames * 2);
        for (let i = 0; i < frames; i++) {
          pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(chunk.left[i] * 32767)));
          pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(chunk.right[i] * 32767)));
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return {
          period: chunk.period,
          contextTime: chunk.contextTime,
          wallMs: chunk.wallMs,
          sampleRate: chunk.sampleRate,
          base64: btoa(binary),
        };
      });
  }

  /** A click and a flash at the same instant, for measuring audio against picture. */
  wt.syncMark = async () => {
    const context = new AudioContext({ sampleRate: 44100 });
    const gain = context.createGain();
    gain.connect(context.destination);
    await context.resume();
    // Let the tap that the connect above started finish loading before the mark.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 1000;
    oscillator.connect(gain);
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647';
    const at = context.currentTime + 0.5;
    oscillator.start(at);
    oscillator.stop(at + 0.2);
    const wait = (at - context.currentTime) * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    document.documentElement.appendChild(flash);
    const flashEpochMs = performance.timeOrigin + performance.now();
    const audioTimeAtFlash = context.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 200));
    flash.remove();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { flashEpochMs, scheduledAt: at, audioTimeAtFlash };
  };

  // ---------------------------------------------------------------- drawn overlay
  const KEY_NAMES = {
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: '⌫',
    Delete: 'Del',
    Tab: 'Tab',
    Control: 'Ctrl',
    Meta: '⌘',
  };

  wt.install = () => {
    if (wt.installed || !document.body) return wt.installed;
    wt.installed = true;

    const host = document.createElement('div');
    host.id = '__walkthrough_overlay';
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:layout style';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .layer { position: fixed; inset: 0; pointer-events: none; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
        .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; display: none; will-change: transform;
                  filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
        .cursor.down { transform-origin: 3px 2px; }
        .ripple { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
                  border: 3px solid rgba(5,150,105,.95); background: rgba(16,185,129,.25); opacity: 0; }
        .ripple.go { animation: ripple .5s ease-out; }
        @keyframes ripple { from { opacity: .95; transform: var(--at) scale(.25); } to { opacity: 0; transform: var(--at) scale(1.15); } }
        .keys { position: fixed; left: 20px; bottom: 50px; display: flex; gap: 6px; align-items: center;
                opacity: 0; transition: opacity .16s ease; }
        .keys.on { opacity: 1; }
        .keys kbd { font: 600 17px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color: #f8fafc; background: rgba(15,23,42,.92);
                    border: 1px solid rgba(148,163,184,.55); border-bottom-width: 3px; border-radius: 8px; padding: 9px 12px;
                    min-width: 18px; text-align: center; box-shadow: 0 6px 18px rgba(2,6,23,.35); }
        .keys .plus { color: #0f172a; font: 700 15px/1 ui-sans-serif, system-ui, sans-serif; text-shadow: 0 0 6px #fff, 0 0 6px #fff; }
        .keys .times { color: #f8fafc; background: rgba(5,150,105,.95); border-radius: 999px; padding: 5px 9px;
                       font: 700 13px/1 ui-sans-serif, system-ui, sans-serif; }
        .ring { position: fixed; display: none; border: 3px solid rgb(5,150,105); border-radius: 10px;
                box-shadow: 0 0 0 4px rgba(16,185,129,.28), 0 0 0 9999px rgba(15,23,42,.0); transition: all .22s ease; }
        .ring.dim { box-shadow: 0 0 0 4px rgba(16,185,129,.28), 0 0 0 9999px rgba(15,23,42,.38); }
        .tag { position: fixed; display: none; background: rgb(5,150,105); color: #fff; border-radius: 8px; padding: 7px 11px;
               font: 600 15px/1.2 ui-sans-serif, system-ui, "Segoe UI", sans-serif; box-shadow: 0 6px 18px rgba(2,6,23,.3);
               white-space: nowrap; }
      </style>
      <div class="layer">
        <div class="ring"></div>
        <div class="tag"></div>
        <div class="keys"></div>
        <div class="ripple"></div>
        <svg class="cursor" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M3 2 L3 17.5 L7.2 13.8 L10 20 L12.6 18.8 L9.9 12.8 L15.5 12.6 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
      </div>`;
    const cursor = root.querySelector('.cursor');
    const ripple = root.querySelector('.ripple');
    const keys = root.querySelector('.keys');
    const ring = root.querySelector('.ring');
    const tag = root.querySelector('.tag');

    const attach = () => {
      if (!host.isConnected && document.body) document.body.appendChild(host);
    };
    attach();
    // The app owns <body>; if it ever replaces its children, put the overlay back.
    new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: false });
    new MutationObserver(attach).observe(document.body, { childList: true });

    let pointer = { x: -100, y: -100 };
    const place = () => {
      // The arrow's tip is at (3,2) of its box.
      cursor.style.transform = `translate(${pointer.x - 3}px, ${pointer.y - 2}px)`;
    };
    window.addEventListener(
      'mousemove',
      (event) => {
        const overFrame = event.target && event.target.tagName === 'IFRAME';
        cursor.style.display = overFrame ? 'none' : 'block';
        pointer = { x: event.clientX, y: event.clientY };
        place();
      },
      true,
    );
    document.documentElement.addEventListener('mouseleave', () => {
      cursor.style.display = 'none';
    });
    window.addEventListener(
      'mousedown',
      (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        ripple.style.setProperty('--at', `translate(${pointer.x}px, ${pointer.y}px)`);
        ripple.classList.remove('go');
        void ripple.offsetWidth; // restart the animation
        ripple.classList.add('go');
      },
      true,
    );

    // ---- key badge
    let keysTimer = null;
    let lastLabel = '';
    let repeat = 1;
    const showKeys = (parts) => {
      const label = parts.join('+');
      repeat = label === lastLabel && keys.classList.contains('on') ? repeat + 1 : 1;
      lastLabel = label;
      keys.innerHTML =
        parts.map((part) => `<kbd>${part}</kbd>`).join('<span class="plus">+</span>') +
        (repeat > 1 ? `<span class="times">×${repeat}</span>` : '');
      keys.classList.add('on');
      clearTimeout(keysTimer);
      keysTimer = setTimeout(() => keys.classList.remove('on'), options.keyBadgeMs ?? 1100);
    };
    window.addEventListener(
      'keydown',
      (event) => {
        if (!wt.keysEnabled || event.repeat) return;
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.metaKey) parts.push('⌘');
        if (event.altKey) parts.push('Alt');
        const named = KEY_NAMES[event.key];
        const printable = event.key.length === 1;
        // Shift is shown for named keys and letters, not for a symbol it merely produces ("+", "<").
        if (event.shiftKey && (!printable || /[a-z]/i.test(event.key))) parts.push('Shift');
        parts.push(named ?? (printable ? event.key.toUpperCase() : event.key));
        showKeys(parts);
      },
      true,
    );
    wt.showKeys = showKeys;
    wt.hideKeys = () => keys.classList.remove('on');

    // ---- callout
    wt.callout = ({ x, y, width, height, label, pad = 6, dim = false, place: where = 'below' }) => {
      ring.style.display = 'block';
      ring.classList.toggle('dim', dim);
      ring.style.left = `${x - pad}px`;
      ring.style.top = `${y - pad}px`;
      ring.style.width = `${width + pad * 2 - 6}px`;
      ring.style.height = `${height + pad * 2 - 6}px`;
      if (label) {
        tag.textContent = label;
        tag.style.display = 'block';
        const box = tag.getBoundingClientRect();
        let left = x + width / 2 - box.width / 2;
        let top = where === 'above' ? y - pad - box.height - 10 : y + height + pad + 10;
        if (where === 'right') {
          left = x + width + pad + 12;
          top = y + height / 2 - box.height / 2;
        }
        left = Math.max(8, Math.min(window.innerWidth - box.width - 8, left));
        top = Math.max(8, Math.min(window.innerHeight - box.height - 8, top));
        tag.style.left = `${left}px`;
        tag.style.top = `${top}px`;
      } else {
        tag.style.display = 'none';
      }
    };
    wt.clearCallout = () => {
      ring.style.display = 'none';
      tag.style.display = 'none';
    };
    return true;
  };
}
