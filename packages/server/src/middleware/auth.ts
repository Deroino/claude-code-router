import { FastifyRequest, FastifyReply } from "fastify";
import { ConfigService } from "@musistudio/llms";

export const apiKeyAuth =
  (configService: ConfigService) =>
  async (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // Get latest config from ConfigService (supports hot-reload)
    const config = configService.getAll();

    // Check if authentication is explicitly disabled via config
    if (config.noAuth === true) {
      return done();
    }

    // Public endpoints that don't require authentication
    const publicPaths = ["/", "/health", "/api/logs/stream", "/api/model-test", "/api/config/stream"];
    if (publicPaths.includes(req.url) || req.url.startsWith("/ui")) {
      return done();
    }

    // Check if Providers is empty or not configured
    const providers = config.Providers || config.providers || [];
    if (!providers || providers.length === 0) {
      // No providers configured, skip authentication
      return done();
    }

    const apiKey = config.APIKEY;
    if (!apiKey) {
      // If no API key is set, enable CORS for local
      const allowedOrigins = [
        `http://127.0.0.1:${config.PORT || 3456}`,
        `http://localhost:${config.PORT || 3456}`,
      ];
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
        reply.status(403).send("CORS not allowed for this origin");
        return;
      } else {
        reply.header('Access-Control-Allow-Origin', `http://127.0.0.1:${config.PORT || 3456}`);
        reply.header('Access-Control-Allow-Origin', `http://localhost:${config.PORT || 3456}`);
      }
      return done();
    }

    const authHeaderValue =
      req.headers.authorization || req.headers["x-api-key"];
    const authKey: string = Array.isArray(authHeaderValue)
      ? authHeaderValue[0]
      : authHeaderValue || "";
    if (!authKey) {
      reply.status(401).send("APIKEY is missing");
      return;
    }
    let token = "";
    if (authKey.startsWith("Bearer")) {
      token = authKey.split(" ")[1];
    } else {
      token = authKey;
    }

    if (token !== apiKey) {
      reply.status(401).send("Invalid API key");
      return;
    }

    done();
  };
