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

// 3. 라우터 및 서비스 수입
import authRoutes from './routes/auth.routes.js';
import convRoutes from './routes/convRoutes.js';
import apiRoutes from './routes/apiRoutes.js'; // (조원 라우터)
import model from './lib/gemini.js'; // (Gemini AI)
import { transcribeAudio } from './lib/googleSpeech.js'; // (STT)
import { synthesizeSpeech } from './lib/googleTTS.js'; // ★ (NEW) TTS 통역사 추가 ★

const app = express();
const PORT = process.env.PORT || 3000;

// 4. Auth0 설정
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE; 

if (!auth0Domain || !auth0Audience) {
  throw new Error('AUTH0_DOMAIN 또는 AUTH0_AUDIENCE가 .env 파일에 없습니다!');
}

// 5. 경비원 설정
const checkJwt = auth({
  issuerBaseURL: `https://${auth0Domain}`, 
  audience: auth0Audience,               
});

// 6. 미들웨어 설정
app.use(express.json());
app.use(bodyParser.json());

// 7. 라우터 등록
app.get("/", (req, res) => res.send("Hello from Docker!")); 
app.use('/auth', authRoutes); 
app.use('/api/conversations', checkJwt, convRoutes);
app.use('/api', apiRoutes); 

// Swagger 설정
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'LingoMate API 문서',
      version: '1.0.0',
      description: '백엔드 Auth 관련 API 명세서입니다.',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ['./src/routes/*.js'], 
};
const specs = swaggerJSDoc(options);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs)); 

// 보호된 라우트 테스트
app.get('/api/protected', checkJwt, (req, res) => {
  res.json({
    message: '축하합니다! "출입증"이 확인됐습니다!',
    authInfo: req.auth 
  });
});


// --- 8. WebSocket 서버 설정 ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WebSocket] 클라이언트가 연결되었습니다.');

  // ★ 메시지 수신 (텍스트 or 음성) ★
  ws.on('message', async (data, isBinary) => {
    try {
      let userPrompt = '';

      if (isBinary) {
        // 1. 음성 데이터(Binary)가 온 경우 -> STT로 변환
        console.log('[WebSocket] 음성 데이터 수신 (Binary)');
        try {
          userPrompt = await transcribeAudio(data); // 구글 STT 호출
          console.log(`[STT] 변환된 텍스트: "${userPrompt}"`);
          
          if (!userPrompt || userPrompt.trim().length === 0) {
            ws.send('음성을 인식하지 못했습니다.');
            return;
          }
        } catch (sttError) {
          console.error('[STT] 에러:', sttError);
          ws.send('음성 인식(STT) 중 오류가 발생했습니다.');
          return;
        }
      } else {
        // 2. 텍스트 데이터가 온 경우 -> 그대로 사용
        userPrompt = data.toString();
        console.log(`[WebSocket] 텍스트 메시지 수신: "${userPrompt}"`);
      }
      
      // --- 3. Gemini AI 호출 (공통) ---
      const result = await model.generateContent(userPrompt);
      const response = result.response;
      const aiText = response.text();
      // -----------------------------

      console.log(`[Gemini] 응답: ${aiText}`);
      
      // 4. [텍스트 전송] 프론트로 텍스트 답변 먼저 전송
      ws.send(aiText); 

      // 5. [오디오 전송] (NEW) TTS로 변환해서 오디오 전송!
      try {
        console.log('[TTS] 오디오 변환 시작...');
        const audioContent = await synthesizeSpeech(aiText); // 구글 TTS 호출
        console.log(`[TTS] 변환 완료! (${audioContent.length} bytes)`);
        
        // 오디오 데이터 전송 (바이너리)
        ws.send(audioContent); 
        
      } catch (ttsError) {
        console.error('[TTS] 에러:', ttsError);
        // TTS 실패해도 텍스트는 이미 갔으니까 에러 메시지는 생략하거나 로그만 남김
      }
      
    } catch (error) {
      console.error('[Gemini] 에러:', error);
      ws.send('AI 응답 생성에 실패했습니다.');
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] 클라이언트 연결이 끊겼습니다.');
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] 에러 발생:', error);
  });
});


// --- 9. 서버 실행 ---
server.listen(PORT, () => {
  console.log(`[V7] STT + Gemini + TTS 서버가 ${PORT}에서 실행 중입니다!`);
  console.log("AUTH0_DOMAIN (for check):", process.env.AUTH0_DOMAIN);
  console.log(`Swagger Docs: http://localhost:${PORT}/api-docs`);
});