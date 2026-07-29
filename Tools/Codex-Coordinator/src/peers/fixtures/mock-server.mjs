import { WebSocketServer } from "ws";

export async function createMockAppServer({
  onRequest,
  onConnection,
} = {}) {
  const requests = [];
  const connections = new Set();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    onConnection?.(socket);
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString("utf8"));
      requests.push(request);
      if (!Object.hasOwn(request, "id")) {
        return;
      }
      try {
        const result = onRequest
          ? await onRequest(request, socket, requests)
          : defaultResult(request);
        if (result !== NO_RESPONSE && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ id: request.id, result }));
        }
      } catch (error) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32000,
                message: error.message,
              },
            }),
          );
        }
      }
    });
  });

  const address = server.address();
  const endpoint = `ws://127.0.0.1:${address.port}`;

  return {
    endpoint,
    port: address.port,
    requests,
    notify(method, params = {}) {
      for (const socket of connections) {
        socket.send(JSON.stringify({ method, params }));
      }
    },
    sendRaw(value) {
      for (const socket of connections) {
        socket.send(value);
      }
    },
    terminateConnections() {
      for (const socket of connections) {
        socket.terminate();
      }
    },
    async close() {
      for (const socket of connections) {
        socket.terminate();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export const NO_RESPONSE = Symbol("NO_RESPONSE");

function defaultResult(request) {
  switch (request.method) {
    case "initialize":
      return {
        userAgent: "mock-codex-app-server/0.145.0",
      };
    case "thread/read":
      return {
        thread: {
          id: request.params.threadId,
          status: { type: "notLoaded" },
          turns: [],
        },
      };
    case "thread/resume":
      return {
        thread: {
          id: request.params.threadId,
          status: { type: "idle" },
          turns: [],
        },
      };
    case "thread/turns/list":
      return {
        data: [],
        nextCursor: null,
      };
    case "turn/start":
      return {
        turn: {
          id: "turn-mock-1",
          status: "inProgress",
        },
      };
    case "turn/steer":
      return {
        turnId: request.params.expectedTurnId,
      };
    case "turn/interrupt":
      return {};
    default:
      return {};
  }
}
