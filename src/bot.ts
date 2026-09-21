import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.');
    process.exit(1);
}

// 쉼표(,)로 구분된 관리자 Telegram 고유 ID 목록
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

/* =====================================================
 * 💾 영구 파일 데이터베이스 (순수 JSON 저장소)
 * ===================================================== */
interface ChatRecord {
    chat_id: string;
    room_title: string;
    meeting_date: string;
    feedback_submitted: number;
    report_submitted: number;
    d_minus_1_notified: number;
    d_day_22_notified: number;
    overdue_1_notified: number;
    overdue_2_notified: number;
    updated_at: string;
}

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const dbFilePath = path.join(dataDir, 'counseling_chats.json');

function loadChats(): Record<string, ChatRecord> {
    try {
        if (!fs.existsSync(dbFilePath)) return {};
        const raw = fs.readFileSync(dbFilePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function saveChats(chats: Record<string, ChatRecord>) {
    fs.writeFileSync(dbFilePath, JSON.stringify(chats, null, 2), 'utf-8');
}

function getChatRecord(chatId: string | number): ChatRecord | undefined {
    const chats = loadChats();
    return chats[String(chatId)];
}

function getAllChats(): ChatRecord[] {
    const chats = loadChats();
    return Object.values(chats);
}

function upsertMeetingDate(chatId: string | number, title: string, meetingDate: string) {
    const chats = loadChats();
    const id = String(chatId);
    const now = dayjs().tz('Asia/Seoul').toISOString();

    chats[id] = {
        chat_id: id,
        room_title: title,
        meeting_date: meetingDate,
        feedback_submitted: 0,
        report_submitted: 0,
        d_minus_1_notified: 0,
        d_day_22_notified: 0,
        overdue_1_notified: 0,
        overdue_2_notified: 0,
        updated_at: now,
    };
    saveChats(chats);
}

function updateChat(chatId: string | number, patch: Partial<ChatRecord>) {
    const chats = loadChats();
    const id = String(chatId);
    if (chats[id]) {
        chats[id] = {
            ...chats[id],
            ...patch,
            updated_at: dayjs().tz('Asia/Seoul').toISOString(),
        };
        saveChats(chats);
    }
}

/* =====================================================
 * 🔍 날짜 파싱 유틸리티
 * ===================================================== */
function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    const now = dayjs().tz('Asia/Seoul');

    // 1) YYYY-MM-DD
    const fullMatch = rawText.match(/(\d{4})[\-\/\.\s]+(\d{1,2})[\-\/\.\s]+(\d{1,2})/);
    if (fullMatch) {
        const d = dayjs(`${fullMatch[1]}-${fullMatch[2].padStart(2, '0')}-${fullMatch[3].padStart(2, '0')}`);
        return d.isValid() ? d.format('YYYY-MM-DD') : null;
    }

    // 2) MM-DD, MM/DD, MM.DD, M월 D일
    const match = rawText.match(/(\d{1,2})[\-\/\.\월\s]+(\d{1,2})/);
    if (match) {
        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        let year = now.year();

        if (now.month() === 11 && month === 1) {
            year += 1;
        }

        const d = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        return d.isValid() ? d.format('YYYY-MM-DD') : null;
    }

    return null;
}

function parseNextMeetingDate(text: string): string | null {
    const targetSection = text.split(/다음만남일/i)[1];
    if (!targetSection) return null;
    return parseFlexibleDate(targetSection);
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

// 예외 로깅
bot.catch((err: any, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
});

// 봇이 그룹에 추가되었을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
        await ctx.reply(
            '👋 <b>상담/복음방 일정 관리 봇이 등록되었습니다.</b>\n\n' +
                '첫 만남 일정을 지정해주세요.\n' +
                '명령어: <code>/만남일 MM-DD</code> (예: <code>/만남일 09-24</code> 또는 <code>만남일 09-24</code>)',
            { parse_mode: 'HTML' },
        );
    }
});

// 도움말 (/start, /help, 도움말)
bot.hears(/^\/?(start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>상담/복음방 봇 안내</b>\n\n' +
            '• <b>만남일 설정</b>: <code>/만남일 MM-DD</code> (예: <code>/만남일 09-24</code>)\n' +
            '• <b>현재 방 일정 확인</b>: <code>/상태</code>\n' +
            '• <b>오늘 전체 만남 명단</b>: <code>오늘 만남</code> (관리자 전용)\n' +
            '• <b>피드백 제출</b>: 내용 앞에 <code>피드백</code> 포함 작성\n' +
            '• <b>보고서 제출</b>: 기존 양식대로 올리면 <code>다음만남일</code> 자동 반영',
        { parse_mode: 'HTML' },
    );
});

