(function(){
  // Do not run widget inside the iframe or when embed mode is requested
  try {
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1' || params.get('embed') === 'true';
    const inIframe = window.self !== window.top;
    if (isEmbed || inIframe) return;
  } catch (_) { /* no-op */ }

  // Prevent duplicate initialization
  if (document.querySelector('.bfb-wrap')) return;
  const cfg = Object.assign({
    title: 'Chat with us',
    primary: '#2563eb',
    zIndex: 999999,
    position: { bottom: 20, right: 20 },
    width: 360,
    height: 520,
    openByDefault: false
  }, window.BubbleFAQ || {});

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/widget.css';
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'bfb-wrap';
  wrap.style.zIndex = String(cfg.zIndex);
  wrap.style.position = 'fixed';
  wrap.style.bottom = cfg.position.bottom + 'px';
  wrap.style.right = cfg.position.right + 'px';

  const panel = document.createElement('div');
  panel.className = 'bfb-panel';
  panel.style.width = cfg.width + 'px';
  panel.style.height = cfg.height + 'px';
  panel.style.display = cfg.openByDefault ? 'block' : 'none';

  const header = document.createElement('div');
  header.className = 'bfb-header';
  header.style.setProperty('--bfb-primary', cfg.primary);
  header.innerHTML = `
    <div class="bfb-head-left">
      <div class="bfb-avatar" aria-hidden="true">
        <div class="bfb-heart-wrap">
          <svg class="bfb-heart-svg" viewBox="0 0 48 48" width="28" height="28" role="img" aria-hidden="true">
            <defs>
              <linearGradient id="bfbHeartGradH" x1="20%" y1="8%" x2="85%" y2="92%">
                <stop offset="0%" stop-color="#ffafbe"/>
                <stop offset="45%" stop-color="#ff3b63"/>
                <stop offset="100%" stop-color="#a1142c"/>
              </linearGradient>
              <radialGradient id="bfbVignetteH" cx="75%" cy="80%" r="60%">
                <stop offset="0%" stop-color="#000" stop-opacity="0.28"/>
                <stop offset="100%" stop-color="#000" stop-opacity="0"/>
              </radialGradient>
              <radialGradient id="bfbSpecH" cx="28%" cy="22%" r="30%">
                <stop offset="0%" stop-color="#fff" stop-opacity="0.32"/>
                <stop offset="70%" stop-color="#fff" stop-opacity="0.08"/>
                <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
              </radialGradient>
              <filter id="bfbBlur2H" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="0.6" />
              </filter>
              <clipPath id="bfbClipH">
                <path d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z"/>
              </clipPath>
            </defs>
            <path class="heart-base" fill="url(#bfbHeartGradH)" d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z"/>
            <g clip-path="url(#bfbClipH)">
              <path class="heart-vignette" d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z" fill="url(#bfbVignetteH)"/>
            </g>
          </svg>
          <div class="bfb-face-overlay">
            <span class="brow left"></span>
            <span class="brow right"></span>
            <span class="eye left"></span>
            <span class="eye right"></span>
            <span class="mouth"><span class="tongue"></span></span>
          </div>
        </div>
      </div>
      <div class="bfb-head-text">
        <div class="bfb-title">${cfg.title}</div>
        <div class="bfb-status"><span class="bfb-dot" aria-hidden="true"></span> We're online!</div>
      </div>
    </div>
    <button class="bfb-close" aria-label="Close chat" title="Close">✕</button>
  `;
  panel.appendChild(header);

  const iframe = document.createElement('iframe');
  iframe.className = 'bfb-iframe';
  iframe.src = '/?embed=1';
  iframe.title = cfg.title;
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', 'clipboard-write');
  panel.appendChild(iframe);

  const launcher = document.createElement('button');
  launcher.className = 'bfb-launcher';
  launcher.style.setProperty('--bfb-primary', cfg.primary);
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', String(cfg.openByDefault));
  launcher.innerHTML = `
    <div class="bfb-heart-wrap" aria-hidden="true">
      <svg class="bfb-heart-svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="bfbHeartGradL" x1="20%" y1="8%" x2="85%" y2="92%">
            <stop offset="0%" stop-color="#ffafbe"/>
            <stop offset="45%" stop-color="#ff3b63"/>
            <stop offset="100%" stop-color="#a1142c"/>
          </linearGradient>
          <radialGradient id="bfbVignetteL" cx="75%" cy="80%" r="60%">
            <stop offset="0%" stop-color="#000" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#000" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="bfbSpecL" cx="28%" cy="22%" r="30%">
            <stop offset="0%" stop-color="#fff" stop-opacity="0.32"/>
            <stop offset="70%" stop-color="#fff" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
          </radialGradient>
          <filter id="bfbBlur2L" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="0.6" />
          </filter>
          <clipPath id="bfbClipL">
            <path d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z"/>
          </clipPath>
        </defs>
        <path class="heart-base" fill="url(#bfbHeartGradL)" d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z"/>
        <g clip-path="url(#bfbClipL)">
          <path class="heart-vignette" d="M24 42c-10-6.5-18-14-18-22 0-6 4-10 10-10 4 0 7 2 8 5 1-3 4-5 8-5 6 0 10 4 10 10 0 8-8 15.5-18 22z" fill="url(#bfbVignetteL)"/>
        </g>
      </svg>
      <div class="bfb-face-overlay">
        <span class="brow left"></span>
        <span class="brow right"></span>
        <span class="eye left"></span>
        <span class="eye right"></span>
        <span class="mouth"><span class="tongue"></span></span>
      </div>
    </div>`;

  header.querySelector('.bfb-close').addEventListener('click', () => {
    panel.classList.remove('open');
    panel.style.display = 'none';
    launcher.style.display = 'flex';
    launcher.setAttribute('aria-expanded', 'false');
  });
  launcher.addEventListener('click', () => {
    panel.style.display = 'block';
    // allow display to apply before anim class for CSS animation
    requestAnimationFrame(() => panel.classList.add('open'));
    launcher.style.display = 'none';
    launcher.setAttribute('aria-expanded', 'true');
    // greet action animation
    launcher.classList.add('greet');
    setTimeout(() => launcher.classList.remove('greet'), 1400);
  });

  wrap.appendChild(panel);
  wrap.appendChild(launcher);
  document.body.appendChild(wrap);

  // Interactivity: eye-tracking, tilt, and wink
  const hearts = Array.from(document.querySelectorAll('.bfb-heart-wrap'));
  const enableInteractivity = (el) => {
    if (!el) return;
    el.classList.add('look', 'tilt');
    // state for smoothing
    const state = {
      tx: 0, ty: 0, // target pupil offset (px)
      cx: 0, cy: 0, // current pupil offset (px)
      rtx: 0, rty: 0, // target tilt (deg)
      rcx: 0, rcy: 0  // current tilt (deg)
    };
    const apply = () => {
      // lerp
      state.cx += (state.tx - state.cx) * 0.18;
      state.cy += (state.ty - state.cy) * 0.18;
      state.rcx += (state.rtx - state.rcx) * 0.18;
      state.rcy += (state.rty - state.rcy) * 0.18;
      el.style.setProperty('--eye-x', state.cx.toFixed(2) + 'px');
      el.style.setProperty('--eye-y', state.cy.toFixed(2) + 'px');
      el.style.setProperty('--tilt-x', state.rcx.toFixed(2) + 'deg');
      el.style.setProperty('--tilt-y', state.rcy.toFixed(2) + 'deg');
      requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
    const setFromPoint = (x, y) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const nx = Math.max(-1, Math.min(1, (x - cx) / (r.width / 2)));
      const ny = Math.max(-1, Math.min(1, (y - cy) / (r.height / 2)));
      // pupils: smaller travel for stability
      state.tx = nx * 2.2; // px
      state.ty = ny * 2.2; // px
      // tilt: slightly reduced + inverted Y
      state.rtx = nx * 5;  // deg
      state.rty = ny * -3.5; // deg
    };
    const reset = () => {
      state.tx = state.ty = 0;
      state.rtx = state.rty = 0;
    };
    // global tracking: respond to global mouse/touch move
    const onMove = (x, y) => setFromPoint(x, y);
    const onMouse = (e) => onMove(e.clientX, e.clientY);
    const onTouch = (e) => { const t = e.touches && e.touches[0]; if (t) onMove(t.clientX, t.clientY); };
    window.addEventListener('mousemove', onMouse, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    // wink on mousedown
    el.addEventListener('mousedown', () => {
      el.classList.add('wink');
      setTimeout(() => el.classList.remove('wink'), 220);
    });
    el.addEventListener('touchstart', () => {
      el.classList.add('wink');
      setTimeout(() => el.classList.remove('wink'), 220);
    }, { passive: true });
  };
  hearts.forEach(enableInteractivity);

// Listen for talking signals from the iframe (set by app.js)
window.addEventListener('message', (evt) => {
  try {
    const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
    if (!data || !data.type) return;
    if (data.type === 'bfb:talking') {
      const on = !!data.talking;
      launcher.classList.toggle('talking', on);
      header.classList.toggle('talking', on);
      if (!on) {
        launcher.style.removeProperty('--talk-dur');
        header.style.removeProperty('--talk-dur');
      }
    }
    if (data.type === 'bfb:talk-beat') {
      const raw = Number(data.dur) || 280; // ms
      // slow down overall pace and widen range a bit
      const dur = Math.max(300, Math.min(620, Math.round(raw * 1.6)));
      // gentler amplitude 0.98..1.22 based on slower beats
      const norm = (dur - 300) / (620 - 300);
      const amp = Math.max(0.98, Math.min(1.22, 0.98 + norm * 0.24));
      const bob = (amp - 1) * -2.4; // subtler bob
      const brow = (amp - 1) * -3.2; // subtler brow raise
      [launcher, header].forEach((el) => {
        if (!el) return;
        el.style.setProperty('--talk-dur', dur + 'ms');
        el.style.setProperty('--talk-amp', amp.toFixed(3));
        el.style.setProperty('--talk-bob', bob.toFixed(2) + 'px');
        el.style.setProperty('--brow-amp', brow.toFixed(2) + 'px');
      });
    }
  } catch {}
});
})();
