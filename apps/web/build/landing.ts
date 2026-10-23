import type { Plugin } from 'vite';
import english from '../src/i18n/locales/en/landing.json';
import englishTheme from '../src/i18n/locales/en/theme.json';

export const PUBLIC_ORIGIN = 'https://workloom.pavelignatov.com';
/** Where "Try for free" leads: a page that offers sign-up or sign-in. */
export const START_PATH = '/start';
/** The shared Auth sign-in; creating the account happens at the first sign-in. */
export const LOGIN_HREF = '/api/v1/auth/login?returnTo=%2Fapp';
export type LandingCatalog = typeof english;
export type ThemeCatalog = typeof englishTheme;
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

const SHOTS = ['table', 'board', 'timeline', 'task', 'inbox', 'timeoff'] as const;
const SHOT_FILE: Record<(typeof SHOTS)[number], string> = { table: 'table', board: 'board', timeline: 'timeline', task: 'task', inbox: 'inbox', timeoff: 'time-off' };
const FEATURES = ['tasks', 'planning', 'timeoff', 'dependencies', 'inbox', 'api'] as const;

const mark = '<span class="loom-mark" aria-hidden="true"><i></i><i></i><i></i></span>';
function themeToggle(theme: ThemeCatalog): string {
  const e = escapeHtml;
  // Works once /src/landing/theme.ts loads; CSS shows the icon for the current data-theme.
  const icon = (name: string, paths: string) => `<svg class="theme-icon theme-icon-${name}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" aria-label="${e(theme.label)}" title="${e(theme.toDark)}">${icon('moon', '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>')}${icon('sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-2.93 1.41-1.41m11.32-11.32 1.41-1.41M2 12h2m16 0h2M6.34 6.34 4.93 4.93m14.14 14.14-1.41-1.41"/>')}</button>`;
}
const tryButton = (label: string, className = 'button button-primary') => `<a class="${className}" href="${START_PATH}">${escapeHtml(label)}<span aria-hidden="true">→</span></a>`;

