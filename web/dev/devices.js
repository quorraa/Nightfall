// Device sizes in CSS pixels, with the safe-area insets [top, right, bottom, left] each one has
// as a home-screen app. Sources: Apple and Google device specs as collected by
// screensizechecker.com, BrowserStack and sizzy.co (2026).
export const DEVICES = [
  // Phones, portrait
  ['Galaxy Fold cover (old)', 280, 653, [24, 0, 0, 0]],
  ['iPhone SE 1st', 320, 568, [20, 0, 0, 0]],
  ['Galaxy Z Fold cover', 344, 882, [24, 0, 0, 0]],
  ['Android compact', 360, 640, [24, 0, 0, 0]],
  ['Galaxy S24', 360, 780, [24, 0, 0, 0]],
  ['iPhone SE 2/3', 375, 667, [20, 0, 0, 0]],
  ['iPhone 13 mini', 375, 812, [50, 0, 34, 0]],
  ['iPhone 15', 393, 852, [59, 0, 34, 0]],
  ['iPhone 15 in Safari', 393, 659, [59, 0, 0, 0]],
  ['iPhone 17 Pro', 402, 874, [62, 0, 34, 0]],
  ['Pixel 9', 412, 915, [24, 0, 0, 0]],
  ['Pixel 9 in Chrome', 412, 780, [0, 0, 0, 0]],
  ['iPhone 15 Plus', 430, 932, [59, 0, 34, 0]],
  ['iPhone 18 Pro Max', 440, 956, [62, 0, 34, 0]],
  // Foldables and tablets, portrait
  ['iPad Slide Over', 320, 980, [24, 0, 20, 0]],
  ['Galaxy Z Fold open', 673, 841, [24, 0, 0, 0]],
  ['iPad mini', 744, 1133, [24, 0, 20, 0]],
  ['Android tablet', 800, 1280, [24, 0, 0, 0]],
  ['iPad 10 / Air', 820, 1180, [24, 0, 20, 0]],
  ['iPad Pro 11', 834, 1194, [24, 0, 20, 0]],
  ['iPad Pro 13', 1032, 1376, [24, 0, 20, 0]],
  // Landscape
  ['iPhone SE 1st, landscape', 568, 320, [0, 0, 0, 0]],
  ['iPhone SE 2/3, landscape', 667, 375, [0, 0, 0, 0]],
  ['Galaxy S24, landscape', 780, 360, [0, 24, 0, 0]],
  ['iPhone 13 mini, landscape', 812, 375, [0, 50, 21, 50]],
  ['iPhone 15, landscape', 852, 393, [0, 59, 21, 59]],
  ['iPhone 15 in Safari, landscape', 852, 342, [0, 59, 0, 59]],
  ['Pixel 9, landscape', 915, 412, [0, 24, 0, 0]],
  ['iPhone 18 Pro Max, landscape', 956, 440, [0, 62, 21, 62]],
  ['Galaxy Z Fold open, landscape', 841, 673, [24, 0, 0, 0]],
  ['iPad mini, landscape', 1133, 744, [24, 0, 20, 0]],
  ['iPad 10 / Air, landscape', 1180, 820, [24, 0, 20, 0]],
  ['Android tablet, landscape', 1280, 800, [24, 0, 0, 0]],
  ['iPad Pro 13, landscape', 1376, 1032, [24, 0, 20, 0]],
  // Desktop and laptop windows
  ['Small window', 500, 400, [0, 0, 0, 0]],
  ['Small desktop', 800, 600, [0, 0, 0, 0]],
  ['Netbook', 1024, 600, [0, 0, 0, 0]],
  ['Laptop 720p', 1280, 720, [0, 0, 0, 0]],
  ['Laptop 1366, in a browser', 1366, 657, [0, 0, 0, 0]],
  ['Laptop 1440 x 900', 1440, 900, [0, 0, 0, 0]],
  ['Laptop 1536 x 864', 1536, 864, [0, 0, 0, 0]],
  ['1080p, in a browser', 1920, 969, [0, 0, 0, 0]],
  ['1080p', 1920, 1080, [0, 0, 0, 0]],
  ['1440p', 2560, 1440, [0, 0, 0, 0]],
  ['Ultrawide', 3440, 1440, [0, 0, 0, 0]],
  ['4K', 3840, 2160, [0, 0, 0, 0]],
  ['Portrait monitor', 1080, 1920, [0, 0, 0, 0]],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = 'DESKTOP-K7Q2M9X'; // the longest name Windows gives by default

// Worst-case text for every element that shows text.
function fillWorstCase(doc) {
  const set = (sel, v, html) => { const el = doc.querySelector(sel); if (html) el.innerHTML = v; else el.textContent = v; };
  set('#clock', '12:59<small>AM</small>', true);
  set('#line', 'It’s late. Let the screens sleep.');
  set('#hostName', `Can’t reach ${HOST}`);
  set('#sliderLabel', 'Slide to turn off in 30 min');
  set('#message', `Can’t reach ${HOST}. Check that Nightfall is running on it.`);
  set('#countdown', '59:59');
  set('#nightSub', `Test mode: the screens on ${HOST} stayed on.`);
}

// Loads the app in an iframe of each size and reports layout problems in every mode.
export async function audit(frame, devices = DEVICES, onResult = () => {}) {
  const results = [];
  for (const [name, w, h, safe] of devices) {
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.src = `/?q=low&freeze=5&audit=${Math.random()}`;
    await new Promise((r) => (frame.onload = r));
    const win = frame.contentWindow, doc = frame.contentDocument;
    for (let i = 0; i < 100 && !win.nightfall && !doc.body.style.background; i++) await sleep(50);
    const root = doc.documentElement;
    ['t', 'r', 'b', 'l'].forEach((k, i) => root.style.setProperty(`--safe-${k}`, `${safe[i]}px`));
    const style = doc.createElement('style');
    style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    doc.head.appendChild(style);
    const { CABIN } = await import('/gl/world.js');
    const issues = [];
    let cabin = '', layout = '';
    for (const mode of ['idle', 'pending', 'night']) {
      doc.body.dataset.mode = mode;
      fillWorstCase(doc);
      win.dispatchEvent(new win.Event('resize'));
      await sleep(150);
      const W = win.innerWidth, H = win.innerHeight;
      const add = (s) => issues.push(`${mode}: ${s}`);
      const R = (el) => el.getBoundingClientRect();
      const textBox = (el) => { const rg = doc.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
      const tag = (el) => (el.id ? `#${el.id}` : `.${String(el.className).split(' ')[0] || el.tagName}`) +
        (el.textContent.trim() ? ` “${el.textContent.trim().slice(0, 16)}”` : '');
      const overlaps = (p, q) => p.width && q.width && p.left < q.right - 2 && q.left < p.right - 2 && p.top < q.bottom - 2 && q.top < p.bottom - 2;

      if (root.scrollWidth > W + 1 || root.scrollHeight > H + 1) add(`page overflows (${root.scrollWidth} x ${root.scrollHeight})`);
      const view = doc.querySelector(`.view-${mode}`);
      const els = [doc.querySelector('.brand'), doc.querySelector('.host'), doc.querySelector('#clock'), doc.querySelector('#line'),
        ...view.querySelectorAll('button, p, .slider')];
      for (const el of els) {
        const isText = el.matches('p, .brand, .host');
        const r = isText ? textBox(el) : R(el);
        if (!r.width) continue;
        if (r.left < -1 || r.right > W + 1 || r.top < -1 || r.bottom > H + 1) add(`${tag(el)} is off screen`);
        else if (r.top < safe[0] - 1 || r.bottom > H - safe[2] + 1 || r.left < safe[3] - 1 || r.right > W - safe[1] + 1) add(`${tag(el)} is under the notch or home bar`);
        if (el.matches('button') && el.scrollWidth > el.clientWidth + 1) add(`${tag(el)} text doesn’t fit`);
        if (el.matches('button') && !el.closest('.slider') && (r.height < 40 || r.width < 40)) add(`${tag(el)} is a small tap target (${r.width | 0} x ${r.height | 0})`);
      }
      const label = doc.querySelector('#sliderLabel');
      if (mode === 'idle' && label.scrollWidth > label.clientWidth + 1) add('slider label doesn’t fit');
      if (mode === 'idle') for (const b of view.querySelectorAll('.when button')) if (R(b).height > 48) add(`${tag(b)} wraps onto two lines`);
      if (overlaps(textBox(doc.querySelector('.brand')), textBox(doc.querySelector('.host')))) add('app name overlaps the PC name');

      const controls = [...view.children].map(R).reduce((u, r) => ({
        left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom),
        width: 1,
      }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 });
      for (const sel of ['#clock', '#line', '.top']) {
        if (mode === 'night' && sel === '#line') continue;
        const el = doc.querySelector(sel);
        if (overlaps(sel === '.top' ? R(el) : textBox(el), controls)) add(`${sel} overlaps the controls`);
      }
      if (overlaps(textBox(doc.querySelector('#clock')), R(doc.querySelector('.top')))) add('clock overlaps the header');

      if (mode === 'idle' && win.nightfall) {
        // Frames may not be drawing (hidden tab), so aim the camera from the framing itself.
        const nf = win.nightfall, cam = nf.camera, v = nf.view();
        cam.rotation.set(v.pitch, -v.yaw, 0);
        cam.updateMatrixWorld();
        layout = v.layout;
        const p = cam.position.clone().set(CABIN.x, CABIN.y + 3, CABIN.z).project(cam);
        const sx = (p.x * 0.5 + 0.5) * W, sy = (0.5 - p.y * 0.5) * H;
        cabin = `${Math.round((sx / W) * 100)}%, ${Math.round((sy / H) * 100)}%`;
        const at = { left: sx - 12, right: sx + 12, top: sy - 12, bottom: sy + 12, width: 1 };
        if (p.z > 1 || sx < 0 || sx > W || sy < 0 || sy > H) add(`the cabin is off screen (${cabin})`);
        else if (overlaps(at, controls)) add(`the cabin is behind the controls (${cabin})`);
        else if (overlaps(at, textBox(doc.querySelector('#clock'))) || overlaps(at, textBox(doc.querySelector('#line')))) add(`the cabin is behind the clock (${cabin})`);
      }
    }
    const res = { name, size: `${w} x ${h}`, layout, cabin, issues, webgl: !!win.nightfall };
    results.push(res);
    onResult(res);
  }
  return results;
}
