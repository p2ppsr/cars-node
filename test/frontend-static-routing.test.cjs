const assert = require('node:assert/strict')
const test = require('node:test')
const { frontendNginxConfig, validateStaticRouting } = require('../dist/src/frontend-static-routing.js')

test('unconfigured SPA serving retains its existing fallback', () => {
  assert.match(frontendNginxConfig(8081), /listen 8081;/)
  assert.match(frontendNginxConfig(8081), /try_files \$uri\/index.html \$uri \$uri.html \/404.html \/index.html;/)
  assert.doesNotMatch(frontendNginxConfig(8081), /error_page/)
})
test('static routing serves root index, permanent aliases and genuine missing-page status', () => {
  const config = frontendNginxConfig(8080, {version: 1, mode: 'static', redirects: {'/Contact': '/contact', '/docs': 'https://docs.projectbabbage.com'}})
  assert.match(config, /location = \/Contact \{ return 301 \/contact; \}/)
  assert.match(config, /location = \/docs \{ return 301 https:\/\/docs.projectbabbage.com; \}/)
  assert.match(config, /error_page 404 \/404.html;/)
  assert.match(config, /try_files \$uri\/index.html \$uri \$uri.html =404;/)
})
test('static routing accepts only bounded literal redirect entries', () => {
  for (const value of [null, {version: 2, mode: 'static'}, {version: 1, mode: 'spa'}, {version: 1, mode: 'static', redirects: []}, {version: 1, mode: 'static', redirects: {'/docs': '//example.com'}}, {version: 1, mode: 'static', redirects: {'/docs': '$uri'}}, {version: 1, mode: 'static', redirects: {'/docs': '/docs'}}]) {
    assert.throws(() => validateStaticRouting(value))
  }
  assert.throws(() => validateStaticRouting({version: 1, mode: 'static', redirects: Object.fromEntries(Array.from({length: 101}, (_, n) => [`/route${n}`, '/contact']))}))
})
