import type { Server } from 'node:http';

/**
 * Large CARS artifacts can legitimately take longer than Node's default
 * five-minute request deadline to arrive. Upload handling already has its own
 * explicit middleware timeout, so the HTTP server must not impose a second,
 * shorter whole-request deadline.
 */
export function disableRequestTimeout(server: Pick<Server, 'requestTimeout'>): void {
  server.requestTimeout = 0;
}

/** Close admission and idle keepalives without killing accepted requests. */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}
