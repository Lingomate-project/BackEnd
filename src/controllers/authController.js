import prisma from '../lib/prisma.js';
import { successResponse, errorResponse } from '../utils/response.js';

export default () => {
    const controller = {};

    // GET /api/auth/me
    controller.getMe = async (req, res) => {

        const auth0Sub = req.auth?.payload?.sub;
        const { name, nickname, email, picture } = req.auth?.payload || {};

        try {
            // 존재하지 않으면 자동 생성하여 404를 방지
            const user = await prisma.user.upsert({
                where: { auth0Sub },
                update: {},
                create: {
                    auth0Sub,
                    username: name || nickname || "User",
                    email,
                    avatarUrl: picture,
                    stats: { create: { totalSentences: 0, studyStreak: 0 } },
                    subscription: { create: { planName: "free", isActive: true } }
                },
                include: { subscription: true }
            });

            res.json(successResponse({
                auth0Id: auth0Sub,
                userId: user.id,
                email: user.email,
                name: user.username,
                subscription: user.subscription?.planName || 'free'
            }));

        } catch (err) {
            res.status(500).json(errorResponse("DB_ERR", err.message));
        }
    };


    // POST /api/auth/register-if-needed
    controller.syncUser = async (req, res) => {
        const auth0Sub = req.auth?.payload?.sub;
        const { username, email, avatarUrl } = req.body;

        try {
            // 1. Check if user exists
            let user = await prisma.user.findUnique({
                where: { auth0Sub },   // <── MUST MATCH PRISMA FIELD
                include: { stats: true, subscription: true }
            });

            if (user) {
                return res.json(successResponse(user, "Login successful"));
            }

            // 2. Create new user
            user = await prisma.user.create({
                data: {
                    auth0Sub,             // <── Insert using correct field
                    username: username || "User",
                    email,
                    avatarUrl,
                    stats: { create: { totalSentences: 0, studyStreak: 0 } },
                    subscription: { create: { planName: "free", isActive: true } }
                },
                include: { stats: true, subscription: true }
            });

            res.status(201).json(successResponse(user, "User registered successfully"));

        } catch (err) {
            res.status(500).json(errorResponse("DB_ERR", err.message));
        }
    };

    return controller;
};