/** JSON-LD for search engines: the product and its frequently asked questions. Serialised, never interpolated into markup. */
export function structuredData(c: LandingCatalog): string {
  const data = [
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: c.brand, url: `${PUBLIC_ORIGIN}/`, applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: c.seo.description, image: `${PUBLIC_ORIGIN}/shots/table.png`, inLanguage: 'en' },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: Object.values(c.faq.items).map(item => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
  ];
  // "<" cannot end the script element early once escaped.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Copy is data: it can never insert elements or attributes into the prerendered page. */
export function renderLanding(catalog: LandingCatalog = english, theme: ThemeCatalog = englishTheme): { head: string; body: string } {
  const e = escapeHtml;
  const c = catalog;
  const feature = (key: (typeof FEATURES)[number], index: number) => { const item = c.features[key]; return `<article class="feature-card"><span class="feature-symbol symbol-${(index % 4) + 1}" aria-hidden="true"></span><p class="card-tag">${e(item.tag)}</p><h3>${e(item.title)}</h3><p>${e(item.description)}</p></article>`; };
  const step = (item: LandingCatalog['how']['one']) => `<li><span class="step-number">${e(item.number)}</span><h3>${e(item.title)}</h3><p>${e(item.description)}</p></li>`;
  const shot = (key: (typeof SHOTS)[number]) => { const item = c.screens[key]; return `<figure class="shot-card"><div class="shot-frame"><img src="/shots/${SHOT_FILE[key]}.png" width="1440" height="900" loading="lazy" decoding="async" alt="${e(item.alt)}" /></div><figcaption><strong>${e(item.title)}</strong> ${e(item.description)}</figcaption></figure>`; };
  const list = (items: Record<string, string>) => Object.values(items).map(item => `<li>${e(item)}</li>`).join('');
  const faq = Object.values(c.faq.items).map(item => `<details class="faq-item"><summary>${e(item.q)}</summary><p>${e(item.a)}</p></details>`).join('');
  return {
    head: `<title>${e(c.seo.title)}</title>
<meta name="description" content="${e(c.seo.description)}" />
<meta name="keywords" content="${e(c.seo.keywords)}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${PUBLIC_ORIGIN}/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${e(c.brand)}" />
<meta property="og:locale" content="en_US" />
<meta property="og:title" content="${e(c.seo.title)}" />
<meta property="og:description" content="${e(c.seo.description)}" />
<meta property="og:url" content="${PUBLIC_ORIGIN}/" />
<meta property="og:image" content="${PUBLIC_ORIGIN}/shots/table.png" />
<meta property="og:image:width" content="1440" />
<meta property="og:image:height" content="900" />
<meta property="og:image:alt" content="${e(c.seo.image)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${e(c.seo.title)}" />
<meta name="twitter:description" content="${e(c.seo.description)}" />
<meta name="twitter:image" content="${PUBLIC_ORIGIN}/shots/table.png" />
<script type="application/ld+json">${structuredData(c)}</script>`,
    body: `<a class="skip-link" href="#main">${e(c.nav.skip)}</a>
<div id="top" class="landing-shell">
<header class="site-header"><a class="brand" href="/">${mark}${e(c.brand)}</a><nav aria-label="${e(c.nav.label)}"><a href="#features">${e(c.nav.features)}</a><a href="#screens">${e(c.nav.screens)}</a><a href="#pros">${e(c.nav.pros)}</a><a href="#faq">${e(c.nav.faq)}</a><a href="/docs">${e(c.nav.docs)}</a></nav><div class="header-actions">${themeToggle(theme)}<a class="sign-in" href="${LOGIN_HREF}">${e(c.nav.signIn)}</a>${tryButton(c.nav.tryFree)}</div></header>
<main id="main" tabindex="-1">
<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="eyebrow">${e(c.hero.eyebrow)}</p><h1 id="hero-title">${e(c.hero.title)}</h1><p class="hero-description">${e(c.hero.description)}</p><div class="hero-actions">${tryButton(c.nav.tryFree)}<a class="text-link" href="#how-it-works">${e(c.hero.secondary)}<span aria-hidden="true">↓</span></a></div><p class="hero-note">${e(c.hero.note)}</p></div>
<figure class="hero-shot"><div class="shot-frame"><img src="/shots/table.png" width="1440" height="900" fetchpriority="high" decoding="async" alt="${e(c.hero.shotAlt)}" /></div><figcaption>${e(c.hero.shotCaption)}</figcaption></figure></section>
<section id="features" class="features section-space" aria-labelledby="features-title"><div class="section-heading"><p class="eyebrow">${e(c.features.eyebrow)}</p><h2 id="features-title">${e(c.features.title)}</h2><p>${e(c.features.description)}</p></div><div class="feature-grid">${FEATURES.map(feature).join('')}</div></section>
<section id="screens" class="screens section-space" aria-labelledby="screens-title"><div class="section-heading"><p class="eyebrow">${e(c.screens.eyebrow)}</p><h2 id="screens-title">${e(c.screens.title)}</h2><p>${e(c.screens.description)}</p></div><div class="shot-grid">${SHOTS.map(shot).join('')}</div></section>
<section id="how-it-works" class="how section-space" aria-labelledby="how-title"><div class="section-heading"><p class="eyebrow">${e(c.how.eyebrow)}</p><h2 id="how-title">${e(c.how.title)}</h2></div><ol class="steps">${step(c.how.one)}${step(c.how.two)}${step(c.how.three)}</ol></section>
<section id="pros" class="pros section-space" aria-labelledby="pros-title"><div class="section-heading"><p class="eyebrow">${e(c.pros.eyebrow)}</p><h2 id="pros-title">${e(c.pros.heading)}</h2></div><div class="pros-grid"><div class="pros-card pros-yes"><h3>${e(c.pros.title)}</h3><ul>${list(c.pros.items)}</ul></div><div class="pros-card pros-no"><h3>${e(c.cons.title)}</h3><ul>${list(c.cons.items)}</ul></div></div></section>
<section id="faq" class="faq section-space" aria-labelledby="faq-title"><div class="section-heading"><p class="eyebrow">${e(c.faq.eyebrow)}</p><h2 id="faq-title">${e(c.faq.title)}</h2></div><div class="faq-list">${faq}</div></section>
<section class="closing" aria-labelledby="closing-title"><div><p class="eyebrow">${e(c.closing.eyebrow)}</p><h2 id="closing-title">${e(c.closing.title)}</h2><p>${e(c.closing.description)}</p></div>${tryButton(c.nav.tryFree)}</section>
</main><footer><div><a class="brand" href="/">${mark}${e(c.brand)}</a><p>${e(c.footer.note)}</p></div><div class="footer-links"><a class="text-link" href="/docs">${e(c.footer.docs)}</a><a class="text-link" href="${START_PATH}">${e(c.footer.start)}</a><a class="text-link" href="#top">${e(c.footer.top)}<span aria-hidden="true">↑</span></a></div></footer></div>`,
  };
}

/** The sign-up / sign-in chooser at /start. */
export function renderStart(catalog: LandingCatalog = english, theme: ThemeCatalog = englishTheme): { head: string; body: string } {
  const e = escapeHtml;
  const s = catalog.start;
  return {
    head: `<title>${e(s.seoTitle)}</title>
<meta name="description" content="${e(s.seoDescription)}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${PUBLIC_ORIGIN}${START_PATH}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${e(catalog.brand)}" />
<meta property="og:title" content="${e(s.seoTitle)}" />
<meta property="og:description" content="${e(s.seoDescription)}" />
<meta property="og:url" content="${PUBLIC_ORIGIN}${START_PATH}" />
<meta property="og:image" content="${PUBLIC_ORIGIN}/shots/table.png" />`,
    body: `<a class="skip-link" href="#main">${e(catalog.nav.skip)}</a>
<div id="top" class="landing-shell">
<header class="site-header"><a class="brand" href="/">${mark}${e(catalog.brand)}</a><div class="header-actions">${themeToggle(theme)}</div></header>
<main id="main" tabindex="-1" class="start">
<div class="section-heading start-heading"><h1 id="start-title">${e(s.title)}</h1><p>${e(s.description)}</p></div>
<div class="start-grid">
<section class="start-card start-new" aria-labelledby="start-new"><h2 id="start-new">${e(s.newTitle)}</h2><p>${e(s.newDescription)}</p><a class="button button-primary" href="${LOGIN_HREF}">${e(s.newButton)}<span aria-hidden="true">→</span></a></section>
<section class="start-card" aria-labelledby="start-old"><h2 id="start-old">${e(s.oldTitle)}</h2><p>${e(s.oldDescription)}</p><a class="button button-secondary" href="${LOGIN_HREF}">${e(s.oldButton)}<span aria-hidden="true">→</span></a></section>
</div>
<p class="start-note">${e(s.note)}</p>
<p class="start-links"><a class="text-link" href="/">${e(s.back)}</a> · <a class="text-link" href="/docs">${e(s.looking)}</a></p>
</main></div>`,
  };
}

function fill(html: string, rendered: { head: string; body: string }, marker: 'landing' | 'start'): string {
  return html.replace(`<!--${marker}:head-->`, () => rendered.head).replace(`<!--${marker}:body-->`, () => rendered.body);
}
export function transformLandingHtml(html: string, catalog: LandingCatalog = english, theme: ThemeCatalog = englishTheme): string {
  return fill(fill(html, renderLanding(catalog, theme), 'landing'), renderStart(catalog, theme), 'start');
}

/** Run before Vite's HTML fallback; keep queries and every non-root request intact. */
export function landingRequestUrl(method: string | undefined, url: string | undefined): string | undefined {
  if ((method !== 'GET' && method !== 'HEAD') || !url) return url;
  return url === '/' || url.startsWith('/?') ? `/landing.html${url.slice(1)}` : url;
}

export function landingPlugin(): Plugin {
  const rewrite = (request: { method?: string; url?: string }, _response: unknown, next: () => void) => {
    request.url = landingRequestUrl(request.method, request.url);
    // The public pages live at /docs and /start, like in the production server.
    for (const page of ['docs', 'start']) {
      if ((request.method === 'GET' || request.method === 'HEAD') && request.url && new RegExp(`^/${page}/?(\\?|$)`).test(request.url)) {
        const query = request.url.indexOf('?');
        request.url = `/${page}.html${query === -1 ? '' : request.url.slice(query)}`;
      }
    }
    next();
  };
  return {
    name: 'workloom-public-landing',
    transformIndexHtml: { order: 'pre', handler: html => transformLandingHtml(html) },
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}
