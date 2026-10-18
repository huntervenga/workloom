import type { Plugin } from 'vite';
import english from '../src/i18n/locales/en/landing.json';
import englishTheme from '../src/i18n/locales/en/theme.json';

export const PUBLIC_ORIGIN = 'https://workloom.pavelignatov.com';
export type LandingCatalog = typeof english;
export type ThemeCatalog = typeof englishTheme;
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

/** Copy is data: it can never insert elements or attributes into the prerendered page. */
export function renderLanding(catalog: LandingCatalog = english, theme: ThemeCatalog = englishTheme): { head: string; body: string } {
  const e = escapeHtml;
  const c = catalog;
  const mark = '<span class="loom-mark" aria-hidden="true"><i></i><i></i><i></i></span>';
  const open = `<a class="button button-primary" href="/app">${e(c.nav.openApp)}<span aria-hidden="true">↗</span></a>`;
  // Works once /src/landing/theme.ts loads; CSS shows the icon for the current data-theme.
  const icon = (name: string, paths: string) => `<svg class="theme-icon theme-icon-${name}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const toggle = `<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" aria-label="${e(theme.label)}" title="${e(theme.toDark)}">${icon('moon', '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>')}${icon('sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>')}</button>`;
  const feature = (item: LandingCatalog['features']['tasks'], index: number) => `<article class="feature-card"><span class="feature-symbol symbol-${index}" aria-hidden="true"></span><p class="card-tag">${e(item.tag)}</p><h3>${e(item.title)}</h3><p>${e(item.description)}</p></article>`;
  const step = (item: LandingCatalog['how']['one']) => `<li><span class="step-number">${e(item.number)}</span><h3>${e(item.title)}</h3><p>${e(item.description)}</p></li>`;
  const row = (task: string, owner: string, status: string, active = false) => `<tr><td><span class="task-name"><span class="task-dot" aria-hidden="true"></span>${e(task)}</span><span class="task-owner">${e(owner)}</span></td><td><span class="status-chip${active ? ' status-active' : ''}">${e(status)}</span></td></tr>`;
  return {
    head: `<title>${e(c.seo.title)}</title>
<meta name="description" content="${e(c.seo.description)}" />
<link rel="canonical" href="${PUBLIC_ORIGIN}/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${e(c.brand)}" />
<meta property="og:title" content="${e(c.seo.title)}" />
<meta property="og:description" content="${e(c.seo.description)}" />
<meta property="og:url" content="${PUBLIC_ORIGIN}/" />`,
    body: `<a class="skip-link" href="#main">${e(c.nav.skip)}</a>
<div id="top" class="landing-shell">
<header class="site-header"><a class="brand" href="/">${mark}${e(c.brand)}</a><nav aria-label="${e(c.nav.label)}"><a href="#features">${e(c.nav.features)}</a><a href="#how-it-works">${e(c.nav.how)}</a></nav><div class="header-actions">${toggle}${open}</div></header>
<main id="main" tabindex="-1">
<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="eyebrow">${e(c.hero.eyebrow)}</p><h1 id="hero-title">${e(c.hero.title)}</h1><p class="hero-description">${e(c.hero.description)}</p><div class="hero-actions">${open}<a class="text-link" href="#how-it-works">${e(c.hero.secondary)}<span aria-hidden="true">↓</span></a></div><p class="hero-note">${e(c.hero.note)}</p></div>
<figure class="workspace-example" aria-label="${e(c.example.label)}"><div class="example-window"><div class="example-top"><span class="example-brand">${mark}${e(c.brand)}</span><span class="example-week">${e(c.example.week)}</span></div><div class="example-content"><p class="eyebrow">${e(c.example.eyebrow)}</p><h2>${e(c.example.project)}</h2><div class="example-tabs"><span>${e(c.example.tasks)}</span></div><table><thead><tr><th scope="col">${e(c.example.taskColumn)}</th><th scope="col">${e(c.example.statusColumn)}</th></tr></thead><tbody>${row(c.example.taskOne,c.example.ownerOne,c.example.statusOne,true)}${row(c.example.taskTwo,c.example.ownerTwo,c.example.statusTwo)}${row(c.example.taskThree,c.example.ownerThree,c.example.statusThree)}</tbody></table><div class="example-plan"><div><span class="plan-dot" aria-hidden="true"></span><h3>${e(c.example.planLabel)}</h3><p>${e(c.example.planDescription)}</p></div><div><span class="fact-dot" aria-hidden="true"></span><h3>${e(c.example.factLabel)}</h3><p>${e(c.example.factDescription)}</p></div></div><p class="connection-note"><span aria-hidden="true">↳</span>${e(c.example.connection)}</p></div></div><figcaption>${e(c.example.caption)}</figcaption></figure></section>
<section id="features" class="features section-space" aria-labelledby="features-title"><div class="section-heading"><p class="eyebrow">${e(c.features.eyebrow)}</p><h2 id="features-title">${e(c.features.title)}</h2><p>${e(c.features.description)}</p></div><div class="feature-grid">${feature(c.features.tasks,1)}${feature(c.features.planning,2)}${feature(c.features.meetings,3)}${feature(c.features.dependencies,4)}</div></section>
<section id="how-it-works" class="how section-space" aria-labelledby="how-title"><div class="section-heading"><p class="eyebrow">${e(c.how.eyebrow)}</p><h2 id="how-title">${e(c.how.title)}</h2></div><ol class="steps">${step(c.how.one)}${step(c.how.two)}${step(c.how.three)}</ol></section>
<section class="closing" aria-labelledby="closing-title"><div><p class="eyebrow">${e(c.closing.eyebrow)}</p><h2 id="closing-title">${e(c.closing.title)}</h2><p>${e(c.closing.description)}</p></div>${open}</section>
</main><footer><div><a class="brand" href="/">${mark}${e(c.brand)}</a><p>${e(c.footer.note)}</p></div><a class="text-link" href="#top">${e(c.footer.top)}<span aria-hidden="true">↑</span></a></footer></div>`,
  };
}

export function transformLandingHtml(html: string, catalog: LandingCatalog = english, theme: ThemeCatalog = englishTheme): string {
  const rendered = renderLanding(catalog, theme);
  return html.replace('<!--landing:head-->', () => rendered.head).replace('<!--landing:body-->', () => rendered.body);
}

/** Run before Vite's HTML fallback; keep queries and every non-root request intact. */
export function landingRequestUrl(method: string | undefined, url: string | undefined): string | undefined {
  if ((method !== 'GET' && method !== 'HEAD') || !url) return url;
  return url === '/' || url.startsWith('/?') ? `/landing.html${url.slice(1)}` : url;
}

export function landingPlugin(): Plugin {
  const rewrite = (request: { method?: string; url?: string }, _response: unknown, next: () => void) => {
    request.url = landingRequestUrl(request.method, request.url);
    next();
  };
  return {
    name: 'workloom-public-landing',
    transformIndexHtml: { order: 'pre', handler: html => transformLandingHtml(html) },
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}
