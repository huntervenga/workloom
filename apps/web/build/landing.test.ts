import template from '../landing.html?raw';
import spa from '../index.html?raw';
import robots from '../public/robots.txt?raw';
import sitemapText from '../public/sitemap.xml?raw';
import { describe, expect, it } from 'vitest';
import english from '../src/i18n/locales/en/landing.json';
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

  it('fills the actual HTML template without app scripts and leaves the noindex SPA untouched', () => {
    const html = transformLandingHtml(template);
    expect(html).toContain(`<h1 id="hero-title">${english.hero.title}</h1>`);
    expect(html).not.toContain('<!--landing:');
    expect(html).not.toContain('/src/main.tsx');
    expect(html).not.toMatch(/<script|SessionProvider|dev\/session/);
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

  it('advertises only the public root in crawl resources', () => {
    expect(robots).toContain('Disallow: /app');
    expect(robots).toContain('Disallow: /api');
    expect(robots).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    const sitemap = new DOMParser().parseFromString(sitemapText, 'application/xml');
    expect([...sitemap.querySelectorAll('loc')].map(node => node.textContent)).toEqual([`${PUBLIC_ORIGIN}/`]);
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