// 오늘 만남 명단 조회 (/오늘만남, 오늘 만남 - 관리자 전용)
bot.hears(/^\/?오늘\s*만남(?:\s*|@\w+.*)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        console.log(`[명령어 호출: 오늘 만남] 요청자 ID: ${userId}`);

        // 관리자 ID 검증
        if (ADMIN_IDS.length === 0 || !ADMIN_IDS.includes(userId)) {
            await ctx.reply(
                `⛔ <b>접근 권한이 없습니다.</b>\n` +
                    `이 명령어는 등록된 관리자만 사용할 수 있습니다.\n\n` +
                    `• 내 텔레그램 ID: <code>${userId}</code>\n` +
                    `<i>(서버 .env 파일의 ADMIN_IDS에 위 번호를 추가해주세요.)</i>`,
                { parse_mode: 'HTML' },
            );
            return;
        }

        const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
        const allChats = getAllChats();
        const todayChats = allChats.filter((chat) => chat.meeting_date === todayStr);

        if (todayChats.length === 0) {
            await ctx.reply(`🗓 <b>오늘(${todayStr}) 예정된 만남 일정이 없습니다.</b>`, { parse_mode: 'HTML' });
            return;
        }

        let message = `📋 <b>[오늘 만남 명단] (총 ${todayChats.length}건)</b>\n`;
        message += `📅 기준일: ${todayStr}\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;

        todayChats.forEach((chat, index) => {
            const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
            const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기 중';

            message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
            message += `   • 사전 피드백: ${feedbackBadge}\n`;
            message += `   • 만남 보고서: ${reportBadge}\n\n`;
        });

        await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[오늘 만남 에러]:', err);
    }
});

// 개별 방 상태 확인 (/상태, 상태)
bot.hears(/^\/?상태(?:@\w+)?$/i, async (ctx) => {
    const record = getChatRecord(ctx.chat.id);
    if (!record || !record.meeting_date) {
        await ctx.reply('⚠️ 현재 등록된 만남 일정이 없습니다.\n<code>/만남일 MM-DD</code>로 일정을 등록해주세요.', {
            parse_mode: 'HTML',
        });
        return;
    }

    const mDate = dayjs(record.meeting_date);
    const feedbackStatus = record.feedback_submitted ? '✅ 제출 완료' : '❌ 미제출';
    const reportStatus = record.report_submitted ? '✅ 제출 완료' : '⏳ 대기 중';

    await ctx.reply(
        `📊 <b>[현재 방 일정 상태]</b>\n\n` +
            `• <b>만남 예정일</b>: ${mDate.format('YYYY년 MM월 DD일')}\n` +
            `• <b>피드백 작성</b>: ${feedbackStatus}\n` +
            `• <b>만남 보고서</b>: ${reportStatus}`,
        { parse_mode: 'HTML' },
    );
});

// 만남일 설정 (/만남일 MM-DD, 만남일 MM-DD)
bot.hears(/^\/?만남일(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️ 날짜를 함께 입력해주세요.\n' + '예: <code>/만남일 09-24</code> 또는 <code>만남일 09/24</code>',
            { parse_mode: 'HTML' },
        );
        return;
    }

    const formatted = parseFlexibleDate(rawInput);
    if (!formatted) {
        await ctx.reply('⚠️ 올바른 날짜 형식이 아닙니다. (예: 09-24, 9/24, 2026-09-24)');
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    upsertMeetingDate(ctx.chat.id, title, formatted);

    await ctx.reply(
        `🗓 만남일이 <b>${formatted}</b>로 등록되었습니다.\n\n` +
            `• <b>만남 전날 (10:00)</b>: 피드백 등록 요청 알림\n` +
            `• <b>만남 당일 (22:00)</b>: 만남 보고서 등록 알림\n` +
            `• <b>미제출 시</b>: 1일/2일 경과 경고 알림`,
        { parse_mode: 'HTML' },
    );
});

// 일반 텍스트 수신 (보고서 및 피드백 처리)
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    if (/^\/?(만남일|상태|start|help|도움말|오늘\s*만남)/i.test(text)) return;

    const record = getChatRecord(chatId);

    // 1. 만남 보고서 감지
    if (text.includes('상담,복음방 보고서') || text.includes('다음만남일')) {
        const nextDate = parseNextMeetingDate(text);
        if (!nextDate) {
            await ctx.reply(
                '⚠️ 보고서에서 <code>다음만남일</code>을 파악하지 못했습니다. <code>/만남일 MM-DD</code>로 직접 설정해주세요.',
                { parse_mode: 'HTML' },
            );
            return;
        }

        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '그룹';
        upsertMeetingDate(chatId, title, nextDate);

        await ctx.reply(
            `✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n` +
                `다음 만남일이 <b>${nextDate}</b>로 자동 갱신되었습니다.`,
            { parse_mode: 'HTML' },
        );
        return;
    }

    // 2. 피드백 감지
    if (text.startsWith('피드백') || text.includes('[피드백]') || text.includes('▶️ 피드백')) {
        updateChat(chatId, { feedback_submitted: 1 });
        await ctx.reply('📝 <b>피드백 내용이 확인되었습니다.</b> 감사합니다.', { parse_mode: 'HTML' });
    }
});

/* =====================================================
 * ⏰ 스케줄러 트리거 함수들
 * ===================================================== */
async function triggerMorningReminder() {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const chats = getAllChats();

    for (const chat of chats) {
        if (!chat.meeting_date) continue;
        const mDate = dayjs(chat.meeting_date).startOf('day');
        const diffDays = today.diff(mDate, 'day');

        if (diffDays === -1 && !chat.d_minus_1_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🔔 <b>[D-1 만남 안내]</b>\n` +
                        `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                        `만남 전 <b>피드백 내용</b>을 양식에 맞춰 작성해 주세요!`,
                    { parse_mode: 'HTML' },
                );
                updateChat(chat.chat_id, { d_minus_1_notified: 1 });
            } catch (err: any) {
                console.error(`[오전 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `⚠️ <b>[보고서 미제출 안내]</b>\n` +
                        `어제(${mDate.format('MM/DD')}) 만남 보고서가 아직 제출되지 않았습니다 (1일 경과).\n` +
                        `확인 후 작성해 주세요.`,
                    { parse_mode: 'HTML' },
                );
                updateChat(chat.chat_id, { overdue_1_notified: 1 });
            } catch (err: any) {
                console.error(`[D+1 지연 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🚨 <b>[보고서 제출 지연 경고]</b>\n` +
                        `만남일(${mDate.format('MM/DD')})로부터 2일이 경과했습니다.\n` +
                        `만남 보고서는 <b>2일 이내 필수 제출</b>이며 지연 시 누적 기록됩니다!`,
                    { parse_mode: 'HTML' },
                );
                updateChat(chat.chat_id, { overdue_2_notified: 1 });
            } catch (err: any) {
                console.error(`[D+2 경고 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }
    }
}

async function triggerNightReminder() {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const chats = getAllChats();

    for (const chat of chats) {
        if (!chat.meeting_date || chat.report_submitted) continue;
        const mDate = dayjs(chat.meeting_date).startOf('day');

        if (today.isSame(mDate, 'day') && !chat.d_day_22_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `📋 <b>[만남 보고서 제출 안내]</b>\n` +
                        `오늘 만남 잘 마치셨나요?\n` +
                        `금일 만남에 대한 <b>상담,복음방 보고서</b>를 등록해 주세요!`,
                    { parse_mode: 'HTML' },
                );
                updateChat(chat.chat_id, { d_day_22_notified: 1 });
            } catch (err: any) {
                console.error(`[22시 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }
    }
}

/* =====================================================
 * 🌐 HTTP 웹훅 서버 구동
 * ===================================================== */
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/webhook') {
        return bot.webhookCallback('/webhook')(req, res);
    }

    if (url.pathname === '/cron-10am') {
        await triggerMorningReminder();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Morning reminder executed');
    }

    if (url.pathname === '/cron-10pm') {
        await triggerNightReminder();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Night reminder executed');
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Counseling Bot Server is running OK');
});

const PORT = Number(process.env.PORT) || 8300;

server.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    const webhookUrl = 'https://teacherfollow.alwaysdata.net/webhook';
    try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Telegram Webhook 등록 완료: ${webhookUrl}`);
    } catch (e: any) {
        console.error('Webhook 등록 에러:', e.message);
    }
});
