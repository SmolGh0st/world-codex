
(function(){
  const root = document.documentElement;
  const look = document.getElementById('look');
  const face = document.getElementById('face');
  if (look){
    look.value = root.dataset.theme;
    look.addEventListener('change', () => {
      root.dataset.theme = look.value;
      try { localStorage.setItem('cdb-look', look.value); } catch (e) {}
    });
  }
  if (face){
    const order = ['system', 'dark', 'light'];
    const icons = {system: '◐', dark: '☾', light: '☀'};
    let mode = 'system';
    try { mode = localStorage.getItem('cdb-theme') || 'system'; } catch (e) {}
    if (order.indexOf(mode) < 0) mode = 'system';
    const apply = () => {
      const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.face = dark ? 'night' : 'day';
      face.textContent = icons[mode];
    };
    face.addEventListener('click', () => {
      mode = order[(order.indexOf(mode) + 1) % order.length];
      try { localStorage.setItem('cdb-theme', mode); } catch (e) {}
      apply();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
    apply();
  }
})();
