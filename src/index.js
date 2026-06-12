import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { NAMESPACE, SOCKET_PATH } from "./events.js";
import { registerHandlers } from "./handlers.js";

const PORT = Number(process.env.PORT ?? 8080);

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: {
    origin: true,
    credentials: true,
  },
});

registerHandlers(io.of(NAMESPACE));

httpServer.listen(PORT, () => {
  console.log(
    `[remote-support] ouvindo em http://localhost:${PORT}${NAMESPACE} (path ${SOCKET_PATH})`,
  );
});
