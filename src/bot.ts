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
 * 🔍 텍스트 파싱 유틸리티
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

// 봇이 그룹에 추가되었을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
        await ctx.reply(
            '👋 **상담/복음방 일정 관리 봇이 등록되었습니다.**\n\n' +
                '첫 만남 일정을 지정해주세요.\n' +
                '명령어: `/만남일 MM-DD` (예: `/만남일 09-24` 또는 `만남일 09-24`)',
            { parse_mode: 'Markdown' },
        );
    }
});

// /start 및 /help
bot.hears(/^\/?(start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 **상담/복음방 봇 명령어 안내**\n\n' +
            '• **만남일 설정**: `/만남일 MM-DD` (예: `/만남일 09-24`)\n' +
            '• **현재 방 일정 확인**: `/상태`\n' +
            '• **오늘 전체 만남 명단 조회**: `오늘 만남` 또는 `/오늘만남`\n' +
            '• **피드백 제출**: 내용 앞에 `피드백` 입력\n' +
            '• **보고서 제출**: 기존 양식대로 작성 시 `다음만남일` 자동 감지',
        { parse_mode: 'Markdown' },
    );
});

// 오늘 만남 명단 조회 (/오늘만남, 오늘 만남, 오늘만남)
bot.hears(/^\/?오늘\s*만남(?:@\w+)?$/i, async (ctx) => {
    const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    const allChats = getAllChats();
    const todayChats = allChats.filter((chat) => chat.meeting_date === todayStr);

    if (todayChats.length === 0) {
        await ctx.reply(`🗓 **오늘(${todayStr}) 예정된 만남 일정이 없습니다.**`, { parse_mode: 'Markdown' });
        return;
    }

    let message = `📋 **[오늘 만남 명단] (총 ${todayChats.length}건)**\n`;
    message += `📅 기준일: ${todayStr}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n\n`;

    todayChats.forEach((chat, index) => {
        const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
        const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기 중';

        message += `**${index + 1}. ${chat.room_title || '이름 없는 방'}**\n`;
        message += `   • 사전 피드백: ${feedbackBadge}\n`;
        message += `   • 만남 보고서: ${reportBadge}\n\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// 현재 개별 방 상태 확인 (/상태, 상태)
bot.hears(/^\/?상태(?:@\w+)?$/i, async (ctx) => {
    const record = getChatRecord(ctx.chat.id);
    if (!record || !record.meeting_date) {
        await ctx.reply('⚠️ 현재 등록된 만남 일정이 없습니다.\n`/만남일 MM-DD`로 일정을 등록해주세요.', {
            parse_mode: 'Markdown',
        });
        return;
    }

    const mDate = dayjs(record.meeting_date);
    const feedbackStatus = record.feedback_submitted ? '✅ 제출 완료' : '❌ 미제출';
    const reportStatus = record.report_submitted ? '✅ 제출 완료' : '⏳ 대기 중';

    await ctx.reply(
        `📊 **[현재 방 일정 상태]**\n\n` +
            `• **만남 예정일**: ${mDate.format('YYYY년 MM월 DD일')}\n` +
            `• **피드백 작성**: ${feedbackStatus}\n` +
            `• **만남 보고서**: ${reportStatus}`,
        { parse_mode: 'Markdown' },
    );
});

// 만남일 설정 (/만남일 MM-DD, 만남일 MM-DD)
bot.hears(/^\/?만남일(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply('⚠️ 날짜를 함께 입력해주세요.\n' + '예: `/만남일 09-24` 또는 `만남일 09/24`', {
            parse_mode: 'Markdown',
        });
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
        `🗓 만남일이 **${formatted}**로 등록되었습니다.\n\n` +
            `• **만남 전날 (10:00)**: 피드백 등록 요청 알림\n` +
            `• **만남 당일 (22:00)**: 만남 보고서 등록 알림\n` +
            `• **미제출 시**: 1일/2일 경과 경고 알림`,
        { parse_mode: 'Markdown' },
    );
});

// 일반 텍스트 감지 (보고서 및 피드백 처리)
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    // 명령어 및 키워드는 위 bot.hears에서 이미 처리되었으므로 통과
    if (/^\/?(만남일|상태|start|help|도움말|오늘\s*만남)/i.test(text)) return;

    const record = getChatRecord(chatId);

    // 1. 만남 보고서 감지
    if (text.includes('상담,복음방 보고서') || text.includes('다음만남일')) {
        const nextDate = parseNextMeetingDate(text);
        if (!nextDate) {
            await ctx.reply('⚠️ 보고서에서 `다음만남일`을 파악하지 못했습니다. `/만남일 MM-DD`로 직접 설정해주세요.');
            return;
        }

        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '그룹';
        upsertMeetingDate(chatId, title, nextDate);

        await ctx.reply(
            `✅ **만남 보고서가 정상 반영되었습니다.**\n` + `다음 만남일이 **${nextDate}**로 자동 갱신되었습니다.`,
            { parse_mode: 'Markdown' },
        );
        return;
    }

    // 2. 피드백 감지
    if (text.startsWith('피드백') || text.includes('[피드백]') || text.includes('▶️ 피드백')) {
        updateChat(chatId, { feedback_submitted: 1 });
        await ctx.reply('📝 **피드백 내용이 확인되었습니다.** 감사합니다.');
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
                    `🔔 **[D-1 만남 안내]**\n` +
                        `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                        `만남 전 **피드백 내용**을 양식에 맞춰 작성해 주세요!`,
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
                    `⚠️ **[보고서 미제출 안내]**\n` +
                        `어제(${mDate.format('MM/DD')}) 만남 보고서가 아직 제출되지 않았습니다 (1일 경과).\n` +
                        `확인 후 작성해 주세요.`,
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
                    `🚨 **[보고서 제출 지연 경고]**\n` +
                        `만남일(${mDate.format('MM/DD')})로부터 2일이 경과했습니다.\n` +
                        `만남 보고서는 **2일 이내 필수 제출**이며 지연 시 누적 기록됩니다!`,
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
                    `📋 **[만남 보고서 제출 안내]**\n` +
                        `오늘 만남 잘 마치셨나요?\n` +
                        `금일 만남에 대한 **상담,복음방 보고서**를 등록해 주세요!`,
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
