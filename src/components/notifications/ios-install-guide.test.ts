import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { IosInstallGuide } from './ios-install-guide';

test('install illustration renders all four translated steps without an external player', () => {
  const steps: [string, string, string, string] = [
    'Teilen öffnen',
    'Zum Home-Bildschirm',
    'Vom neuen Icon öffnen',
    'Benachrichtigungen einschalten',
  ];
  const html = renderToStaticMarkup(createElement(IosInstallGuide, { title: 'Anleitung ansehen', steps }));
  expect(html).toContain('data-testid="ios-install-animation"');
  expect(html).toContain('<summary');
  for (const step of steps) expect(html).toContain(step);
  expect(html.match(/<li /g)).toHaveLength(4);
  expect(html).not.toMatch(/<iframe|<video|<script|autoplay/);
});
