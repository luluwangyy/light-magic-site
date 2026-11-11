import {outputLabel} from './mapping-output.mjs';

const mapUrl = new URL('./assets/movement-lab-fixtures.json', import.meta.url);
const svgNamespace = 'http://www.w3.org/2000/svg';
const plotWidth = 560;
const plotHeight = 350;
const sources = {camera: 'Camera', speech: 'Speech', motion: 'Learned motion', demo: 'Practice', manual: 'Manual preview', preset: 'Show look'};
const fixtureRoles = {downlight: 'Downlight', directional: 'Directional spotlight', 'eye-tracking': 'Eye-tracking light'};
let previewCount = 0;

function svgElement(name, attributes) {
  const element = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function fixtureColor(target) {
  return /^#[0-9a-f]{6}$/i.test(target?.color) ? target.color : null;
}

function targetsByChannel(target) {
  const rows = target?.output_type === 'channel_look' ? target.channels :
    target?.output_type === 'channel_level' ? [target] : [];
  return new Map((rows || []).map(row => [String(row.channel), row]));
}

function describeSettings(target) {
  const parts = [Number.isFinite(target.level) ? `Intensity ${target.level}%` : 'Intensity unchanged'];
  if (Number.isFinite(target.zoom)) parts.push(`Zoom ${target.zoom}%`);
  if (fixtureColor(target)) parts.push(`Color ${target.color}`);
  return parts.join(' · ');
}

function drawBeam(drawing, gradients, fixture, target, toPixel, plan, gradientId, strength) {
  const zoom = Number.isFinite(target.zoom) ? target.zoom : null;
  const color = fixtureColor(target);

  // A schematic beam aimed at the floor below the fixture. The archived PAR uses
  // lower DMX settings for a wider beam. Its actual Eos profile and aim may differ.
  const width = zoom === null ? .5 : 1 - zoom / 100;
  const radius = fixture.z * (.085 + .475 * width);
  const alpha = (Number.isFinite(target.level) ? .24 + .76 * target.level / 100 : .7) * strength;
  const tint = color || '#dedede';
  const source = toPixel(fixture.x, fixture.y, fixture.z);
  const floor = toPixel(fixture.x, fixture.y);
  const perimeter = Array.from({length: 40}, (_, index) => {
    const angle = index * Math.PI / 20;
    return toPixel(fixture.x + radius * Math.cos(angle), fixture.y + radius * Math.sin(angle));
  });

  if (!plan) {
    const left = perimeter.reduce((a, b) => b[0] < a[0] ? b : a);
    const right = perimeter.reduce((a, b) => b[0] > a[0] ? b : a);
    const gradient = svgElement('linearGradient', {
      id: gradientId, gradientUnits: 'userSpaceOnUse', x1: source[0], y1: source[1], x2: floor[0], y2: floor[1],
    });
    gradient.append(
      svgElement('stop', {offset: '0%', 'stop-color': tint, 'stop-opacity': color ? .84 : .46}),
      svgElement('stop', {offset: '100%', 'stop-color': tint, 'stop-opacity': .15}),
    );
    gradients.append(gradient);
    drawing.append(svgElement('polygon', {
      class: 'stage-preview-beam', points: [source, left, right].map(point => point.join(',')).join(' '),
      fill: `url(#${gradientId})`, opacity: alpha, 'data-beam-channel': fixture.channel,
    }));
  }

  drawing.append(svgElement('polygon', {
    class: 'stage-preview-beam-footprint', points: perimeter.map(point => point.join(',')).join(' '),
    fill: tint, 'fill-opacity': (plan ? .42 : .34) * alpha, 'data-beam-channel': fixture.channel,
  }));
}

function drawStage(svg, layout, view, inspectedChannel, targets, isLook, gradientId) {
  const plan = view === 'plan';
  const {roomWidth, roomDepth} = layout.coordinateSystem;
  const left = -roomWidth / 2, right = roomWidth / 2;
  const front = -roomDepth / 2, back = roomDepth / 2;
  const project = plan ? (x, y) => [x, -y] : (x, y, z = 0) => [x + .58 * y, .20 * x - .61 * y - z];
  const floor = [[left, front], [right, front], [right, back], [left, back]].map(point => project(...point));
  const fixtures = layout.fixtures.map(fixture => ({
    ...fixture, position: project(fixture.x, fixture.y, fixture.z),
  }));
  const points = [...floor, ...fixtures.map(fixture => fixture.position)];
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sideMargin = plan ? 64 : 34;
  const scale = Math.min((plotWidth - 2 * sideMargin) / (maxX - minX), (plotHeight - 56) / (maxY - minY));
  const pixel = ([x, y]) => [
    plotWidth / 2 + (x - (minX + maxX) / 2) * scale,
    plotHeight / 2 + (y - (minY + maxY) / 2) * scale,
  ];
  const drawing = document.createDocumentFragment();
  function line(from, to, className) {
    const [x1, y1] = pixel(from), [x2, y2] = pixel(to);
    drawing.append(svgElement('line', {x1, y1, x2, y2, class: className}));
  }

  drawing.append(svgElement('polygon', {points: floor.map(point => pixel(point).join(',')).join(' '), class: 'stage-preview-floor'}));
  for (let x = left + 2; x < right; x += 2) line(project(x, front), project(x, back), 'stage-preview-grid');
  for (let y = front + 2; y < back; y += 2) line(project(left, y), project(right, y), 'stage-preview-grid');
  const beamFixtures = fixtures.filter(fixture => {
    const target = targets.get(fixture.channel);
    return target && target.level !== 0 && (isLook || Number.isFinite(target.zoom) || fixtureColor(target));
  });
  const gradients = svgElement('defs', {});
  drawing.append(gradients);
  const toPixel = (...point) => pixel(project(...point));
  const strength = Math.max(.45, Math.min(1, Math.sqrt(4 / (beamFixtures.length || 1))));
  // Paint distant beams first and the fixture being inspected last.
  beamFixtures.sort((a, b) => Number(a.channel === inspectedChannel) - Number(b.channel === inspectedChannel) || b.y - a.y);
  for (const fixture of beamFixtures) {
    const opacity = fixture.channel === inspectedChannel ? Math.max(.75, strength) : strength;
    drawBeam(drawing, gradients, fixture, targets.get(fixture.channel), toPixel, plan, `${gradientId}-${fixture.channel}`, opacity);
  }

  for (const fixture of fixtures) {
    const [cx, cy] = pixel(fixture.position);
    const target = targets.get(fixture.channel);
    const color = fixtureColor(target);
    const off = target?.level === 0;
    const inspected = fixture.channel === inspectedChannel;
    if (!plan && (inspected || (target && !isLook))) {
      line(fixture.position, project(fixture.x, fixture.y), 'stage-preview-height');
    }
    if (target && !isLook && target.level > 0 && !color && !Number.isFinite(target.zoom)) {
      const fraction = target.level / 100;
      drawing.append(svgElement('circle', {cx, cy, r: 12 + fraction * 10, opacity: .14 + fraction * .25, class: 'stage-preview-glow'}));
    }
    if (target) {
      drawing.append(svgElement('circle', {
        cx, cy, r: isLook ? 7.5 : 9,
        class: off ? 'stage-preview-target stage-preview-target-off' : 'stage-preview-target',
        'data-target-channel': fixture.channel,
      }));
    }
    if (inspected && (isLook || !target)) {
      drawing.append(svgElement('circle', {cx, cy, r: isLook && target ? 12 : 9, class: 'stage-preview-inspected'}));
    }
    const point = svgElement('circle', {cx, cy, r: 4.5, class: 'stage-preview-fixture', 'data-channel': fixture.channel});
    if (off) point.classList.add('stage-preview-fixture-off');
    else if (color) point.style.fill = color;
    const title = svgElement('title', {});
    title.textContent = target ? `Channel ${fixture.channel} · ${describeSettings(target)}` : `Channel ${fixture.channel}`;
    point.append(title);
    drawing.append(point);
  }
  svg.replaceChildren(drawing);
  svg.setAttribute('aria-label', `Movement Lab ${plan ? 'floor plan' : 'layout with fixture heights'}. The audience side is on the left.`);
}

export function createStagePreview(root) {
  const gradientId = `stage-preview-beam-${++previewCount}`;
  root.innerHTML = `
    <div class="card-heading"><h2>Movement Lab stage preview</h2></div>
    <p class="hint stage-preview-map-note">Loading the archived fixture map…</p>
    <div class="stage-preview-controls" hidden>
      <label>View<select class="stage-preview-view">
        <option value="height">3D view</option>
        <option value="plan">Floor plan</option>
      </select></label>
      <label>Inspect fixture<select class="stage-preview-selection">
        <option value="">Select a channel</option>
      </select></label>
    </div>
    <div class="stage-preview-plot" hidden>
      <svg role="img" viewBox="0 0 ${plotWidth} ${plotHeight}"></svg>
      <div class="stage-preview-orientation"><span>Audience side</span><span>Back wall</span></div>
    </div>
    <p class="hint stage-preview-fixture-detail" hidden></p>
    <div class="stage-preview-event" role="status" aria-atomic="true">
      <p class="stage-preview-input" hidden></p>
      <div class="stage-preview-result">
        <span class="stage-preview-swatch" aria-hidden="true" hidden></span>
        <strong class="stage-preview-output">Waiting for a rehearsal match</strong>
      </div>
      <p class="hint stage-preview-message">Try a mapped gesture or phrase in rehearsal.</p>
    </div>
    <details class="stage-preview-breakdown" hidden>
      <summary>Channel settings</summary>
      <dl></dl>
    </details>`;
  const view = root.querySelector('.stage-preview-view');
  const selection = root.querySelector('.stage-preview-selection');
  const svg = root.querySelector('svg');
  const fixtureDetail = root.querySelector('.stage-preview-fixture-detail');
  const mapNote = root.querySelector('.stage-preview-map-note');
  const input = root.querySelector('.stage-preview-input');
  const swatch = root.querySelector('.stage-preview-swatch');
  const output = root.querySelector('.stage-preview-output');
  const message = root.querySelector('.stage-preview-message');
  const breakdown = root.querySelector('.stage-preview-breakdown');
  const settingsList = breakdown.querySelector('dl');
  let layout, event, renderedKey, targets = new Map();

  function redraw() {
    if (!layout) return;
    const fixture = layout.fixtures.find(item => item.channel === selection.value);
    fixtureDetail.hidden = !fixture;
    const target = targets.get(selection.value);
    if (fixture) {
      fixtureDetail.textContent = `Channel ${fixture.channel} · ${fixtureRoles[fixture.beamRole] || 'Fixture'} · ${fixture.z} m above the floor`;
      if (target && event?.target?.output_type === 'channel_look') {
        fixtureDetail.textContent += ` · ${describeSettings(target)}`;
      }
    }
    drawStage(svg, layout, view.value, selection.value, targets, event?.target?.output_type === 'channel_look', gradientId);
  }

  function renderBreakdown(isLook, onMap) {
    breakdown.hidden = !isLook || !targets.size;
    if (breakdown.hidden) {
      breakdown.open = false;
      settingsList.replaceChildren();
      return;
    }
    breakdown.querySelector('summary').textContent = `Channel settings (${targets.size})`;
    const items = document.createDocumentFragment();
    for (const [channel, row] of targets) {
      const item = document.createElement('div');
      const title = document.createElement('dt');
      const description = document.createElement('dd');
      title.textContent = `Channel ${channel}`;
      description.textContent = describeSettings(row);
      if (layout && !onMap.has(channel)) description.textContent += ' · Outside this layout';
      const color = fixtureColor(row);
      if (color) {
        const chip = document.createElement('span');
        chip.className = 'stage-preview-swatch';
        chip.setAttribute('aria-hidden', 'true');
        chip.style.backgroundColor = color;
        title.prepend(chip);
      }
      item.append(title, description);
      items.append(item);
    }
    settingsList.replaceChildren(items);
  }

  function lookMessage(onMap) {
    if (!layout) return 'The fixture map is needed to show these settings.';
    if (!onMap.size) return 'These channels are outside this archived layout.';
    const outside = targets.size - onMap.size;
    const off = [...onMap].filter(channel => targets.get(channel).level === 0).length;
    const location = outside ? `${onMap.size} of ${targets.size} channels in this layout.` : '';
    const blackout = off ? `${off} ${off === 1 ? 'fixture' : 'fixtures'} at 0% intensity.` : '';
    const optics = off < onMap.size ? 'Beam width and aim are approximate.' : '';
    return [location, blackout, optics].filter(Boolean).join(' ');
  }

  function render(next) {
    const key = JSON.stringify(next ?? null);
    if (key === renderedKey) return;
    event = next;
    renderedKey = key;
    const target = event?.target;
    const isLook = target?.output_type === 'channel_look';
    const channelTarget = target?.output_type === 'channel_level';
    targets = targetsByChannel(target);
    const onMap = new Set(layout?.fixtures.filter(fixture => targets.has(fixture.channel)).map(fixture => fixture.channel));
    const hasZoom = channelTarget && Number.isFinite(target.zoom);
    const hasColor = channelTarget && fixtureColor(target);
    swatch.hidden = !hasColor;
    swatch.style.backgroundColor = hasColor ? target.color : '';
    const recognized = event?.input;
    input.textContent = recognized ? `${sources[event.source] || 'Rehearsal'} · ${recognized}` : '';
    input.hidden = !recognized;
    output.textContent = event ? (event.name || outputLabel(target) || 'No rehearsal output') : 'Waiting for a rehearsal match';
    if (!event) message.textContent = 'Try a mapped gesture or phrase in rehearsal.';
    else if (isLook) message.textContent = lookMessage(onMap);
    else if (channelTarget && layout && !onMap.size) message.textContent = `Channel ${target.channel} is outside this archived layout.`;
    else if (channelTarget && !onMap.size) message.textContent = 'The fixture map is needed to show these settings.';
    else if (channelTarget && target.level === 0) message.textContent = 'Beam off at 0% intensity.';
    else if (hasZoom) message.textContent = 'Beam width and aim are approximate.';
    else if (hasColor) message.textContent = 'Color shown at a reference beam width.';
    else if (channelTarget) message.textContent = 'Preview of the requested fixture level.';
    else if (target?.cue) message.textContent = 'Fixture levels for this cue are unavailable in the archived layout.';
    else message.textContent = event.message || 'Assign an output in the cue sheet to preview this match.';
    if (channelTarget || !isLook) selection.value = onMap.values().next().value || '';
    else if (!onMap.has(selection.value)) selection.value = '';
    renderBreakdown(isLook, onMap);
    redraw();
  }

  view.addEventListener('change', redraw);
  selection.addEventListener('change', redraw);
  async function loadLayout() {
    try {
      const response = await fetch(mapUrl);
      if (!response.ok) throw new Error('Fixture map unavailable');
      layout = await response.json();
      const {roomWidth, roomDepth} = layout.coordinateSystem;
      mapNote.textContent = `Archived layout · ${roomWidth} × ${roomDepth} m · ${layout.fixtures.length} fixtures`;
      for (const fixture of layout.fixtures) selection.add(new Option(`Channel ${fixture.channel}`, fixture.channel));
      root.querySelector('.stage-preview-controls').hidden = false;
      root.querySelector('.stage-preview-plot').hidden = false;
      renderedKey = undefined;
      render(event);
    } catch {
      mapNote.textContent = 'The archived fixture map could not load.';
    }
  }
  void loadLayout();
  return {render};
}
