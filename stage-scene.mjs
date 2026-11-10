const duration = 2400;
const aperture = { x: -0.32, y: 3.34, z: -0.65 };
const mark = { x: 0.24, y: 0, z: 0.53 };

function smoothstep(start, end, value) {
  const ratio = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return ratio * ratio * (3 - 2 * ratio);
}

function noise(x, y) {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function makeTexture(width, height, sample) {
  const texture = document.createElement('canvas');
  texture.width = width;
  texture.height = height;
  const paint = texture.getContext('2d');
  if (!paint) return null;

  const pixels = paint.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4;
      const x = (column + 0.5) / width * 2 - 1;
      const y = (row + 0.5) / height;
      const [red, green, blue, opacity] = sample(x, y, noise(column, row));
      pixels.data[offset] = red;
      pixels.data[offset + 1] = green;
      pixels.data[offset + 2] = blue;
      pixels.data[offset + 3] = opacity * 255;
    }
  }
  paint.putImageData(pixels, 0, 0);
  return texture;
}

function makeBeam() {
  return makeTexture(160, 256, (x, y, grain) => {
    const across = Math.abs(x) / (0.022 + y * 0.978);
    const profile = Math.exp(-(across ** 2) * 1.75) * (1 - smoothstep(0.62, 1, across));
    const taper = (0.87 - y * 0.44) * (1 - smoothstep(0.91, 1, y));
    const mist = 0.92 + 0.08 * Math.sin(y * 32 + x * 9) + 0.08 * grain;
    return [255, 245, 216, profile * taper * mist * 0.59];
  });
}

function makePool() {
  return makeTexture(144, 144, (x, y, grain) => {
    const radius = Math.hypot(x, y * 2 - 1);
    const rim = 1 - smoothstep(0.72, 1, radius);
    const core = Math.exp(-(radius ** 2) * 1.4) * rim;
    return [255, 225 + core * 25, 169 + core * 65, core * (0.76 + 0.10 * grain)];
  });
}

function glow(context, x, y, radius, color) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'transparent');
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function drawFixture(context, lens, pool, scale) {
  const angle = Math.atan2(lens.x - pool.x, pool.y - lens.y);
  context.save();
  context.translate(lens.x, lens.y);
  context.rotate(angle);
  context.scale(scale, scale);

  const body = context.createLinearGradient(-15, 0, 15, 0);
  body.addColorStop(0, '#101218');
  body.addColorStop(0.48, '#2a2c33');
  body.addColorStop(1, '#15171c');
  context.fillStyle = body;
  context.strokeStyle = '#77736a';
  context.lineWidth = 0.55;
  context.beginPath();
  context.moveTo(-13, 0);
  context.lineTo(-10, -22);
  context.quadraticCurveTo(0, -27, 10, -22);
  context.lineTo(13, 0);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = '#1a1b1c';
  context.fillRect(-2, -45, 4, 22);
  glow(context, 0, 0, 22, 'rgba(255, 232, 177, .5)');
  context.fillStyle = '#fff2d0';
  context.beginPath();
  context.ellipse(0, 0, 13, 3.5, 0, 0, 2 * Math.PI);
  context.fill();
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.ellipse(0, -0.2, 9, 1.9, 0, 0, 2 * Math.PI);
  context.fill();
  context.restore();
}

