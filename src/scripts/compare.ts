for (const figure of document.querySelectorAll<HTMLElement>('[data-compare]')) {
  const top = figure.querySelector<HTMLElement>('[data-compare-top]');
  const handle = figure.querySelector<HTMLElement>('[data-compare-handle]');
  const range = figure.querySelector<HTMLInputElement>('[data-compare-range]');
  const frame = figure.querySelector<HTMLElement>('.compare-frame');
  if (!top || !handle || !range || !frame) continue;

  const set = (percent: number) => {
    const clamped = Math.min(100, Math.max(0, percent));
    top.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
    handle.style.left = `${clamped}%`;
    range.value = String(Math.round(clamped));
  };
  const fromPointer = (event: PointerEvent) => {
    const box = frame.getBoundingClientRect();
    set(((event.clientX - box.left) / box.width) * 100);
  };

  range.addEventListener('input', () => {
    figure.dataset.dragging = 'false';
    set(Number(range.value));
  });
  frame.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    figure.dataset.dragging = 'true';
    frame.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  frame.addEventListener('pointermove', (event) => {
    if (figure.dataset.dragging === 'true' && frame.hasPointerCapture(event.pointerId)) fromPointer(event);
  });
  const end = (event: PointerEvent) => {
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    figure.dataset.dragging = 'false';
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
  set(Number(range.value));
}
