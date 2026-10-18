// Runs in <head> before the stylesheets: applies the saved theme, else the system one, else light,
// so the first paint already has the right colors. Mirrors src/features/theme/ThemeManager.ts.
(function (w) {
  var theme = null;
  try {
    theme = w.localStorage.getItem('workloom.theme');
  } catch {
    theme = null;
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = 'light';
    try {
      if (w.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
    } catch {
      theme = 'light';
    }
  }
  try {
    var root = w.document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var meta = w.document.querySelector('meta[name="theme-color"]');
    var color = meta && meta.getAttribute('data-' + theme);
    if (color) meta.setAttribute('content', color);
  } catch {
    // Without a document the page keeps its default light look.
  }
})(globalThis);
