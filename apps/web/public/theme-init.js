// Initial anonymous/loading palette. Authenticated /me settings replace it before the app is shown.
(function (w) {
  var theme = 'light';
  try { if (w.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'default-dark'; } catch (_) { /* Light fallback. */ }
  try {
    var root = w.document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
    var meta = w.document.querySelector('meta[name="theme-color"]');
    var color = meta && meta.getAttribute(theme === 'light' ? 'data-light' : 'data-dark');
    if (meta && color) meta.setAttribute('content', color);
  } catch (_) { /* No document. */ }
})(window);
