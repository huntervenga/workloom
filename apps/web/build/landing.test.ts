import template from '../landing.html?raw';
import spa from '../index.html?raw';
import robots from '../public/robots.txt?raw';
import sitemapText from '../public/sitemap.xml?raw';
import landingThemeSource from '../src/landing/theme.ts?raw';
import { describe, expect, it } from 'vitest';
import { createThemeManager, THEME_STORAGE_KEY } from '../src/features/theme/ThemeManager';
import english from '../src/i18n/locales/en/landing.json';
import englishTheme from '../src/i18n/locales/en/theme.json';
import { wireThemeToggle } from '../src/landing/theme';
import { landingCatalogs, landingLocales, landingPath, languageDescriptors } from './landing-locales';
import startTemplate from '../start.html?raw';
import { landingPlugin, landingRequestUrl, LOGIN_HREF, PUBLIC_ORIGIN, renderLanding, renderStart, START_PATH, structuredData, transformLandingHtml } from './landing';

function page(copy = english) {
  const rendered = renderLanding(copy);
  return new DOMParser().parseFromString(`<!doctype html><html><head>${rendered.head}</head><body>${rendered.body}</body></html>`, 'text/html');
}

describe('public landing prerender', () => {
  it('renders real semantic product content and SEO before any JavaScript', () => {
    const document = page();
    expect(document.title).toBe(english.seo.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(english.seo.description);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('index');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(english.seo.title);
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(english.seo.description);
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(`${PUBLIC_ORIGIN}/shots/table.png`);
    expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('h1')?.textContent).toBe(english.hero.title);
    // Every "Try for free" goes to the chooser; sign-in goes straight to the shared Auth login.
    const tries = [...document.querySelectorAll<HTMLAnchorElement>(`a[href="${START_PATH}"]`)];
    expect(tries.filter(link => link.textContent?.startsWith(english.nav.tryFree))).toHaveLength(4);
    expect(document.querySelector('a.sign-in')?.getAttribute('href')).toBe(LOGIN_HREF);
    expect(document.querySelectorAll('a[href="/app"]')).toHaveLength(0);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
    }
    expect(document.querySelector('nav')?.getAttribute('aria-label')).toBe(english.nav.label);
    expect(document.body.querySelectorAll('script,iframe,form,input')).toHaveLength(0);
    for (const feature of Object.values({ ...english.features }).filter((item): item is typeof english.features.tasks => typeof item === 'object')) {
      expect(document.getElementById('features')?.textContent).toContain(feature.title);
    }
    // Screenshots are real files with alternative text and fixed dimensions (no layout shift).
    const images = [...document.querySelectorAll('img')];
    expect(images).toHaveLength(7);
    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/^\/shots\/[a-z-]+\.png$/);
      expect(image.getAttribute('alt')?.length).toBeGreaterThan(20);
      expect(image.getAttribute('width')).toBe('1440');
      expect(image.getAttribute('height')).toBe('900');
    }
    // The honest section lists both sides, and the FAQ is plain disclosure elements.
    expect(document.getElementById('pros')?.querySelectorAll('li')).toHaveLength(Object.keys(english.pros.items).length + Object.keys(english.cons.items).length);
    expect(document.querySelectorAll('#faq details')).toHaveLength(Object.keys(english.faq.items).length);
  });

  it('describes the product and its FAQ as valid JSON-LD that cannot close its script early', () => {
    const hostile = structuredClone(english);
    hostile.faq.items.one = { q: 'Q </script><b>', a: 'A </script>' };
    const json = structuredData(hostile);
    expect(json).not.toContain('</script>');
    const data = JSON.parse(json) as { '@type': string; mainEntity?: { name: string }[] }[];
    expect(data.map(item => item['@type'])).toEqual(['SoftwareApplication', 'FAQPage']);
    expect(data[1]?.mainEntity).toHaveLength(Object.keys(english.faq.items).length);
    expect(data[1]?.mainEntity?.[0]?.name).toBe('Q </script><b>');
    const head = new DOMParser().parseFromString(`<!doctype html><html><head>${renderLanding(english).head}</head><body></body></html>`, 'text/html');
    expect(head.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
  });

  it('renders the sign-up chooser: both choices reach the shared sign-in and it is indexable', () => {
    const rendered = renderStart(english);
    const document = new DOMParser().parseFromString(`<!doctype html><html><head>${rendered.head}</head><body>${rendered.body}</body></html>`, 'text/html');
    expect(document.title).toBe(english.start.seoTitle);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${PUBLIC_ORIGIN}${START_PATH}`);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    const buttons = [...document.querySelectorAll<HTMLAnchorElement>('a.button')];
    expect(buttons.map(button => button.getAttribute('href'))).toEqual([LOGIN_HREF, LOGIN_HREF]);
    expect(buttons.map(button => button.textContent?.replace('→', ''))).toEqual([english.start.newButton, english.start.oldButton]);
    expect(document.querySelectorAll('script,iframe,form,input')).toHaveLength(0);
    expect(document.querySelector('button[data-theme-toggle]')).not.toBeNull();
  });

  it('treats catalog copy as text in both element and attribute contexts', () => {
    const hostile = `A & B <script>alert("x")</script> "quoted" 'single'`;
    const copy = structuredClone(english);
    copy.hero.title = hostile;
    copy.nav.label = hostile;
    copy.seo.title = hostile;
    copy.seo.description = hostile;
    copy.hero.note = hostile;
    copy.faq.items.one = { q: hostile, a: hostile };
    copy.pros.items.one = hostile;
    const document = page(copy);
    expect(document.querySelector('h1')?.textContent).toBe(hostile);
    expect(document.title).toBe(hostile);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(hostile);
    expect(document.querySelector('nav')?.getAttribute('aria-label')).toBe(hostile);
    expect(document.querySelector('.hero-note')?.textContent).toBe(hostile);
    expect(document.querySelector('#faq summary')?.textContent).toBe(hostile);
    expect(document.querySelectorAll('script:not([type="application/ld+json"]),[onerror],[onload],iframe')).toHaveLength(0);
  });

  it('prerenders one accessible theme button beside the header CTA with escaped theme copy', () => {
    const header = page().querySelector('header.site-header');
    const buttons = header?.querySelectorAll('button[data-theme-toggle]');
    expect(buttons).toHaveLength(1);
    const button = buttons?.[0];
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe(englishTheme.label);
    expect(button?.getAttribute('title')).toBe(englishTheme.toDark);
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.textContent).toBe('');
    expect([...(button?.querySelectorAll('svg') ?? [])].every(icon => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(button?.parentElement?.querySelector(`a[href="${START_PATH}"]`)).not.toBeNull();
    expect(header?.querySelector('nav')).not.toBeNull();

    const hostile = `A & B <script>alert("x")</script> "quoted" 'single'`;
    const rendered = renderLanding(english, { label: hostile, toDark: hostile, toLight: hostile });
    const document = new DOMParser().parseFromString(`<!doctype html><html><body>${rendered.body}</body></html>`, 'text/html');
    const hostileButton = document.querySelector('button[data-theme-toggle]');
    expect(hostileButton?.getAttribute('aria-label')).toBe(hostile);
    expect(hostileButton?.getAttribute('title')).toBe(hostile);
    expect(document.querySelectorAll('script,[onerror],[onload],iframe')).toHaveLength(0);
  });

  it('wires the prerendered button to the shared theme store without any other script', () => {
    const store = new Map<string, string>();
    const host = window.document.createElement('div');
    host.innerHTML = renderLanding().body;
    window.document.body.append(host);
    const manager = createThemeManager({
      document: window.document,
      localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } },
    });
    const unwire = wireThemeToggle(host, manager);
    try {
      const button = host.querySelector<HTMLButtonElement>('button[data-theme-toggle]');
      expect(button?.getAttribute('aria-pressed')).toBe('false');
      button?.click();
      expect(window.document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
      expect([...store.keys()]).toEqual([THEME_STORAGE_KEY]);
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      expect(button?.title).toBe(englishTheme.toLight);
      expect(button?.getAttribute('aria-label')).toBe(englishTheme.label);
      button?.click();
      expect(window.document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(button?.title).toBe(englishTheme.toDark);
    } finally {
      unwire();
      host.remove();
      window.document.documentElement.removeAttribute('data-theme');
      window.document.documentElement.style.colorScheme = '';
    }
    // The landing module pulls in only the theme store and its English copy: no app, session or API.
    const imports = [...landingThemeSource.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
    expect(imports.sort()).toEqual(['../features/theme/ThemeManager', '../i18n/locales/en/theme.json']);
    expect(landingThemeSource).not.toMatch(/fetch|XMLHttpRequest|\/api|SessionProvider|dev\/session|mountApp/);
  });

  it('fills the actual HTML template with only the theme scripts and leaves the noindex SPA untouched', () => {
    const html = transformLandingHtml(template);
    expect(html).toContain(`<h1 id="hero-title">${english.hero.title}</h1>`);
    expect(transformLandingHtml(startTemplate)).toContain(`<h1 id="start-title">${english.start.title}</h1>`);
    expect(transformLandingHtml(startTemplate)).not.toContain('<!--start:');
    expect(html).not.toContain('<!--landing:');
    expect(html).not.toContain('/src/main.tsx');
    expect(html).not.toMatch(/SessionProvider|dev\/session/);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const scripts = [...parsed.querySelectorAll('script')];
    const executable = scripts.filter(script => script.getAttribute('type') !== 'application/ld+json');
    expect(executable.map(script => [script.getAttribute('src'), script.getAttribute('type')])).toEqual([['/theme-init.js', null], ['/src/landing/theme.ts', 'module']]);
    expect(executable.every(script => script.textContent === '' && script.parentElement === parsed.head)).toBe(true);
    // Plus the JSON-LD data block, which the browser never executes.
    expect(html.match(/<script(?![^>]*ld\+json)/g)).toHaveLength(2);
    // The classic theme script blocks parsing before the stylesheet and after the theme-color it updates.
    expect(html.indexOf('name="theme-color"')).toBeLessThan(html.indexOf('/theme-init.js'));
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/landing/landing.css'));
    expect(parsed.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f7f5fc');
    expect(html).toContain('/src/landing/landing.css');
    expect(transformLandingHtml(spa)).toBe(spa);
    expect(spa).toContain('<meta name="robots" content="noindex"');
    const plugin = landingPlugin();
    const hook = plugin.transformIndexHtml;
    expect(typeof hook).toBe('object');
    if (typeof hook !== 'object' || typeof hook.handler !== 'function') throw new Error('Expected HTML transform hook');
    expect(hook.order).toBe('pre');
    // The plugin uses the same tested renderer, before Vite extracts CSS assets.
    const context = { meta: { rollupVersion: '4', watchMode: false, viteVersion: 'test' }, error: () => { throw new Error('Unexpected transform error'); }, warn: () => undefined, info: () => undefined, debug: () => undefined };
    expect(hook.handler.call(context, html, { path: '/landing.html', filename: '/landing.html' })).toBe(html);
  });

  it('keeps replacement-string dollar tokens literal in catalog text', () => {
    const copy = structuredClone(english);
    const literal = "Literal $& $` $' $$ <quoted> \"text\"";
    copy.hero.title = literal;
    copy.seo.title = literal;
    const html = transformLandingHtml(template, copy);
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.title).toBe(literal);
    expect(document.querySelector('h1')?.textContent).toBe(literal);
    expect(html).not.toContain('<!--landing:');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('advertises the localized public landings and choosers, but not the app, in crawl resources', () => {
    expect(robots).toContain('Disallow: /app');
    expect(robots).toContain('Disallow: /api');
    expect(robots).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    const sitemap = new DOMParser().parseFromString(sitemapText, 'application/xml');
    expect([...sitemap.querySelectorAll('loc')].map(node => node.textContent)).toEqual([`${PUBLIC_ORIGIN}/`, `${PUBLIC_ORIGIN}${START_PATH}`, `${PUBLIC_ORIGIN}/docs`, ...landingLocales.filter(locale => locale !== 'en').flatMap(locale => [PUBLIC_ORIGIN + landingPath(locale), PUBLIC_ORIGIN + landingPath(locale, true)])]);
  });

  it.each(landingLocales)('prerenders complete %s landing and start copy, links, metadata and controls', locale => {
    const catalog = landingCatalogs[locale];
    const shape = (value: unknown, prefix = ''): string[] => {
      if (Array.isArray(value)) return value.flatMap((item, index) => shape(item, `${prefix}.${index}`));
      if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => shape(item, `${prefix}.${key}`));
      expect(typeof value).toBe('string');
      expect(String(value).trim()).not.toBe('');
      return [prefix];
    };
    expect(shape(catalog)).toEqual(shape(english));
    for (const start of [false, true]) {
      const html = transformLandingHtml(start ? startTemplate : template, catalog, catalog.theme, locale);
      const document = new DOMParser().parseFromString(html, 'text/html');
      expect(document.documentElement.lang).toBe(languageDescriptors[locale].lang);
      expect(document.querySelector('h1')?.textContent).toBe(start ? catalog.start.title : catalog.hero.title);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(PUBLIC_ORIGIN + landingPath(locale, start));
      expect(document.querySelectorAll('link[rel="alternate"]')).toHaveLength(7);
      expect([...document.querySelectorAll('.language-options a')].map(a => a.getAttribute('href'))).toEqual(landingLocales.map(item => landingPath(item, start)));
      expect(document.querySelector('.language-options [aria-current="page"]')?.getAttribute('href')).toBe(landingPath(locale, start));
      expect(document.querySelector('.language-picker summary')?.getAttribute('aria-label')).toBe(catalog.language.choose);
      expect(document.querySelector('[data-theme-toggle]')?.getAttribute('title')).toBe(catalog.theme.toDark);
      expect(document.querySelector('a[href="https://github.com/huntervenga/workloom"]')?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(document.querySelector(`a[href="https://pavelignatov.com${locale === 'en' ? '' : `/${locale}`}"]`)).not.toBeNull();
      if (!start) {
        expect(document.querySelector('.hero-actions a')?.getAttribute('href')).toBe(landingPath(locale, true));
        expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(PUBLIC_ORIGIN + '/shots/table.png');
        const data = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? '[]');
        expect(data[0].inLanguage).toBe(languageDescriptors[locale].lang);
        expect(data[0].url).toBe(PUBLIC_ORIGIN + landingPath(locale));
      }
    }
  });
});

describe('landing dev and preview rewrite', () => {
  it.each(['GET', 'HEAD'])('rewrites only the root for %s, retaining its query', method => {
    expect(landingRequestUrl(method, '/')).toBe('/landing.html');
    expect(landingRequestUrl(method, '/?from=local%20test')).toBe('/landing.html?from=local%20test');
    for (const url of ['/app', '/app/', '/app/w/id?x=1', '/w/id', '/api/v1/me', '/assets/app.js', '/landing.html', '/other']) {
      expect(landingRequestUrl(method, url)).toBe(url);
    }
  });
  it('does not rewrite writes or missing request URLs', () => {
    expect(landingRequestUrl('POST', '/')).toBe('/');
    expect(landingRequestUrl(undefined, '/')).toBe('/');
    expect(landingRequestUrl('GET', undefined)).toBeUndefined();
    const plugin = landingPlugin();
    expect(typeof plugin.configureServer).toBe('function');
    expect(typeof plugin.configurePreviewServer).toBe('function');
  });
});
