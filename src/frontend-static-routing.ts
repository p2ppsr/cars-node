export interface StaticRouting {
  version: 1;
  mode: 'static';
  redirects?: Record<string, string>;
}

export function validateStaticRouting(value: unknown): StaticRouting {
  const config = value as StaticRouting;
  if (!config || config.version !== 1 || config.mode !== 'static') throw new Error('Invalid static routing version or mode');
  const redirects = config.redirects || {};
  if (typeof redirects !== 'object' || Array.isArray(redirects) || Object.keys(redirects).length > 100) throw new Error('Invalid static redirects');
  for (const [source, destination] of Object.entries(redirects)) {
    // Only literal paths and URLs are accepted, never nginx directives or variables.
    if (!/^\/[A-Za-z0-9/_-]*$/.test(source) || source === '/') throw new Error('Invalid static redirect source');
    if (typeof destination !== 'string' || !/^(?:\/[A-Za-z0-9/_.~-]*|https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9/_.~-]*)?)$/.test(destination) || destination.startsWith('//') || source === destination) throw new Error('Invalid static redirect destination');
  }
  return config;
}

export function frontendNginxConfig(frontendPort: number, routing?: StaticRouting): string {
  if (routing) validateStaticRouting(routing);
  const redirects = Object.entries(routing?.redirects || {}).map(([source, destination]) => `    location = ${source} { return 301 ${destination}; }`).join('\n');
  return `server {
    listen ${frontendPort};
    server_name localhost;
    root /usr/share/nginx/html;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_types
        application/javascript
        application/json
        application/manifest+json
        application/rss+xml
        image/svg+xml
        text/css
        text/javascript
        text/plain
        text/xml;

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location ~* \\.(?:avif|webp|jpg|jpeg|png|gif|ico|svg|woff2?)$ {
        add_header Cache-Control "public, max-age=604800, stale-while-revalidate=86400";
        try_files $uri =404;
    }

    ${redirects}
    ${routing ? "error_page 404 /404.html;" : ""}

    location / {
        add_header Cache-Control "no-cache" always;
        # Serve directory-index and flat route-specific HTML shells before falling
        # back to the SPA. Directory indexes support static-site generators such as
        # Astro, while flat shells support routes such as /learn.html.
        try_files $uri/index.html $uri $uri.html ${routing ? '=404' : '/404.html /index.html'};
    }
}`;
}
