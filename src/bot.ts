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

function isAdmin(userId?: number | string): boolean {
    if (!userId) return false;
    return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(String(userId));
}

/* =====================================================
 * 💾 영구 파일 데이터베이스 (순수 JSON 저장소)
 * ===================================================== */
interface ChatRecord {
    chat_id: string;
    room_title: string;
    meeting_date: string; // 'YYYY-MM-DD' 또는 '미정' 또는 ''
    feedback_submitted: number;
    report_submitted: number;
    d_minus_1_notified: number;
    d_day_22_notified: number;
    overdue_1_notified: number;
    overdue_2_notified: number;
    created_at: string;
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

// 방이 초대되거나 텍스트가 들어왔을 때 DB에 없으면 생성 일시와 함께 초기 기록
function ensureChatRecord(chatId: string | number, title: string) {
    const chats = loadChats();
    const id = String(chatId);
    let changed = false;
    const now = dayjs().tz('Asia/Seoul').toISOString();

    if (!chats[id]) {
        chats[id] = {
            chat_id: id,
            room_title: title || '대화방',
            meeting_date: '',
            feedback_submitted: 0,
            report_submitted: 0,
            d_minus_1_notified: 0,
            d_day_22_notified: 0,
            overdue_1_notified: 0,
            overdue_2_notified: 0,
            created_at: now,
            updated_at: now,
        };
        changed = true;
    } else {
        if (!chats[id].created_at) {
            chats[id].created_at = chats[id].updated_at || now;
            changed = true;
        }
        if (title && chats[id].room_title !== title) {
            chats[id].room_title = title;
            changed = true;
        }
    }

    if (changed) {
        saveChats(chats);
    }
}

function upsertMeetingDate(chatId: string | number, title: string, meetingDate: string) {
    const chats = loadChats();
    const id = String(chatId);
    const now = dayjs().tz('Asia/Seoul').toISOString();
    const existing = chats[id];

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
        created_at: existing?.created_at || now,
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

function extractNextMeetingRaw(text: string): string | null {
    const match = text.match(/다음\s*(?:만남일|만남\s*일|만남|일정)\s*[:：\-]?\s*([^\n\r]+)/i);
    return match && match[1] ? match[1].trim() : null;
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err: any, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
});

// 봇이 그룹에 추가되거나 퇴장당했을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id;

    if (status === 'member' || status === 'administrator') {
        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
        ensureChatRecord(chatId, title);

        await ctx.reply(
            '👋 <b>상담/복음방 일정 관리 봇이 등록되었습니다.</b>\n\n' +
                '첫 만남 일정을 지정해주세요.\n' +
                '명령어: <code>/만남일 MM-DD</code> (예: <code>/만남일 09-24</code> 또는 일정이 정해지지 않은 경우 <code>/만남일 미정</code>)',
            { parse_mode: 'HTML' }
        );
    } else if (status === 'left' || status === 'kicked') {
        const chats = loadChats();
        if (chats[String(chatId)]) {
            delete chats[String(chatId)];
            saveChats(chats);
        }
    }
});

// 도움말 (/start, /help, 도움말)
bot.hears(/^\/?(start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>상담/복음방 봇 안내</b>\n\n' +
            '• <b>만남일 설정</b>: <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>\n' +
            '• <b>현재 방 일정 확인</b>: <code>/상태</code>\n\n' +
            '👑 <b>관리자 전용 명령어:</b>\n' +
            '• <b>만남 명단</b>: <code>관리자 오늘만남</code>, <code>관리자 내일만남</code>, <code>관리자 일자만남 MM-DD</code>\n' +
            '• <b>보고서 미제출</b>: <code>관리자 미제출</code>\n' +
            '• <b>미등록 및 미정 방 조회</b>: <code>관리자 미등록</code> (또는 <code>관리자 미정</code>)\n' +
            '• <b>만남일 경과 미갱신 방</b>: <code>관리자 미갱신</code>\n' +
            '• <b>전체 종합 현황</b>: <code>관리자 점검</code>\n\n' +
            '• <b>피드백 제출</b>: 메시지 내 <code>#피드백</code> 또는 <code>#피드백내용</code> 포함 작성\n' +
            '• <b>보고서 제출</b>: 양식 내 <code>다음만남일: MM-DD</code> (또는 <code>다음만남일: 미정</code>) 포함 작성',
        { parse_mode: 'HTML' }
    );
});

