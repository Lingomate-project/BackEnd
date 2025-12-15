// src/controllers/subscriptionController.js
import axios from 'axios';
import prisma from '../lib/prisma.js'; // ✅ DB 도구 가져오기
import { successResponse, errorResponse } from '../utils/response.js';

export default () => {
  const controller = {};

  // 1. [메뉴판] 구독 옵션 (화면에는 12,900원으로 보이게 설정 😎)
  controller.getOptions = (req, res) => {
    res.json(successResponse({
        basic: { callMinutes: 10, scriptLimit: 3, price: 0 },
        // 👇 화면 표시용: 12,900원
        premium: { callMinutes: '∞', scriptLimit: '∞', price: 12900 }, 
    }));
  };

  // 2. [계산대] 구독 처리 (실제 100원 검증 + DB 프리미엄 변경 🔥)
  controller.subscribe = async (req, res) => {
    const { imp_uid } = req.body; 
    
    // 🔑 로그인한 유저 찾기 (Auth0 ID로 찾음)
    const auth0Sub = req.auth?.payload?.sub;

    console.log(`[결제 검증 요청] User: ${auth0Sub}, imp_uid: ${imp_uid}`);

    if (!auth0Sub) {
        return res.status(401).json(errorResponse('AUTH_ERR', '로그인 정보가 없습니다.', 401));
    }

    // 시연용: imp_uid 없으면 그냥 패스 (테스트 편의성)
    if (!imp_uid) {
         return res.json(successResponse({ plan: 'premium', startedAt: new Date() }));
    }

    try {
      // (1) 포트원 토큰 발급
      const getToken = await axios.post('https://api.iamport.kr/users/getToken', {
        imp_key: "3402707836421207", 
        imp_secret: "5dR1CjWrezZIYXqEdRsA5Y9xQYZtGZXQEzCoAVi698iYyK1nELamLcNI9GZEFSejfAjMozTj4QraETW8"
      });

      const { access_token } = getToken.data.response;

      // (2) 결제 정보 조회
      const getPaymentData = await axios.get(`https://api.iamport.kr/payments/${imp_uid}`, {
        headers: { Authorization: access_token }
      });

      const paymentData = getPaymentData.data.response;
      
      // (3) 검증 (여기서 100원인지 확인! 💰)
      if (paymentData.amount === 100 && paymentData.status === 'paid') {
        console.log("✅ 100원 결제 확인됨! DB 업데이트 시작...");

        // 📅 만료일: 오늘로부터 30일 뒤
        const nextMonth = new Date();
        nextMonth.setDate(nextMonth.getDate() + 30); 

        // 🔥 [DB 트랜잭션] 유저 등급 변경 + 구독 정보 저장 + 결제 내역 저장
        await prisma.$transaction(async (tx) => {
            
            // 1. 유저 찾기
            const user = await tx.user.findUnique({
                where: { auth0Sub: auth0Sub }
            });

            if (!user) throw new Error("DB에서 유저를 찾을 수 없습니다.");

            // 2. 유저 등급(Role)을 PREMIUM으로 변경 (이게 핵심! ⭐)
            await tx.user.update({
                where: { id: user.id },
                data: { role: 'PREMIUM' }
            });

            // 3. 구독 정보(Subscription) 업데이트
            await tx.subscription.upsert({
                where: { userId: user.id },
                update: { 
                    planName: 'premium', 
                    isActive: true, 
                    expiresAt: nextMonth 
                },
                create: { 
                    userId: user.id, 
                    planName: 'premium', 
                    isActive: true, 
                    expiresAt: nextMonth 
                }
            });

            // 4. 결제 내역(Payment) 기록
            await tx.payment.create({
                data: {
                    userId: user.id,
                    amount: paymentData.amount, // 100
                    currency: paymentData.currency,
                    status: paymentData.status,
                    platform: 'PORTONE_KAKAO',
                    purchaseToken: imp_uid,
                    orderId: paymentData.merchant_uid,
                    productId: 'premium_monthly_test'
                }
            });
        });

        console.log("🎉 DB 업데이트 완료! 이제 AI 무제한 사용 가능.");

        return res.json(successResponse({
            status: "success",
            plan: "premium",
            startedAt: new Date(),
            message: "프리미엄 구독이 적용되었습니다."
        }));

      } else {
        console.log("❌ 결제 검증 실패: 100원이 아니거나 결제 안 됨");
        return res.status(400).json(errorResponse('PAYMENT_ERR', '검증 실패', 400));
      }

    } catch (error) {
      console.error("결제 처리 에러:", error.message);
      return res.status(500).json(errorResponse('SERVER_ERR', '서버 에러 발생', 500));
    }
  };

  controller.cancel = (req, res) => {
    res.json(successResponse({ canceledAt: new Date() }));
  };

  return controller;
};