function drawStage(context, width, height, progress, beam, poolTexture) {
  const pullback = smoothstep(0, 1, progress);
  const widening = smoothstep(0.14, 0.96, progress);
  const focalLength = height * (2.28 - 0.90 * pullback);
  const anchorX = width * (0.77 - 0.035 * pullback);
  const anchorY = height * (0.45 + 0.045 * pullback);
  const pitch = 0.055;
  const pitchSin = Math.sin(pitch);
  const pitchCos = Math.cos(pitch);

  function project({ x, y, z }) {
    const up = y - 1.87;
    const away = 7.1 - z;
    const depth = away * pitchCos - up * pitchSin;
    return {
      x: anchorX + focalLength * x / depth,
      y: anchorY - focalLength * (up * pitchCos + away * pitchSin) / depth,
    };
  }

  const lens = project(aperture);
  const pool = project(mark);
  const widthAtMark = 0.35 + 0.96 * widening;
  const nearEdge = project({ ...mark, z: mark.z + widthAtMark * 0.9 });
  const sideEdge = project({ ...mark, x: mark.x + widthAtMark });
  const spreadX = sideEdge.x - pool.x;
  const spreadY = nearEdge.y - pool.y;
  const horizon = anchorY - focalLength * Math.tan(pitch);

  context.fillStyle = '#08090c';
  context.fillRect(0, 0, width, height);
  glow(context, anchorX, height * 0.58, height * 0.76, 'rgba(77, 82, 101, .25)');

  const floor = context.createLinearGradient(0, horizon, 0, height);
  floor.addColorStop(0, 'rgba(15, 16, 22, 0)');
  floor.addColorStop(0.32, 'rgba(18, 19, 26, .57)');
  floor.addColorStop(1, 'rgba(12, 13, 17, .94)');
  context.fillStyle = floor;
  context.fillRect(0, horizon, width, height - horizon);

  context.save();
  context.translate(pool.x, pool.y);
  context.globalAlpha = 0.19;
  context.drawImage(poolTexture, -spreadX * 2.55, -spreadY * 2.9, spreadX * 5.1, spreadY * 5.8);
  context.globalAlpha = 0.96;
  context.drawImage(poolTexture, -spreadX, -spreadY, spreadX * 2, spreadY * 2);
  context.restore();

  // Short, faint floor seams borrow their spacing from the perspective camera.
  context.save();
  context.beginPath();
  context.ellipse(pool.x, pool.y, spreadX * 0.84, spreadY * 0.84, 0, 0, 2 * Math.PI);
  context.clip();
  context.strokeStyle = 'rgba(43, 37, 29, .15)';
  context.lineWidth = 0.7;
  for (const offset of [-0.44, -0.1, 0.25, 0.56]) {
    const from = project({ x: mark.x - 2, y: 0, z: mark.z + offset });
    const to = project({ x: mark.x + 2, y: 0, z: mark.z + offset });
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  context.restore();

  const beamX = pool.x - lens.x;
  const beamY = pool.y - lens.y;
  const beamLength = Math.hypot(beamX, beamY);
  const crossX = beamY / beamLength * spreadX;
  const crossY = -beamX / beamLength * spreadX;
  context.save();
  context.transform(crossX, crossY, beamX, beamY, lens.x, lens.y);
  context.drawImage(beam, -1, 0, 2, 1);
  context.restore();
  drawFixture(context, lens, pool, Math.max(0.55, focalLength / 920));
}

function mountSpotlight(canvas, replay) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return;
  const beam = makeBeam();
  const pool = makePool();
  if (!beam || !pool) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let elapsed = motion.matches ? duration : 0;
  let visible = !('IntersectionObserver' in window);
  let frame = 0;
  let previousTime = 0;
  let width = 0;
  let height = 0;

  function render() {
    if (!width || !height) return;
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    drawStage(context, width, height, elapsed / duration, beam, pool);
    canvas.dataset.ready = 'true';
  }

  function resize() {
    ({ width, height } = canvas.getBoundingClientRect());
    if (!width || !height) return;
    const scale = Math.min(window.devicePixelRatio || 1, 1.6, 1800 / width, 1120 / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    render();
  }

  function sync() {
    const running = visible && !document.hidden && elapsed < duration && !motion.matches;
    if (!running) {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
    } else if (!frame) {
      frame = requestAnimationFrame(tick);
    }

    if (replay) {
      replay.hidden = motion.matches;
      replay.setAttribute('aria-disabled', String(elapsed < duration));
    }
  }

  function tick(time) {
    frame = 0;
    if (previousTime) elapsed = Math.min(duration, elapsed + time - previousTime);
    previousTime = time;
    render();
    sync();
  }

  replay?.addEventListener('click', () => {
    if (motion.matches || elapsed < duration) return;
    elapsed = 0;
    previousTime = 0;
    render();
    sync();
  });

  motion.addEventListener('change', () => {
    elapsed = duration;
    render();
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', resize);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(canvas);
  }
  resize();
  sync();
}

const canvas = document.getElementById('stage-scene');
if (canvas instanceof HTMLCanvasElement) mountSpotlight(canvas, document.getElementById('stage-motion'));
