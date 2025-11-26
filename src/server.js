// src/server.js

// 1. .env 파일 로더
import 'dotenv/config';

// 2. 라이브러리 수입
import express from 'express';
import http from 'http'; 
import { WebSocketServer } from 'ws'; 
import { auth } from 'express-oauth2-jwt-bearer'; 
import bodyParser from 'body-parser'; 
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import url from 'url'; // URL 파싱용

// Auth0 검문 도구들
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// 3. 라우터 및 서비스 수입
import authRoutes from './routes/auth.routes.js';
import convRoutes from './routes/convRoutes.js';
import apiRoutes from './routes/apiRoutes.js'; 
import model from './lib/gemini.js'; 
import { transcribeAudio } from './lib/googleSpeech.js'; 
import { synthesizeSpeech } from './lib/googleTTS.js'; 
import prisma from './lib/prisma.js'; 

const app = express();
const PORT = process.env.PORT || 3000;

// 4. Auth0 설정
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE; 

if (!auth0Domain || !auth0Audience) {
  throw new Error('AUTH0_DOMAIN 또는 AUTH0_AUDIENCE가 .env 파일에 없습니다!');
}

// WebSocket용 Auth0 검증 클라이언트 설정
const client = jwksClient({
  jwksUri: `https://${auth0Domain}/.well-known/jwks.json`
});

// 헬퍼 함수: 키 찾기
function getKey(header, callback) {
  client.getSigningKey(header.kid, function(err, key) {
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// 5. HTTP API 경비원 설정 (기존)
const checkJwt = auth({
  issuerBaseURL: `https://${auth0Domain}`, 
  audience: auth0Audience,               
});

// 6. 미들웨어 설정
app.use(express.json());
app.use(bodyParser.json());

// 7. 라우터 등록
app.get("/", (req, res) => res.send("Hello from LingoMate Server!")); 
app.use('/auth', authRoutes); 
app.use('/api/conversations', checkJwt, convRoutes);
app.use('/api', apiRoutes); 

// Swagger 설정
const options = {
  definition: {
    openapi: '3.0.0',
    info: { title: 'LingoMate API', version: '1.0.0' },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ['./src/routes/*.js'], 
};
const specs = swaggerJSDoc(options);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs)); 

// --- 8. WebSocket 서버 설정 ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  console.log('🔵 Client attempting to connect...');

  // --- [Auth0] 토큰 검사 및 유저 판별 ---
  let currentUserId = 1; 
  let currentUser = null;

  try {
    const parameters = url.parse(req.url, true);
    const token = parameters.query.token;

    if (token) {
      console.log('🔒 Token detected. Verifying...');
      const decoded = await new Promise((resolve, reject) => {
        jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
          if (err) return reject(err);
          resolve(decoded);
        });
      });

      const auth0Sub = decoded.sub;
      const realUser = await prisma.user.findUnique({ where: { auth0Sub: auth0Sub } });

      if (realUser) {
        currentUserId = realUser.id;
        currentUser = realUser;
        console.log(`✅ Auth0 Login Success! User: ${realUser.username} (ID: ${realUser.id})`);
      } else {
        console.log(`⚠️ Token valid, but user not found in DB. (Sub: ${auth0Sub})`);
      }
    } else {
      console.log('⚠️ No token provided. Fallback to Test User (ID: 1).');
    }
  } catch (err) {
    console.error('❌ Token Verification Failed:', err.message);
  }

  // 유저가 없으면 테스트 유저(ID 1) 강제 할당
  if (!currentUser) {
      try {
          currentUser = await prisma.user.findUnique({ where: { id: 1 } });
          if (!currentUser) {
            currentUser = await prisma.user.create({
                data: {
                    auth0Sub: "test-auth0-id-123", 
                    username: "TestUser",
                    email: "test@lingomate.com",
                    countryPref: "United States",
                    stylePref: "Casual",
                    genderPref: "Female"
                }
            });
            console.log('🔨 Test User Created.');
          }
          currentUserId = currentUser.id;
      } catch (e) {
          console.error("❌ DB Error:", e);
      }
  }

  let conversationId = null; 

  ws.on('message', async (data, isBinary) => {
    try {
      let userPrompt = '';

      // 1. STT 처리
      if (isBinary) {
        try {
          userPrompt = await transcribeAudio(data); 
          console.log(`[STT] Result: "${userPrompt}"`);
          if (!userPrompt?.trim()) {
             ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' }));
             return;
          }
        } catch (sttError) {
          console.error('[STT] Error:', sttError);
          return;
        }
      } else {
        userPrompt = data.toString();
        console.log(`📩 Text received: "${userPrompt}"`);
      }
      
      // 2. DB 저장 (유저 메시지) & 대화방 확보
      try {
        if (!conversationId) {
            const newConv = await prisma.conversation.create({
                data: {
                    userId: currentUserId,
                    countryUsed: currentUser.countryPref || "United States",
                    styleUsed: currentUser.stylePref || "Casual",
                    genderUsed: currentUser.genderPref || "Female"
                }
            });
            conversationId = newConv.id;
            console.log(`🆕 New Conversation: ID ${conversationId}`);
        }

        await prisma.message.create({
            data: {
                conversationId: conversationId,
                sender: 'USER', 
                content: userPrompt
            }
        });
      } catch (dbErr) {
        console.error('❌ DB Save Error (User):', dbErr);
      }

      // ★ [핵심 변경 V10] AI에게 기억력(History) 주입하기 ★
      let aiText = "";
      try {
          // (1) DB에서 최근 대화 10개 가져오기
          const historyData = await prisma.message.findMany({
              where: { conversationId: conversationId },
              take: 10, // 최근 10개만 기억
              orderBy: { id: 'desc' } // 최신순으로 가져와서
          });

          // (2) Gemini 포맷으로 변환 (과거 -> 현재 순서로 뒤집기)
          // Gemini Role: 'user' = 사용자, 'model' = AI
          const historyForGemini = historyData.reverse().map(msg => ({
              role: msg.sender === 'USER' ? 'user' : 'model',
              parts: [{ text: msg.content }]
          }));

          // (3) 대화 모드(Chat) 시작 (기억력 탑재)
          const chat = model.startChat({
              history: historyForGemini,
          });

          // (4) 메시지 전송
          const result = await chat.sendMessage(userPrompt);
          aiText = result.response.text();
          console.log(`🤖 AI (with Memory): ${aiText}`);

      } catch (aiError) {
          console.error("Gemini Error:", aiError);
          aiText = "Sorry, I am having trouble thinking right now.";
      }

      // 3. 텍스트 전송
      ws.send(aiText); 

      // 4. DB 저장 (AI 답변)
      if (conversationId) {
          await prisma.message.create({
              data: {
                  conversationId: conversationId,
                  sender: 'AI',
                  content: aiText
              }
          });
      }

      // 5. TTS 전송
      try {
        const audioContent = await synthesizeSpeech(aiText); 
        ws.send(audioContent); 
      } catch (ttsError) {
        console.error('[TTS] Error:', ttsError);
      }
      
    } catch (error) {
      console.error('[Server] Error:', error);
      ws.send('Server Error');
    }
  });

  ws.on('close', () => {
    console.log('🔴 Client disconnected');
  });
});

// --- 서버 실행 ---
server.listen(PORT, () => {
  console.log(`[V10] Auth0 + DB + Memory(Context) Server running on ${PORT}`);
});