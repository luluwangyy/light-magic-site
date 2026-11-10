const setup = document.querySelector('[data-setup-tabs]');
const tablist = setup?.querySelector('[data-setup-tablist]');
if (tablist) enhanceSetup(tablist);

function enhanceSetup(tablist) {
  const tabs = [...tablist.querySelectorAll('[data-setup-tab]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  const validPanels = panels.every(panel => panel?.matches('[data-setup-panel]') && setup.contains(panel));
  if (tabs.length < 2 || !validPanels || new Set(panels).size !== tabs.length) return;

  function activate(index) {
    tabs.forEach((tab, position) => {
      const selected = position === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[position].hidden = !selected;
    });
  }

  tablist.setAttribute('role', 'tablist');
  tabs.forEach((tab, index) => {
    const panel = panels[index];
    if (!tab.id) tab.id = panel.id + '-tab';
    tab.setAttribute('role', 'tab');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    tab.addEventListener('click', () => activate(index));
    tab.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      let next;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (index + tabs.length - 1) % tabs.length;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          next = (index + 1) % tabs.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = tabs.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      activate(next);
      tabs[next].focus();
    });
  });

  const initial = tabs.findIndex(tab => tab.hasAttribute('data-setup-active'));
  activate(Math.max(initial, 0));
  tablist.hidden = false;
}
