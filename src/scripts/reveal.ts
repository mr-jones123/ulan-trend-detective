const STAGGER_MS = 70;
const elements = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];

if ('IntersectionObserver' in window && elements.length > 0) {
  document.documentElement.classList.add('reveal-ready');
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target;
      if (!(element instanceof HTMLElement)) continue;
      const siblings = element.parentElement ? [...element.parentElement.querySelectorAll(':scope > [data-reveal]')] : [];
      element.style.transitionDelay = `${Math.max(0, siblings.indexOf(element)) * STAGGER_MS}ms`;
      element.classList.add('is-in');
      observer.unobserve(element);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const element of elements) observer.observe(element);
}