// 1. 날짜별 만남 조회 (관리자 전용)
bot.hears(
    /^(?:\/?관리자(?:\s+(?!(?:미제출|미등록|미정|미갱신|최초미등록|점검|현황))(.+))?|\/(?:만남명단|만남일정)(?:@\w+)?(?:\s+(.+))?)$/i,
    async (ctx) => {
        try {
            const userId = String(ctx.from?.id);
            if (!isAdmin(userId)) {
                await ctx.reply(
                    `⛔ <b>접근 권한이 없습니다.</b>\n관리자만 사용할 수 있습니다.\n\n• 내 ID: <code>${userId}</code>`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            const input = (ctx.match[1] || ctx.match[2] || '').trim();
            const cleanCmd = input.replace(/\s+/g, '');
            let targetDateStr: string | null = null;

            if (!cleanCmd || cleanCmd === '오늘' || cleanCmd === '오늘만남') {
                targetDateStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
            } else if (cleanCmd === '내일' || cleanCmd === '내일만남') {
                targetDateStr = dayjs().tz('Asia/Seoul').add(1, 'day').format('YYYY-MM-DD');
            } else {
                const dateOnlyText = input
                    .replace(/^(?:일자\s*만남|날짜\s*만남|만남\s*명단|만남|일자|일정)\s*/i, '')
                    .trim();
                targetDateStr = parseFlexibleDate(dateOnlyText || input);

                if (!targetDateStr) {
                    await ctx.reply(
                        '⚠️ 형식을 인식할 수 없습니다.\n\n' +
                            '<b>사용 가능 명령어:</b>\n' +
                            '• <code>관리자 오늘만남</code> (또는 <code>관리자 오늘</code>)\n' +
                            '• <code>관리자 내일만남</code> (또는 <code>관리자 내일</code>)\n' +
                            '• <code>관리자 일자만남 09-25</code> (또는 <code>관리자 09-25</code>)',
                        { parse_mode: 'HTML' }
                    );
                    return;
                }
            }

            const allChats = getAllChats();
            const targetChats = allChats.filter((chat) => chat.meeting_date === targetDateStr);

            if (targetChats.length === 0) {
                await ctx.reply(`🗓 <b>[${targetDateStr}] 예정된 만남 일정이 없습니다.</b>`, { parse_mode: 'HTML' });
                return;
            }

            let message = `📋 <b>[만남 일정 명단] (총 ${targetChats.length}건)</b>\n`;
            message += `📅 기준일: <b>${targetDateStr}</b>\n`;
            message += `━━━━━━━━━━━━━━━━━━\n\n`;

            targetChats.forEach((chat, index) => {
                const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
                const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기 중';

                message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
                message += `   • 사전 피드백: ${feedbackBadge}\n`;
                message += `   • 만남 보고서: ${reportBadge}\n\n`;
            });

            await ctx.reply(message, { parse_mode: 'HTML' });
        } catch (err: any) {
            console.error('[만남 명단 조회 에러]:', err);
        }
    }
);

// 2. 만남 보고서 미제출 명단 조회 (관리자 전용)
bot.hears(/^(?:\/?관리자\s*)?(미제출\s*명단|미제출|보고서\s*미제출)(?:@\w+)?$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply(
                `⛔ <b>접근 권한이 없습니다.</b>\n관리자만 사용할 수 있습니다.\n\n• 내 ID: <code>${userId}</code>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = getAllChats();

        const overdueChats = allChats
            .filter((chat) => {
                if (!chat.meeting_date || chat.meeting_date === '미정' || chat.report_submitted) return false;
                const mDate = dayjs(chat.meeting_date).startOf('day');
                return mDate.isBefore(today) || mDate.isSame(today, 'day');
            })
            .sort((a, b) => dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf());

        if (overdueChats.length === 0) {
            await ctx.reply('🎉 <b>현재 미제출된 만남 보고서가 없습니다!</b>', { parse_mode: 'HTML' });
            return;
        }

        let message = `🚨 <b>[보고서 미제출 명단] (총 ${overdueChats.length}건)</b>\n`;
        message += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;

        overdueChats.forEach((chat, index) => {
            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day');

            let delayBadge = '';
            if (diffDays === 0) {
                delayBadge = '⏳ <b>오늘 만남 (당일 제출 대기)</b>';
            } else if (diffDays === 1) {
                delayBadge = '⚠️ <b>1일 지연 (어제 만남)</b>';
            } else {
                delayBadge = `🚨 <b>${diffDays}일 경과 (경고 누적 대상)</b>`;
            }

            message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
            message += `   • 만남일: ${mDate.format('YYYY-MM-DD')}\n`;
            message += `   • 상태: ${delayBadge}\n\n`;
        });

        await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[미제출 명단 조회 에러]:', err);
    }
});

// 3. 봇 초대 후 미등록 방 및 만남일 미정 방 명단 조회 (관리자 전용: 관리자 미등록, 관리자 미정)
bot.hears(
    /^(?:\/?관리자\s*)?(최초\s*미등록|미등록\s*명단|미등록|신규\s*미등록|미정|미정\s*만남|미정\s*명단)(?:@\w+)?$/i,
    async (ctx) => {
        try {
            const userId = String(ctx.from?.id);
            if (!isAdmin(userId)) {
                await ctx.reply(
                    `⛔ <b>접근 권한이 없습니다.</b>\n관리자만 사용할 수 있습니다.\n\n• 내 ID: <code>${userId}</code>`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            const today = dayjs().tz('Asia/Seoul').startOf('day');
            const allChats = getAllChats();

            // 1) 봇 추가 후 만남일이 한 번도 등록되지 않은 방
            const unassignedChats = allChats
                .filter((chat) => !chat.meeting_date || chat.meeting_date.trim() === '')
                .sort((a, b) => dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf());

            // 2) 만남일이 '미정'으로 설정된 방
            const undecidedChats = allChats
                .filter((chat) => chat.meeting_date === '미정')
                .sort((a, b) => dayjs(b.updated_at).valueOf() - dayjs(a.updated_at).valueOf());

            const totalCount = unassignedChats.length + undecidedChats.length;

            if (totalCount === 0) {
                await ctx.reply('🎉 <b>미등록 또는 일정이 미정인 대화방이 없습니다!</b>', { parse_mode: 'HTML' });
                return;
            }

            let message = `📋 <b>[만남일 미등록 및 미정 대화방] (총 ${totalCount}건)</b>\n`;
            message += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
            message += `━━━━━━━━━━━━━━━━━━\n\n`;

            // A. 만남일정 미정 상태 방
            if (undecidedChats.length > 0) {
                message += `⏳ <b>[만남 예정일 미정 상태] (${undecidedChats.length}건)</b>\n`;
                undecidedChats.forEach((chat, index) => {
                    const updated = chat.updated_at
                        ? dayjs(chat.updated_at).tz('Asia/Seoul').format('MM/DD HH:mm')
                        : '-';
                    const reportBadge = chat.report_submitted ? '✅ 보고서 완료' : '⏳ 보고서 대기';

                    message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
                    message += `   • 상태: <b>만남일 미정 (일정 확정 필요)</b>\n`;
                    message += `   • 최근 변경: ${updated} (${reportBadge})\n`;
                    message += `   • Chat ID: <code>${chat.chat_id}</code>\n\n`;
                });
            }

            // B. 봇 초대 후 한 번도 일정을 등록하지 않은 방
            if (unassignedChats.length > 0) {
                message += `❓ <b>[초대 후 첫 만남일 미등록] (${unassignedChats.length}건)</b>\n`;
                unassignedChats.forEach((chat, index) => {
                    const created = chat.created_at ? dayjs(chat.created_at).tz('Asia/Seoul') : null;
                    let durationStr = '확인 불가';

                    if (created) {
                        const diffDays = today.diff(created.startOf('day'), 'day');
                        durationStr = diffDays === 0 ? '오늘 초대됨' : `${diffDays}일째 미등록`;
                    }

                    message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
                    message += `   • 봇 초대일: ${
                        created ? created.format('YYYY-MM-DD') : '기록 없음'
                    } (${durationStr})\n`;
                    message += `   • Chat ID: <code>${chat.chat_id}</code>\n\n`;
                });
            }

            message += `💡 해당 대화방에서 <code>/만남일 MM-DD</code>를 입력하여 확정된 일정을 등록해주세요.`;
            await ctx.reply(message, { parse_mode: 'HTML' });
        } catch (err: any) {
            console.error('[미등록/미정 명단 조회 에러]:', err);
        }
    }
);

// 4. 만남일 경과 후 미갱신 방 명단 (관리자 전용)
bot.hears(/^(?:\/?관리자\s*)?(미갱신\s*명단|미갱신|일정\s*미갱신)(?:@\w+)?$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply(
                `⛔ <b>접근 권한이 없습니다.</b>\n관리자만 사용할 수 있습니다.\n\n• 내 ID: <code>${userId}</code>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = getAllChats();

        // 만남일이 과거 날짜인데 다음 일정이 설정되지 않은 방 ('미정' 제외)
        const expiredChats = allChats
            .filter((chat) => {
                if (!chat.meeting_date || chat.meeting_date.trim() === '' || chat.meeting_date === '미정') return false;
                const mDate = dayjs(chat.meeting_date).startOf('day');
                return mDate.isBefore(today);
            })
            .sort((a, b) => dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf());

        if (expiredChats.length === 0) {
            await ctx.reply('🎉 <b>일정이 만료되어 갱신되지 않은 대화방이 없습니다!</b>', { parse_mode: 'HTML' });
            return;
        }

        let message = `⌛ <b>[만남일 경과 후 미갱신 대화방] (총 ${expiredChats.length}건)</b>\n`;
        message += `<i>(이전 만남일이 지났으나 다음 일정이 설정되지 않음)</i>\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;

        expiredChats.forEach((chat, index) => {
            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day');
            const reportBadge = chat.report_submitted ? '✅ 보고서 제출됨' : '❌ 보고서 미제출';

            message += `<b>${index + 1}. ${chat.room_title || '대화방'}</b>\n`;
            message += `   • 지난 만남일: ${mDate.format('YYYY-MM-DD')} (${diffDays}일 경과)\n`;
            message += `   • 보고서 상태: ${reportBadge}\n\n`;
        });

        await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[미갱신 명단 조회 에러]:', err);
    }
});

// 5. 전체 종합 점검 (관리자 전용)
bot.hears(/^(?:\/?관리자\s*)?(점검|현황|종합\s*점검|전체\s*점검)(?:@\w+)?$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply(
                `⛔ <b>접근 권한이 없습니다.</b>\n관리자만 사용할 수 있습니다.\n\n• 내 ID: <code>${userId}</code>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = getAllChats();

        const unassigned = allChats.filter((c) => !c.meeting_date || c.meeting_date.trim() === '');
        const undecided = allChats.filter((c) => c.meeting_date === '미정');
        const overdue = allChats.filter((c) => {
            if (!c.meeting_date || c.meeting_date === '미정' || c.report_submitted) return false;
            return (
                dayjs(c.meeting_date).startOf('day').isBefore(today) ||
                dayjs(c.meeting_date).startOf('day').isSame(today, 'day')
            );
        });
        const expired = allChats.filter((c) => {
            if (!c.meeting_date || c.meeting_date.trim() === '' || c.meeting_date === '미정') return false;
            return dayjs(c.meeting_date).startOf('day').isBefore(today);
        });

        let msg = `📊 <b>[상담/복음방 전체 관리 현황]</b>\n`;
        msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        msg += `총 등록된 대화방: <b>${allChats.length}개</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n\n`;

        msg += `• ❓ <b>첫 만남일 미등록</b>: ${unassigned.length}개 방\n`;
        msg += `• ⏳ <b>만남일정 미정</b>: ${undecided.length}개 방 (확인: <code>관리자 미등록</code>)\n`;
        msg += `• 🚨 <b>보고서 미제출</b>: ${overdue.length}개 방 (확인: <code>관리자 미제출</code>)\n`;
        msg += `• ⌛ <b>만남일 경과 미갱신</b>: ${expired.length}개 방 (확인: <code>관리자 미갱신</code>)\n\n`;

        if (unassigned.length === 0 && undecided.length === 0 && overdue.length === 0 && expired.length === 0) {
            msg += `✨ <b>현재 모든 방의 일정이 완벽하게 관리되고 있습니다!</b>`;
        } else {
            msg += `💡 각 항목별 세부 명령어를 입력하여 상세 명단을 확인하세요.`;
        }

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[종합 점검 에러]:', err);
    }
});

// 개별 방 상태 확인 (/상태, 상태)
bot.hears(/^\/?상태(?:@\w+)?$/i, async (ctx) => {
    const record = getChatRecord(ctx.chat.id);
    if (!record || !record.meeting_date) {
        await ctx.reply(
            '⚠️ 현재 등록된 만남 일정이 없습니다.\n<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 일정을 등록해주세요.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (record.meeting_date === '미정') {
        const reportStatus = record.report_submitted ? '✅ 제출 완료' : '⏳ 대기 중';
        await ctx.reply(
            `📊 <b>[현재 방 일정 상태]</b>\n\n` +
                `• <b>만남 예정일</b>: ⚠️ <b>미정 (일정 확정 필요)</b>\n` +
                `• <b>만남 보고서</b>: ${reportStatus}\n\n` +
                `💡 만남 일정이 다시 잡히면 <code>/만남일 MM-DD</code>로 알려주세요!`,
            { parse_mode: 'HTML' }
        );
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
        { parse_mode: 'HTML' }
    );
});

// 만남일 수동 설정 (/만남일 MM-DD, 만남일 미정 등)
bot.hears(/^\/?만남일(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️ 날짜를 함께 입력해주세요.\n' + '예: <code>/만남일 09-24</code> 또는 <code>/만남일 미정</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    // 만남일이 '미정'으로 들어온 경우
    if (rawInput.includes('미정')) {
        upsertMeetingDate(ctx.chat.id, title, '미정');
        await ctx.reply(
            '📌 <b>만남 예정일이 [미정]으로 등록되었습니다.</b>\n\n' +
                '만남 일정이 다시 잡히면 <code>/만남일 MM-DD</code>로 봇에게 꼭 알려주세요!',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const formatted = parseFlexibleDate(rawInput);
    if (!formatted) {
        await ctx.reply('⚠️ 올바른 날짜 형식이 아닙니다. (예: 09-24, 9/24, 2026-09-24, 또는 미정)');
        return;
    }

    upsertMeetingDate(ctx.chat.id, title, formatted);

    await ctx.reply(
        `🗓 만남일이 <b>${formatted}</b>로 등록되었습니다.\n\n` +
            `• <b>만남 전날 (10:00)</b>: 피드백(#피드백) 등록 요청 알림\n` +
            `• <b>만남 당일 (22:00)</b>: 만남 보고서 등록 알림\n` +
            `• <b>미제출 시</b>: 1일/2일 경과 경고 알림`,
        { parse_mode: 'HTML' }
    );
});

// 6. 일반 텍스트 수신 (보고서 및 #피드백 감지)
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const roomTitle = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    // DB에 방 정보가 없으면 기본 등록
    ensureChatRecord(chatId, roomTitle);

    // 명령어 및 관리자 호출 텍스트는 일반 텍스트 감지에서 제외
    if (
        /^\/?(만남일|상태|start|help|도움말|관리자|만남명단|미제출|미등록|미정|미갱신|최초미등록|점검|현황)/i.test(text)
    )
        return;

    // 만남 보고서 감지 (양식 키워드)
    const isReport =
        text.includes('상담,복음방 보고서') ||
        text.includes('상담 보고서') ||
        text.includes('복음방 보고서') ||
        text.includes('만남 보고서') ||
        text.includes('다음만남일') ||
        text.includes('다음 만남일');

    if (isReport) {
        const rawNextDate = extractNextMeetingRaw(text);

        // 보고서 내 '다음만남일' 항목이 '미정'인 경우
        if (rawNextDate && rawNextDate.includes('미정')) {
            upsertMeetingDate(chatId, roomTitle, '미정');
            updateChat(chatId, { report_submitted: 1 });

            await ctx.reply(
                '✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n\n' +
                    '📌 <b>다음 만남일이 [미정]으로 기록되었습니다.</b>\n' +
                    '추후 만남 일정이 다시 잡히면 <code>/만남일 MM-DD</code>로 꼭 알려주세요!',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const nextDate = rawNextDate ? parseFlexibleDate(rawNextDate) : null;

        if (!nextDate) {
            updateChat(chatId, { report_submitted: 1 });

            await ctx.reply(
                '⚠️ <b>[다음 만남일 확인 필요]</b>\n\n' +
                    '만남 보고서는 확인되었으나, <b>다음만남일</b> 날짜를 인식하지 못했습니다.\n' +
                    '<i>(예: 형식 불일치, 누락 등)</i>\n\n' +
                    '📌 <b>다음 만남 일정 등록 방법:</b>\n' +
                    '• 날짜가 확정된 경우: <code>/만남일 MM-DD</code>\n' +
                    '• 아직 미정인 경우: <code>/만남일 미정</code>',
                { parse_mode: 'HTML' }
            );
            return;
        }

        upsertMeetingDate(chatId, roomTitle, nextDate);

        await ctx.reply(
            `✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n` +
                `다음 만남일이 <b>${nextDate}</b>로 자동 갱신되었습니다.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    // 피드백 감지: #피드백 또는 #피드백내용 태그가 포함된 경우에만 인식
    if (/#피드백내용|#피드백/.test(text)) {
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
        // 날짜가 없거나 '미정'인 경우 알림 건너뜀
        if (!chat.meeting_date || chat.meeting_date === '미정') continue;

        const mDate = dayjs(chat.meeting_date).startOf('day');
        if (!mDate.isValid()) continue;

        const diffDays = today.diff(mDate, 'day');

        // D-1 피드백 요청 알림
        if (diffDays === -1 && !chat.d_minus_1_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🔔 <b>[D-1 만남 안내]</b>\n` +
                        `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                        `만남 전 <b>피드백 내용</b>을 <code>#피드백</code> 태그를 포함하여 작성해 주세요!`,
                    { parse_mode: 'HTML' }
                );
                updateChat(chat.chat_id, { d_minus_1_notified: 1 });
            } catch (err: any) {
                console.error(`[오전 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        // D+1 보고서 미제출 알림
        if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `⚠️ <b>[보고서 미제출 안내]</b>\n` +
                        `어제(${mDate.format('MM/DD')}) 만남 보고서가 아직 제출되지 않았습니다 (1일 경과).\n` +
                        `확인 후 작성해 주세요.`,
                    { parse_mode: 'HTML' }
                );
                updateChat(chat.chat_id, { overdue_1_notified: 1 });
            } catch (err: any) {
                console.error(`[D+1 지연 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        // D+2 경고 알림
        if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🚨 <b>[보고서 제출 지연 경고]</b>\n` +
                        `만남일(${mDate.format('MM/DD')})로부터 2일이 경과했습니다.\n` +
                        `만남 보고서는 <b>2일 이내 필수 제출</b>이며 지연 시 누적 기록됩니다!`,
                    { parse_mode: 'HTML' }
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
        // 날짜가 없거나, '미정'이거나, 이미 보고서가 제출된 경우 건너뜀
        if (!chat.meeting_date || chat.meeting_date === '미정' || chat.report_submitted) continue;

        const mDate = dayjs(chat.meeting_date).startOf('day');
        if (!mDate.isValid()) continue;

        if (today.isSame(mDate, 'day') && !chat.d_day_22_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `📋 <b>[만남 보고서 제출 안내]</b>\n` +
                        `오늘 만남 잘 마치셨나요?\n` +
                        `금일 만남에 대한 <b>상담,복음방 보고서</b>를 등록해 주세요!`,
                    { parse_mode: 'HTML' }
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
