import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first"); // Prevent Node 17+ network issues (prefer IPv4)

import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";
import { auth as jwtAuth } from "express-oauth2-jwt-bearer";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

// Core Libraries for AI Logic
import prisma from './lib/prisma.js';
import model from './lib/gemini.js';
import { transcribeAudio } from './lib/googleSpeech.js';
import { synthesizeSpeech } from './lib/googleTTS.js';

import apiRoutes from "./routes/apiRoutes.js";

const app = express();
const PORT = process.env.PORT || 8080;

// -------------------------------------------------------------
// 1. ENVIRONMENT CHECKS
// -------------------------------------------------------------
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_ISSUER = process.env.AUTH0_ISSUER_BASE_URL;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;

if (!AUTH0_DOMAIN || !AUTH0_ISSUER || !AUTH0_AUDIENCE) {
  console.error("[FATAL] Missing required Auth0 environment variables.");
  process.exit(1);
}

// -------------------------------------------------------------
// 2. EXPRESS MIDDLEWARE
// -------------------------------------------------------------
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

const checkJwt = jwtAuth({
  issuerBaseURL: AUTH0_ISSUER,
  audience: AUTH0_AUDIENCE,
  tokenSigningAlg: "RS256",
});

// -------------------------------------------------------------
// 3. JWKS CLIENT FOR WEBSOCKETS
// -------------------------------------------------------------
const jwks = jwksClient({
  jwksUri: `${AUTH0_ISSUER}.well-known/jwks.json`,
});

function getKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// -------------------------------------------------------------
// 4. SWAGGER & ROUTES
// -------------------------------------------------------------
const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "LingoMate API", version: "2.1.0" },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ["./src/routes/*.js"],
});
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/", (req, res) => res.send("LingoMate Backend v2.1 (AI Logic Included) is Running!"));

// -------------------------------------------------------------
// 5. HTTP + WEBSOCKET SERVER SETUP
// -------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Upgrade handler with Auth0 verification
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    jwt.verify(token, getKey, { algorithms: ["RS256"], audience: AUTH0_AUDIENCE, issuer: AUTH0_ISSUER }, 
      async (err, decoded) => {
        if (err) {
          console.log("[WS] Invalid token:", err.message);
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        
        // Retrieve DB user info during handshake for efficiency
        let realUser = await prisma.user.findUnique({ where: { auth0Sub: decoded.sub } });
        
        // Create user if not exists
        if (!realUser) {
            realUser = await prisma.user.create({
                data: { auth0Sub: decoded.sub, username: "NewUser", email: "user@test.com", countryPref: "US", stylePref: "Casual", genderPref: "Female" }
            });
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.user = realUser; // Attach DB user info to socket session
          wss.emit("connection", ws, req);
        });
      }
    );
  } catch (e) {
    console.error("[WS Upgrade Error]", e);
    socket.destroy();
  }
});

// -------------------------------------------------------------
// 6. WEBSOCKET LOGIC (AI Pipeline Integration)
// -------------------------------------------------------------
wss.on("connection", async (ws) => {
  console.log(`[WebSocket] Connected → User: ${ws.user?.username} (ID: ${ws.user?.id})`);

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let conversationId = null; 

  ws.on("message", async (data, isBinary) => {
    try {
      let userPrompt = '';
      
      // 1. Determine if input is Audio or Text
      if (Buffer.isBuffer(data) || isBinary) {
        userPrompt = await transcribeAudio(data); // Transcribe Audio (STT)
        if (!userPrompt?.trim()) return; // Ignore if speech is not detected
        console.log(`[STT] "${userPrompt}"`);
      } else {
        userPrompt = data.toString();
        console.log(`📩 Text: "${userPrompt}"`);
      }
      
      // 2. Create Conversation (if not exists)
      if (!conversationId) {
          const newConv = await prisma.conversation.create({
              data: { userId: ws.user.id, countryUsed: ws.user.countryPref, styleUsed: ws.user.stylePref, genderUsed: ws.user.genderPref }
          });
          conversationId = newConv.id;
      }
      
      // 3. Save User Message to DB
      await prisma.message.create({ data: { conversationId, sender: 'USER', content: userPrompt } });

      // 4. Retrieve Context (Last 10 messages)
      const historyData = await prisma.message.findMany({ where: { conversationId }, take: 10, orderBy: { id: 'desc' } });
      const historyForGemini = historyData.reverse().map(msg => ({ role: msg.sender === 'USER' ? 'user' : 'model', parts: [{ text: msg.content }] }));
      
      // 5. Generate AI Response (Gemini)
      const chat = model.startChat({ history: historyForGemini });
      const result = await chat.sendMessage(userPrompt);
      const aiText = result.response.text();
      console.log(`🤖 AI: ${aiText}`);
      
      // 6. Send Text Response
      ws.send(aiText); 
      await prisma.message.create({ data: { conversationId, sender: 'AI', content: aiText } });

      // 7. Send Audio Response (TTS)
      const audioContent = await synthesizeSpeech(aiText); 
      ws.send(audioContent); 

    } catch (error) { 
        console.error('[Server] Error:', error); 
        ws.send('Server Error'); 
    }
  });

  ws.on("close", () => console.log("[WS] Client disconnected"));
});

// Heartbeat (Keep-Alive)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// API Routes
app.use("/api", apiRoutes(checkJwt, wss));

// -------------------------------------------------------------
// 7. START SERVER
// -------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log(`[DOCS] http://localhost:${PORT}/api-docs`);
});