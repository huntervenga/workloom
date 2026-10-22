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
import { landingPlugin, landingRequestUrl, PUBLIC_ORIGIN, renderLanding, transformLandingHtml } from './landing';

function page(copy = english) {
  const rendered = renderLanding(copy);
  return new DOMParser().parseFromString(`<!doctype html><html><head>${rendered.head}</head><body>${rendered.body}</body></html>`, 'text/html');
}

describe('public landing prerender', () => {
  it('renders real semantic product content and SEO before any JavaScript', () => {
    const document = page();
    expect(document.title).toBe(english.seo.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(english.seo.description);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(english.seo.title);
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(english.seo.description);
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('h1')?.textContent).toBe(english.hero.title);
    expect(document.querySelectorAll('a[href="/app"]')).toHaveLength(3);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
    }
    expect(document.querySelector('nav')?.getAttribute('aria-label')).toBe(english.nav.label);
    expect(document.querySelectorAll('script,iframe,form,input')).toHaveLength(0);
    expect(document.querySelector('figure')?.textContent).toContain(english.example.caption);
    for (const feature of [english.features.tasks, english.features.planning, english.features.meetings, english.features.dependencies]) {
      expect(document.getElementById('features')?.textContent).toContain(feature.title);
    }
  });

  it('treats catalog copy as text in both element and attribute contexts', () => {
    const hostile = `A & B <script>alert("x")</script> "quoted" 'single'`;
    const copy = structuredClone(english);
    copy.hero.title = hostile;
    copy.nav.label = hostile;
    copy.seo.title = hostile;
    copy.seo.description = hostile;
    copy.example.taskOne = hostile;
    const document = page(copy);
    expect(document.querySelector('h1')?.textContent).toBe(hostile);
    expect(document.title).toBe(hostile);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(hostile);
    expect(document.querySelector('nav')?.getAttribute('aria-label')).toBe(hostile);
    expect(document.querySelector('table')?.textContent).toContain(hostile);
    expect(document.querySelectorAll('script,[onerror],[onload],iframe')).toHaveLength(0);
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
    expect(button?.parentElement?.querySelector('a[href="/app"]')).not.toBeNull();
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
    expect(html).not.toContain('<!--landing:');
    expect(html).not.toContain('/src/main.tsx');
    expect(html).not.toMatch(/SessionProvider|dev\/session/);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const scripts = [...parsed.querySelectorAll('script')];
    expect(scripts.map(script => [script.getAttribute('src'), script.getAttribute('type')])).toEqual([['/theme-init.js', null], ['/src/landing/theme.ts', 'module']]);
    expect(scripts.every(script => script.textContent === '' && script.parentElement === parsed.head)).toBe(true);
    expect(html.match(/<script/g)).toHaveLength(2);
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

  it('advertises only the public root and the public docs in crawl resources', () => {
    expect(robots).toContain('Disallow: /app');
    expect(robots).toContain('Disallow: /api');
    expect(robots).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    const sitemap = new DOMParser().parseFromString(sitemapText, 'application/xml');
    expect([...sitemap.querySelectorAll('loc')].map(node => node.textContent)).toEqual([`${PUBLIC_ORIGIN}/`, `${PUBLIC_ORIGIN}/docs`]);
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
