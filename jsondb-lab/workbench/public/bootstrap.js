'use strict';

(function bootstrapWorkbenchExtensions() {
  function addStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  async function main() {
    addStyle('/sort-lab.css');
    await loadScript('/sort-core.js');
    await loadScript('/audio.js');
    await loadScript('/sort-lab.js');
    await loadScript('/core-app.js');
  }

  main().catch(error => {
    console.error('KIRION Workbench extension bootstrap failed:', error);
    const host = document.querySelector('#currentExplanation');
    if (host) host.innerHTML = `<span>EXTENSION BOOT FAILURE</span><p>${String(error.message || error)}</p>`;
  });
})();
