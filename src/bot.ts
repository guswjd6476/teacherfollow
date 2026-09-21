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

/* =====================================================
 * 💾 영구 파일 데이터베이스 (C++ 바인딩 없는 순수 JSON 저장소)
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
 * 🔍 보고서 파싱 및 봇 로직
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

function parseNextMeetingDate(text: string): string | null {
    const targetSection = text.split(/다음만남일/i)[1];
    if (!targetSection) return null;

    const match = targetSection.match(/(\d{1,2})[\/\.\월\s]+(\d{1,2})/);
    if (!match) return null;

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const now = dayjs().tz('Asia/Seoul');

    let year = now.year();
    if (now.month() === 11 && month === 1) year += 1;

    const parsed = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
}

bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
        await ctx.reply(
            '👋 **상담/복음방 일정 관리 봇이 등록되었습니다.**\n\n' +
                '첫 만남 일정을 지정해주세요.\n' +
                '명령어: `/만남일 MM-DD` (예: `/만남일 09-24`)',
            { parse_mode: 'Markdown' },
        );
    }
});

bot.command('만남일', async (ctx) => {
    const rawDate = ctx.message.text.split(' ')[1]?.trim();
    if (!rawDate) {
        await ctx.reply('⚠️ 날짜를 입력해주세요.\n예: `/만남일 09-24` 또는 `/만남일 2026-09-24`');
        return;
    }

    const now = dayjs().tz('Asia/Seoul');
    const normalized = rawDate.includes('-') && rawDate.length === 5 ? `${now.year()}-${rawDate}` : rawDate;
    const target = dayjs(normalized);

    if (!target.isValid()) {
        await ctx.reply('⚠️ 올바른 날짜 형식이 아닙니다. (예: 09-24)');
        return;
    }

    const formatted = target.format('YYYY-MM-DD');
    const title = 'title' in ctx.chat ? ctx.chat.title : '대화방';
    upsertMeetingDate(ctx.chat.id, title, formatted);

    await ctx.reply(
        `🗓 만남일이 **${formatted}**로 등록되었습니다.\n` +
            `• 만남 전날: 피드백 등록 요청 알림\n` +
            `• 만남 당일 22:00: 보고서 제출 점검 알림`,
        { parse_mode: 'Markdown' },
    );
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const record = getChatRecord(chatId);

    if (text.includes('상담,복음방 보고서') || text.includes('다음만남일')) {
        const nextDate = parseNextMeetingDate(text);
        if (!nextDate) {
            await ctx.reply('⚠️ 보고서에서 `다음만남일`을 읽지 못했습니다. `/만남일 MM-DD`로 수동 지정해주세요.');
            return;
        }

        const title = 'title' in ctx.chat ? ctx.chat.title : '그룹';
        upsertMeetingDate(chatId, title, nextDate);

        await ctx.reply(
            `✅ **만남 보고서가 정상 반영되었습니다.**\n` +
                `다음 만남일: **${nextDate}** (스케줄이 자동 갱신되었습니다.)`,
            { parse_mode: 'Markdown' },
        );
        return;
    }

    if (record && !record.feedback_submitted) {
        if (text.startsWith('피드백') || text.includes('[피드백]') || text.includes('▶️ 피드백')) {
            updateChat(chatId, { feedback_submitted: 1 });
            await ctx.reply('📝 **피드백 내용이 확인되었습니다.**');
        }
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
            await bot.telegram.sendMessage(
                chat.chat_id,
                `🔔 **[D-1 만남 안내]**\n` +
                    `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                    `만남 전 **피드백 내용**을 양식에 맞춰 작성해 주세요!`,
            );
            updateChat(chat.chat_id, { d_minus_1_notified: 1 });
        }

        if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
            await bot.telegram.sendMessage(
                chat.chat_id,
                `⚠️ **[보고서 미제출 안내]**\n` +
                    `어제(${mDate.format('MM/DD')}) 만남 보고서가 아직 제출되지 않았습니다 (1일 경과).\n` +
                    `확인 후 작성해 주세요.`,
            );
            updateChat(chat.chat_id, { overdue_1_notified: 1 });
        }

        if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
            await bot.telegram.sendMessage(
                chat.chat_id,
                `🚨 **[보고서 제출 지연 경고]**\n` +
                    `만남일(${mDate.format('MM/DD')})로부터 2일이 경과했습니다.\n` +
                    `만남 보고서는 **2일 이내 필수 제출**이며 지연 시 누적 기록됩니다!`,
            );
            updateChat(chat.chat_id, { overdue_2_notified: 1 });
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
            await bot.telegram.sendMessage(
                chat.chat_id,
                `📋 **[만남 보고서 제출 안내]**\n` +
                    `오늘 만남 잘 마치셨나요?\n` +
                    `금일 만남에 대한 **상담,복음방 보고서**를 등록해 주세요!`,
            );
            updateChat(chat.chat_id, { d_day_22_notified: 1 });
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
