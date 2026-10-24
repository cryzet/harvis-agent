import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export async function createServiceControl({
  token,
  getStatus,
  onStop,
}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      return send(response, 421, "Host inválido.");
    }
    if (!authorized(request, token)) return send(response, 401, "No autorizado.");

    if (request.method === "GET" && url.pathname === "/status") {
      return sendJson(response, 200, { running: true, ...getStatus() });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      sendJson(response, 202, { stopping: true });
      onStop();
      return;
    }
    return send(response, 404, "No encontrado.");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    onStop(callback) {
      onStop = callback;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
        const timer = setTimeout(() => server.closeAllConnections?.(), 100);
        timer.unref();
      });
    },
  };
}

function authorized(request, token) {
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(provided);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendJson(response, status, value) {
  return send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}
