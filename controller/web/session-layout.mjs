const panelNames = {
  rehearsal: 'Rehearsal',
  speech: 'Speech',
  gesture: 'Gesture',
  stage: 'Stage preview',
};
const defaultOrder = Object.keys(panelNames);
const storageKey = 'light-magic-session-layout';

function readLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const order = [...new Set((saved?.order || []).filter(key => defaultOrder.includes(key)))];
    const hidden = new Set((saved?.hidden || []).filter(key => defaultOrder.includes(key)));
    return {order: [...order, ...defaultOrder.filter(key => !order.includes(key))], hidden};
  } catch {
    return {order: [...defaultOrder], hidden: new Set()};
  }
}

function button(text, label, className) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (label) element.setAttribute('aria-label', label);
  if (className) element.className = className;
  return element;
}

export function mountSessionLayout(main) {
  const tools = document.getElementById('sessionLayoutTools');
  const restoreList = document.getElementById('hiddenSessionPanels');
  const reset = document.getElementById('resetSessionLayout');
  const status = document.getElementById('sessionLayoutStatus');
  let {order, hidden} = readLayout();
  let view = 'session', drag = null;
  const panels = new Map();

  function render() {
    const session = view === 'session';
    const visible = order.filter(key => !hidden.has(key));
    main.dataset.sessionColumns = String(Math.max(1, visible.filter(key => key !== order[0]).length));
    tools.hidden = !session;
    reset.hidden = !hidden.size && order.every((key, index) => key === defaultOrder[index]);
    for (const [key, {panel, controls, restore, grip, moveOptions, previous, next}] of panels) {
      const index = order.indexOf(key);
      const visibleIndex = visible.indexOf(key);
      panel.style.order = index;
      panel.toggleAttribute('data-session-wide', index === 0);
      panel.hidden = session ? hidden.has(key) : !(view === 'learn' && key === 'gesture');
      controls.hidden = !session;
      restore.hidden = !hidden.has(key);
      previous.disabled = visibleIndex <= 0;
      next.disabled = visibleIndex < 0 || visibleIndex >= visible.length - 1;
      if (panel.hidden || !session) {
        moveOptions.hidden = true;
        grip.setAttribute('aria-expanded', 'false');
      }
    }
  }

  function save(message) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({order, hidden: [...hidden]}));
    } catch {}
    render();
    if (message) status.textContent = message;
  }

  function move(key, target) {
    if (!target || target === key || !panels.has(target) || hidden.has(target)) return;
    const index = order.indexOf(target);
    order = order.filter(item => item !== key);
    order.splice(index, 0, key);
    save(`${panelNames[key]} moved.`);
  }

  function nudge(key, direction) {
    const visible = order.filter(item => !hidden.has(item));
    move(key, visible[visible.indexOf(key) + direction]);
    panels.get(key).grip.focus();
  }

  function showPanel(key) {
    if (hidden.delete(key)) save(`${panelNames[key]} shown.`);
  }

  function clearDrag() {
    if (!drag) return;
    panels.get(drag.key).panel.removeAttribute('data-dragging');
    panels.get(drag.target)?.panel.removeAttribute('data-drop-target');
    drag = null;
  }

  for (const panel of main.querySelectorAll('[data-session-panel]')) {
    const key = panel.dataset.sessionPanel;
    const name = panelNames[key];
    const controls = document.createElement('div');
    controls.className = 'panel-layout-controls';
    const grip = button('⠿', 'Move ' + name, 'panel-grip');
    grip.title = 'Drag to move, or click for move controls';
    grip.setAttribute('aria-expanded', 'false');
    const hide = button('Hide', 'Hide ' + name);
    const restore = button('Show ' + name);
    restore.setAttribute('aria-controls', panel.id);
    const moveOptions = document.createElement('div');
    moveOptions.className = 'panel-move-options';
    moveOptions.hidden = true;
    const previous = button('←', 'Move ' + name + ' earlier');
    const next = button('→', 'Move ' + name + ' later');
    moveOptions.append(previous, next);
    controls.append(grip, moveOptions, hide);
    panel.querySelector('.card-heading').append(controls);
    restoreList.append(restore);
    panels.set(key, {panel, controls, restore, grip, moveOptions, previous, next});

    hide.onclick = () => { hidden.add(key); save(name + ' hidden.'); restore.focus(); };
    restore.onclick = () => { showPanel(key); grip.focus(); };
    previous.onclick = () => nudge(key, -1);
    next.onclick = () => nudge(key, 1);
    let suppressClick = false;
    grip.onclick = () => {
      if (suppressClick) { suppressClick = false; return; }
      moveOptions.hidden = !moveOptions.hidden;
      grip.setAttribute('aria-expanded', String(!moveOptions.hidden));
    };
    grip.onkeydown = event => {
      const direction = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1}[event.key];
      if (!direction) return;
      event.preventDefault();
      nudge(key, direction);
    };
    grip.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0 || view !== 'session') return;
      suppressClick = false;
      drag = {key, pointer: event.pointerId, x: event.clientX, y: event.clientY};
      grip.setPointerCapture(event.pointerId);
    };
    grip.onpointermove = event => {
      if (drag?.key !== key || drag.pointer !== event.pointerId) return;
      if (!drag.started && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
      drag.started = true;
      panel.setAttribute('data-dragging', '');
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-session-panel]')?.dataset.sessionPanel;
      if (target === drag.target) return;
      panels.get(drag.target)?.panel.removeAttribute('data-drop-target');
      drag.target = target;
      if (target !== key) panels.get(target)?.panel.setAttribute('data-drop-target', '');
    };
    grip.onpointerup = event => {
      if (drag?.key !== key || drag.pointer !== event.pointerId) return;
      const {started, target} = drag;
      clearDrag();
      if (started) {
        suppressClick = true;
        move(key, target);
        setTimeout(() => { suppressClick = false; }, 0);
      }
    };
    grip.onpointercancel = grip.onlostpointercapture = () => {
      if (drag?.key === key) clearDrag();
    };
  }

  reset.onclick = () => {
    order = [...defaultOrder];
    hidden.clear();
    save('Default layout restored.');
    panels.get('rehearsal').grip.focus();
  };
  return {
    showPanel,
    setView(next) {
      clearDrag();
      view = next;
      render();
    },
  };
}
