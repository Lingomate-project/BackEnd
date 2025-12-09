// controllers/homeController.js
import prisma from '../lib/prisma.js';
import { successResponse } from '../utils/response.js';

export default () => {
  const controller = {};

  controller.getHomeStatus = async (req, res) => {
    const auth0Sub = req.auth?.payload?.sub;

    const user = await prisma.user.findUnique({
      where: { auth0Sub },
      include: { stats: true, subscription: true }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not registered",
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    // today 대화 횟수
    const todayCount = await prisma.conversation.count({
      where: {
        userId: user.id,
        startedAt: { gte: new Date(today) }
      }
    });

    res.json(successResponse({
      todayConversationCount: todayCount,
      subscription: user.subscription?.planName ?? "free",
    }));
  };

  return controller;
};