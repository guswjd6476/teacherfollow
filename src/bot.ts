import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 설정되지 않았습니다.');
}

const bot = new Telegraf(BOT_TOKEN);
const db = new Database('counseling_bot.db');

// DB 테이블 생성
db.exec(`
CREATE TABLE IF NOT EXISTS counseling_chats (
    chat_id TEXT PRIMARY KEY,
    room_title TEXT,
    meeting_date TEXT,
    feedback_submitted INTEGER DEFAULT 0,
    report_submitted INTEGER DEFAULT 0,
    d_minus_1_notified INTEGER DEFAULT 0,
    d_day_22_notified INTEGER DEFAULT 0,
    overdue_1_notified INTEGER DEFAULT 0,
    overdue_2_notified INTEGER DEFAULT 0,
    updated_at TEXT
);
`);

function getChatRecord(chatId: string | number) {
    return db.prepare('SELECT * FROM counseling_chats WHERE chat_id = ?').get(String(chatId)) as any;
}

function upsertMeetingDate(chatId: string | number, title: string, meetingDate: string) {
    const now = dayjs().tz('Asia/Seoul').toISOString();
    const query = `
        INSERT INTO counseling_chats (chat_id, room_title, meeting_date, feedback_submitted, report_submitted, d_minus_1_notified, d_day_22_notified, overdue_1_notified, overdue_2_notified, updated_at)
        VALUES (@chat_id, @room_title, @meeting_date, 0, 0, 0, 0, 0, 0, @updated_at)
        ON CONFLICT(chat_id) DO UPDATE SET
            meeting_date = @meeting_date,
            feedback_submitted = 0,
            report_submitted = 0,
            d_minus_1_notified = 0,
            d_day_22_notified = 0,
            overdue_1_notified = 0,
            overdue_2_notified = 0,
            updated_at = @updated_at;
    `;
    db.prepare(query).run({
        chat_id: String(chatId),
        room_title: title,
        meeting_date: meetingDate,
        updated_at: now,
    });
}

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

// 봇이 방에 추가되었을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
        await ctx.reply(
            '👋 **상담/복음방 일정 관리 봇이 방에 입장했습니다.**\n\n' +
                '첫 만남 일정을 지정해주세요.\n' +
                '명령어: `/만남일 MM-DD` (예: `/만남일 09-24`)',
            { parse_mode: 'Markdown' },
        );
    }
});

// 수동 만남일 지정 커맨드
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
        await ctx.reply('⚠️ 날짜 형식이 올바르지 않습니다. (예: 09-24)');
        return;
    }

    const formatted = target.format('YYYY-MM-DD');
    const title = 'title' in ctx.chat ? ctx.chat.title : '개인대화';
    upsertMeetingDate(ctx.chat.id, title, formatted);

    await ctx.reply(
        `🗓 만남일이 **${formatted}**로 등록되었습니다.\n` +
            `• 전날: 피드백 등록 요청 알림\n` +
            `• 당일 22:00: 보고서 제출 확인 알림`,
        { parse_mode: 'Markdown' },
    );
});

// 일반 메시지 감시 (보고서 또는 피드백)
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const record = getChatRecord(chatId);

    // 1. 만남 보고서 감지
    if (text.includes('상담,복음방 보고서') || text.includes('다음만남일')) {
        const nextDate = parseNextMeetingDate(text);

        if (!nextDate) {
            await ctx.reply(
                '⚠️ 보고서에서 `다음만남일`을 파악하지 못했습니다. `/만남일 MM-DD` 명령어로 직접 설정해주세요.',
            );
            return;
        }

        const title = 'title' in ctx.chat ? ctx.chat.title : '그룹';
        upsertMeetingDate(chatId, title, nextDate);

        await ctx.reply(`✅ **만남 보고서 등록 완료**\n` + `다음 만남일이 **${nextDate}**로 자동 갱신되었습니다.`, {
            parse_mode: 'Markdown',
        });
        return;
    }

    // 2. 피드백 감지
    if (record && !record.feedback_submitted) {
        if (text.startsWith('피드백') || text.includes('[피드백]') || text.includes('▶️ 피드백')) {
            db.prepare('UPDATE counseling_chats SET feedback_submitted = 1 WHERE chat_id = ?').run(String(chatId));
            await ctx.reply('📝 **피드백 내용이 확인되었습니다.**');
        }
    }
});

// 매일 10:00 스케줄러: D-1 피드백 요청 & 지연 독촉
cron.schedule(
    '0 10 * * *',
    async () => {
        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const chats = db.prepare('SELECT * FROM counseling_chats').all() as any[];

        for (const chat of chats) {
            if (!chat.meeting_date) continue;

            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day'); // 오늘 - 만남일

            // D-1 (내일이 만남일)
            if (diffDays === -1 && !chat.d_minus_1_notified) {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🔔 **[D-1 만남 안내]**\n` +
                        `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                        `만남 전 **피드백 내용**을 양식에 맞춰 올려주세요!`,
                );
                db.prepare('UPDATE counseling_chats SET d_minus_1_notified = 1 WHERE chat_id = ?').run(chat.chat_id);
            }

            // D+1 지연 (어제 만남 보고서 미제출)
            if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `⚠️ **[보고서 미제출 안내]**\n` +
                        `어제(${mDate.format('MM/DD')}) 만남 보고서가 아직 제출되지 않았습니다 (1일 경과).\n` +
                        `확인 후 등록해 주세요.`,
                );
                db.prepare('UPDATE counseling_chats SET overdue_1_notified = 1 WHERE chat_id = ?').run(chat.chat_id);
            }

            // D+2 지연 (2일 이상 미제출)
            if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🚨 **[보고서 제출 지연 경고]**\n` +
                        `만남일(${mDate.format('MM/DD')})로부터 2일이 지났습니다.\n` +
                        `만남 보고서는 **2일 이내 필수 작성**이며, 지연 시 누적 처리됩니다!`,
                );
                db.prepare('UPDATE counseling_chats SET overdue_2_notified = 1 WHERE chat_id = ?').run(chat.chat_id);
            }
        }
    },
    { timezone: 'Asia/Seoul' },
);

// 매일 22:00 스케줄러: 당일 보고서 작성 요청
cron.schedule(
    '0 22 * * *',
    async () => {
        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const chats = db.prepare('SELECT * FROM counseling_chats').all() as any[];

        for (const chat of chats) {
            if (!chat.meeting_date || chat.report_submitted) continue;

            const mDate = dayjs(chat.meeting_date).startOf('day');
            if (today.isSame(mDate, 'day') && !chat.d_day_22_notified) {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `📋 **[만남 보고서 등록 안내]**\n` +
                        `오늘 만남 잘 마치셨나요?\n` +
                        `금일 만남에 대한 **상담,복음방 보고서**를 올려주세요!`,
                );
                db.prepare('UPDATE counseling_chats SET d_day_22_notified = 1 WHERE chat_id = ?').run(chat.chat_id);
            }
        }
    },
    { timezone: 'Asia/Seoul' },
);

bot.launch().then(() => {
    console.log('🤖 텔레그램 상담 관리 봇이 정상 실행되었습니다.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
