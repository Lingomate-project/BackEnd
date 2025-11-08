// src/server.js
//To update EC2 server files with local files, use the following command in the terminal with path set to BackEnd directory:
// rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.env' \-e "ssh -i ~/.ssh/LingomateEC2key.pem" \. ubuntu@ec2-16-184-11-218.ap-northeast-2.compute.amazonaws.com:~/app
import express from 'express';
import authRoutes from './routes/auth.routes.js'; // <-라우터 수입
import cors from 'cors'; // CORS 미들웨어 수입
import convRoutes from './routes/convRoutes.js';
import bodyParser from 'body-parser';


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // 모든 도메인에서 오는 요청 허용
app.use(bodyParser.json());

app.use('/api/conversations', convRoutes);

// Postman이 보낸 JSON을 서버가 읽을 수 있게 함
// 이거 없으면 authRoutes에서 req.body가 undefined가 됨
app.use(express.json()); 
app.get("/", (req, res) => res.send("Hello from Docker!"));

// '/auth'로 시작하는 모든 요청을 authRoutes 파일로 보냄
app.use('/auth', authRoutes);

app.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});