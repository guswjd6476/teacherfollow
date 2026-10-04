import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Pool } from 'pg';
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

const DB_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('❌ NEON_DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    process.exit(1);
}

// Neon PostgreSQL 연결 풀 설정
const neonPool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
});

neonPool.on('error', (err: any) => {
    console.error('🚨 [Neon Pool 유휴 연결 에러]:', err.message);
});

// DB 스키마 컬럼 자동 추가
async function initDb() {
    try {
        await neonPool.query(`
            ALTER TABLE counseling_chats 
            ADD COLUMN IF NOT EXISTS matched_member_id integer,
            ADD COLUMN IF NOT EXISTS meeting_type VARCHAR(30),
            ADD COLUMN IF NOT EXISTS interviewer_name VARCHAR(50),
            ADD COLUMN IF NOT EXISTS interviewer_code VARCHAR(50),
            ADD COLUMN IF NOT EXISTS interviewer_info VARCHAR(100),
            ADD COLUMN IF NOT EXISTS typer_name VARCHAR(50),
            ADD COLUMN IF NOT EXISTS typer_code VARCHAR(50),
            ADD COLUMN IF NOT EXISTS typer_info VARCHAR(100),
            ADD COLUMN IF NOT EXISTS interview_date VARCHAR(30),
            ADD COLUMN IF NOT EXISTS follow_up_applied VARCHAR(20),
            ADD COLUMN IF NOT EXISTS follow_up_reason TEXT,
            ADD COLUMN IF NOT EXISTS interview_report_submitted INTEGER DEFAULT 0;
        `);
        console.log('✅ [DB 점검] counseling_chats 테이블 신규 컬럼 점검 완료');
    } catch (err: any) {
        console.error('⚠️ [DB 점검 경고]:', err.message);
    }
}

// 관리자 Telegram ID 목록
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

function isAdmin(userId?: number | string): boolean {
    if (!userId) return false;
    return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(String(userId));
}

function escapeHtml(text?: string | number | null): string {
    if (text === undefined || text === null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* =====================================================
 * 💾 Neon PostgreSQL 데이터베이스 인터페이스 및 함수
 * ===================================================== */
interface ChatRecord {
    chat_id: string;
    room_title: string;
    matched_member_id?: number | null;
    matched_student_name?: string | null;
    guide_name?: string | null;
    guide_region?: string | null;
    guide_district?: string | null;
    meeting_type?: '인터뷰' | '교사' | '' | null;
    interviewer_name?: string | null;
    interviewer_code?: string | null;
    interviewer_info?: string | null;
    typer_name?: string | null;
    typer_code?: string | null;
    typer_info?: string | null;
    interview_date?: string | null;
    follow_up_applied?: string | null;
    follow_up_reason?: string | null;
    interview_report_submitted?: number;
    meeting_date: string;
    stop_reason?: string;
    progress_stage?: '섭등예정' | '예정가능일' | '가능가능일' | '';
    progress_note?: string;
    feedback_submitted: number;
    report_submitted: number;
    d_minus_1_notified: number;
    d_day_22_notified: number;
    overdue_1_notified: number;
    overdue_2_notified: number;
    created_at: string;
    updated_at: string;
}

// 텍스트에서 지역/팀/이름 추출 헬퍼 (예: "강북 1팀 귀요미" 또는 "강북/1/귀요미")
function parseMemberString(raw: string): { region: string; team: string; name: string } | null {
    if (!raw) return null;
    const cleaned = raw.trim();

    // 1) 슬래시 구분
    if (cleaned.includes('/')) {
        const parts = cleaned.split('/').map((s) => s.trim());
        if (parts.length >= 3) {
            return { region: parts[0], team: parts[1].replace(/팀/g, ''), name: parts[2] };
        }
    }

    // 2) 띄어쓰기 구분 ("강북 1팀 귀요미" 또는 "강북 1 귀요미")
    const spaceParts = cleaned.split(/\s+/).filter(Boolean);
    if (spaceParts.length >= 3) {
        return { region: spaceParts[0], team: spaceParts[1].replace(/팀/g, ''), name: spaceParts[2] };
    }

    // 3) 붙여쓰기 형태 ("강북1팀 귀요미")
    if (spaceParts.length === 2) {
        const m = spaceParts[0].match(/^([가-힣]+?)(\d+)팀?$/);
        if (m) {
            return { region: m[1], team: m[2], name: spaceParts[1] };
        }
    }

    return null;
}

// members 테이블에서 지역/팀/이름으로 성도 조회
async function findMemberFromDB(name: string, region: string, teamRaw: string) {
    const team = teamRaw.replace(/팀/g, '').trim();
    const query = `
        SELECT "고유번호", "이름", "지역", "구역"
        FROM members
        WHERE "이름" = $1
          AND ("지역" LIKE '%' || $2 || '%' OR $2 LIKE '%' || "지역" || '%')
          AND (COALESCE("구역", '') LIKE $3 || '-%' OR COALESCE("구역", '') LIKE '%' || $3 || '%')
        LIMIT 1;
    `;
    const res = await neonPool.query(query, [name, region, team]);
    return res.rows[0] || null;
}

// 전체 방 목록 조회
async function getAllChats(): Promise<ChatRecord[]> {
    const query = `
        SELECT 
            c.*,
            s."이름" AS matched_student_name,
            m."이름" AS guide_name,
            m."지역" AS guide_region,
            m."구역" AS guide_district
        FROM counseling_chats c
        LEFT JOIN students s ON c.matched_member_id::text = s.id::text
        LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
        ORDER BY c.created_at ASC;
    `;
    const res = await neonPool.query(query);
    return res.rows;
}

// 단일 방 조회
async function getChatRecord(chatId: string | number): Promise<ChatRecord | undefined> {
    const query = `
        SELECT 
            c.*,
            s."이름" AS matched_student_name,
            m."이름" AS guide_name,
            m."지역" AS guide_region,
            m."구역" AS guide_district
        FROM counseling_chats c
        LEFT JOIN students s ON c.matched_member_id::text = s.id::text
        LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
        WHERE c.chat_id = $1
        LIMIT 1;
    `;
    const res = await neonPool.query(query, [String(chatId)]);
    return res.rows[0];
}

// 방 기본 레코드 보장
async function ensureChatRecord(chatId: string | number, title: string) {
    const id = String(chatId);
    const safeTitle = title || '대화방';

    const query = `
        INSERT INTO counseling_chats (chat_id, room_title, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (chat_id) DO UPDATE SET
            room_title = EXCLUDED.room_title,
            updated_at = NOW();
    `;
    await neonPool.query(query, [id, safeTitle]);
}

// 만남일 등록/변경
async function upsertMeetingDate(chatId: string | number, title: string, meetingDate: string) {
    const id = String(chatId);
    const safeTitle = title || '대화방';

    const query = `
        INSERT INTO counseling_chats (
            chat_id, room_title, meeting_date, stop_reason,
            feedback_submitted, report_submitted,
            d_minus_1_notified, d_day_22_notified, overdue_1_notified, overdue_2_notified,
            updated_at
        ) VALUES (
            $1, $2, $3, '',
            0, 0,
            0, 0, 0, 0,
            NOW()
        )
        ON CONFLICT (chat_id) DO UPDATE SET
            room_title = EXCLUDED.room_title,
            meeting_date = EXCLUDED.meeting_date,
            stop_reason = '',
            feedback_submitted = 0,
            report_submitted = 0,
            d_minus_1_notified = 0,
            d_day_22_notified = 0,
            overdue_1_notified = 0,
            overdue_2_notified = 0,
            updated_at = NOW();
    `;
    await neonPool.query(query, [id, safeTitle, meetingDate]);
}

// 방 정보 동적 업데이트
async function updateChat(chatId: string | number, patch: Partial<ChatRecord>) {
    const id = String(chatId);
    const ignoredKeys = ['chat_id', 'matched_student_name', 'guide_name', 'guide_region', 'guide_district'];
    const keys = Object.keys(patch).filter((k) => !ignoredKeys.includes(k));
    if (keys.length === 0) return;

    const setClauses: string[] = [];
    const values: any[] = [id];

    keys.forEach((key, idx) => {
        setClauses.push(`${key} = $${idx + 2}`);
        values.push((patch as any)[key]);
    });

    setClauses.push('updated_at = NOW()');

    const query = `
        UPDATE counseling_chats 
        SET ${setClauses.join(', ')}
        WHERE chat_id = $1;
    `;
    await neonPool.query(query, values);
}

/* =====================================================
 * 🔍 날짜 파싱 유틸리티
 * ===================================================== */
function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    const now = dayjs().tz('Asia/Seoul');

    const threeParts = rawText.match(/(?:^|[^\d])(\d{1,4})[\-\/\.\s년]+(\d{1,2})[\-\/\.\s월]+(\d{1,2})(?:일)?/);
    if (threeParts) {
        const p1 = parseInt(threeParts[1], 10);
        const month = parseInt(threeParts[2], 10);
        const day = parseInt(threeParts[3], 10);

        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            let year = now.year();
            if (threeParts[1].length === 4) {
                year = p1;
            } else {
                if (now.month() === 11 && month === 1) year += 1;
            }

            const d = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
            return d.isValid() ? d.format('YYYY-MM-DD') : null;
        }
    }

    const twoParts = rawText.match(/(?:^|[^\d])(\d{1,2})[\-\/\.\s월]+(\d{1,2})(?:일)?/);
    if (twoParts) {
        const month = parseInt(twoParts[1], 10);
        const day = parseInt(twoParts[2], 10);

        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            let year = now.year();
            if (now.month() === 11 && month === 1) year += 1;

            const d = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
            return d.isValid() ? d.format('YYYY-MM-DD') : null;
        }
    }

    return null;
}

function extractNextMeetingRaw(text: string): string | null {
    const match = text.match(/다음\s*(?:만남일시|만남\s*일시|만남일|만남\s*일|만남|일정)\s*[:：\-]?\s*([^\n\r]+)/i);
    return match && match[1] ? match[1].trim() : null;
}

async function sendChunkedList<T>(
    ctx: any,
    header: string,
    items: T[],
    renderItem: (item: T, globalIndex: number) => string,
    chunkSize = 15
) {
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        let message =
            i === 0
                ? header
                : `📋 <b>[목록 계속 (${i + 1}~${Math.min(i + chunkSize, items.length)})]</b>\n━━━━━━━━━━━━━━━━━━\n\n`;

        chunk.forEach((item, idx) => {
            message += renderItem(item, i + idx + 1);
        });

        await ctx.reply(message, { parse_mode: 'HTML' });
    }
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err: any, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
});

// 방 제목 변경 시 DB 즉시 반영
bot.on('new_chat_title', async (ctx) => {
    const newTitle = ctx.message.new_chat_title;
    const chatId = ctx.chat.id;

    if (newTitle) {
        try {
            await neonPool.query(
                `UPDATE counseling_chats 
                 SET room_title = $1, updated_at = NOW() 
                 WHERE chat_id = $2;`,
                [newTitle, String(chatId)]
            );
            console.log(`[방 제목 변경 반영] Chat: ${chatId} -> "${newTitle}"`);
        } catch (err: any) {
            console.error('[방 제목 갱신 실패]:', err.message);
        }
    }
});

// 봇이 그룹에 추가되거나 퇴장당했을 때[cite: 7]
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id;

    if (status === 'member' || status === 'administrator') {
        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
        await ensureChatRecord(chatId, title);

        await ctx.reply(
            '👋 <b>상담/복음방 일정 관리 봇이 등록되었습니다.</b>\n\n' +
                '먼저 대상자 매칭을 위해 아래 명령어를 입력해주세요:\n' +
                '<code>/최초등록 섭외자/지역/팀/인도자</code>\n' +
                '<i>(예: <code>/최초등록 홍길동/강북/1/강현정</code>)</i>',
            { parse_mode: 'HTML' }
        );
    } else if (status === 'left' || status === 'kicked') {
        try {
            await neonPool.query(`DELETE FROM counseling_chats WHERE chat_id = $1;`, [String(chatId)]);
        } catch (err: any) {
            console.error('[방 퇴장 데이터 삭제 실패]:', err.message);
        }
    }
});

// 도움말 (/start, /help, /도움말)[cite: 7]
bot.hears(/^[\/!](start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>상담/복음방 봇 명령어 안내</b>\n\n' +
            '• <b>대상자 최초 등록</b>: <code>/최초등록 섭외자/지역/팀/인도자</code>\n' +
            '• <b>인터뷰 만남 관련</b>:\n' +
            '   - <code>/인터뷰사전양식</code> (사전 보고서 복사용 양식 출력)\n' +
            '   - <code>/인터뷰양식</code> (결과 보고서 복사용 양식 출력)\n' +
            '   - <i>사전 보고서를 채팅방에 올리면 인터뷰어/타이퍼/예정일이 자동 등록됩니다.</i>\n' +
            '• <b>일반 만남일 설정</b>: <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>\n' +
            '• <b>만남 중단 처리</b>: <code>/만남중단 [사유]</code>\n' +
            '• <b>행정 등록 확인</b>: <code>/행정확인</code>\n' +
            '• <b>현재 방 일정/상태 확인</b>: <code>/상태확인</code>\n\n' +
            '👑 <b>관리자 전용 명령어:</b>\n' +
            '• <code>관리자 구분</code>, <code>관리자 오늘만남</code>, <code>관리자 내일만남</code>\n' +
            '• <code>관리자 미제출</code>, <code>관리자 미등록</code>, <code>관리자 미갱신</code>, <code>관리자 중단</code>, <code>관리자 점검</code>',
        { parse_mode: 'HTML' }
    );
});

// 섭외자 최초 등록 (/최초등록 섭외자/지역/팀/인도자)[cite: 7]
bot.hears(/^[\/!]최초등록(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️ <b>입력 양식이 올바르지 않습니다.</b>\n\n' +
                '• <b>입력 양식</b>: <code>/최초등록 섭외자/지역/팀/인도자</code>\n' +
                '• <b>입력 예시</b>: <code>/최초등록 홍길동/강북/1/강현정</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const parts = rawInput.split('/').map((s) => s.trim());
    if (parts.length < 4) {
        await ctx.reply(
            '⚠️ <b>4개 항목을 모두 슬래시(/)로 구분하여 입력해주세요.</b>\n' +
                '<code>/최초등록 섭외자/지역/팀/인도자</code> (예: <code>/최초등록 홍길동/강북/1/강현정</code>)',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const [targetName, region, teamRaw, guideName] = parts;
    const team = teamRaw.replace(/팀/g, '');

    try {
        const joinQuery = `
            SELECT 
                s.id AS student_id,
                s."이름" AS student_name,
                m."이름" AS guide_name,
                m."지역" AS region,
                m."구역" AS district
            FROM students s
            INNER JOIN members m ON s."인도자_고유번호" = m."고유번호"
            WHERE s."이름" = $1
              AND m."이름" = $2
              AND (m."지역" LIKE '%' || $3 || '%' OR $3 LIKE '%' || m."지역" || '%')
              AND (COALESCE(m."구역", '') LIKE $4 || '-%' OR COALESCE(m."구역", '') LIKE '%' || $4 || '%')
            LIMIT 1;
        `;

        const res = await neonPool.query(joinQuery, [targetName, guideName, region, team]);

        if (res.rows.length === 0) {
            await ctx.reply(
                `❌ <b>일치하는 대상자를 찾을 수 없습니다.</b>\n\n` +
                    `• 섭외자: <b>${escapeHtml(targetName)}</b>\n` +
                    `• 인도자: <b>${escapeHtml(guideName)}</b>\n` +
                    `• 소속/팀: <b>${escapeHtml(region)} / ${escapeHtml(team)}팀</b>\n\n` +
                    `<i>(students의 인도자_고유번호와 members의 등록 정보가 일치하는지 확인해주세요.)</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const match = res.rows[0];
        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

        await ensureChatRecord(ctx.chat.id, title);
        await updateChat(ctx.chat.id, { matched_member_id: match.student_id });

        await ctx.reply(
            `🎉 <b>대상자 매칭 완료!</b>\n\n` +
                `• <b>섭외자(대상자)</b>: <b>${escapeHtml(match.student_name)}</b> (ID: ${match.student_id})\n` +
                `• <b>인도자</b>: ${escapeHtml(match.guide_name)} (${escapeHtml(match.region)} / 구역: ${escapeHtml(
                    match.district
                )})\n\n` +
                `👇 <b>첫 만남의 유형을 선택해주세요:</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎙️ 인터뷰 만남', callback_data: 'type_interview' },
                            { text: '👨‍🏫 교사 만남', callback_data: 'type_teacher' },
                        ],
                    ],
                },
            }
        );
    } catch (err: any) {
        console.error('[최초등록 JOIN 매칭 에러]:', err);
        await ctx.reply(`⚠️ DB 매칭 조회 중 오류 발생: ${err.message}`);
    }
});

// 버튼 콜백: 만남 유형 선택[cite: 7]
bot.action('type_interview', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateChat(ctx.chat!.id, { meeting_type: '인터뷰' });

        await ctx.reply(
            `🎙️ <b>첫 만남이 [인터뷰 만남]으로 지정되었습니다.</b>\n\n` +
                `채팅방에 <b>[인터뷰 사전 보고서]</b>를 올려주시면 인터뷰어/타이퍼/예정일이 자동 등록됩니다.\n\n` +
                `💡 양식이 필요하시면 <code>/인터뷰사전양식</code>을 입력하세요.`,
            { parse_mode: 'HTML' }
        );
    } catch (err: any) {
        console.error('[type_interview 에러]:', err.message);
    }
});

bot.action('type_teacher', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateChat(ctx.chat!.id, { meeting_type: '교사' });

        await ctx.reply(
            `👨‍🏫 <b>첫 만남이 [교사 만남]으로 지정되었습니다.</b>\n\n` +
                `이어서 만남 일정을 지정해주세요:\n` +
                `• <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: any) {
        console.error('[type_teacher 에러]:', err.message);
    }
});

// 인터뷰 사전 보고서 양식 출력 (/인터뷰사전양식)
bot.hears(/^[\/!](인터뷰사전양식|사전양식|사전보고서양식)(?:@\w+)?$/i, async (ctx) => {
    const record = await getChatRecord(ctx.chat.id);
    const targetName = record?.matched_student_name || '홍길동';

    const sample =
        `[인터뷰 사전 보고서]\n` +
        `• 대상자: ${targetName}\n` +
        `• 인터뷰어: 강북 1팀 귀요미\n` +
        `• 타이퍼: 강북 1팀 김공주\n` +
        `• 인터뷰일시: 10-12\n` +
        `• 사전메모: 마음 문 열려 있음`;

    await ctx.reply(
        `📋 <b>[인터뷰 사전 보고서 양식]</b>\n아래 양식을 복사하여 작성 후 이 방에 전송해주세요.\n\n` +
            `<code>${sample}</code>\n\n` +
            `💡 <b>안내:</b>\n` +
            `• 인터뷰어/타이퍼는 <code>지역 팀 이름</code> 형태로 적어주시면 됩니다.\n` +
            `• 타이퍼가 없는 경우 <code>없음</code> 또는 <code>미지정</code>으로 작성하세요.`,
        { parse_mode: 'HTML' }
    );
});

// 인터뷰 결과 보고서 양식 출력 (/인터뷰양식)[cite: 7]
bot.hears(/^[\/!](인터뷰양식|인터뷰보고서양식)(?:@\w+)?$/i, async (ctx) => {
    const record = await getChatRecord(ctx.chat.id);
    const targetName = record?.matched_student_name || '홍길동';
    const interviewer = record?.interviewer_name || '귀요미';
    const typer = record?.typer_name || '김공주';

    const sample =
        `[인터뷰 결과 보고서]\n` +
        `• 대상자: ${targetName}\n` +
        `• 인터뷰어: ${interviewer}\n` +
        `• 타이퍼: ${typer}\n` +
        `• 후속신청: 신청\n` +
        `• 미신청사유: (미신청 시 상세 사유 작성)\n` +
        `• 다음만남일: MM-DD\n` +
        `• 종합소견: 면담 내용 요약 작성`;

    await ctx.reply(
        `📋 <b>[인터뷰 결과 보고서 양식]</b>\n아래 양식을 복사하여 작성 후 이 방에 전송해주세요.\n\n` +
            `<code>${sample}</code>\n\n` +
            `💡 <b>안내:</b>\n` +
            `• 후속신청: <b>신청</b> ➔ 다음 교사 만남 일정으로 자동 인계됩니다.\n` +
            `• 후속신청: <b>미신청</b> ➔ 사유가 저장되고 방이 중단 처리됩니다.`,
        { parse_mode: 'HTML' }
    );
});

// 매칭 해제 (/매칭해제)[cite: 7]
bot.hears(/^[\/!]매칭해제(?:@\w+)?$/i, async (ctx) => {
    await updateChat(ctx.chat.id, {
        matched_member_id: null,
        meeting_type: null,
        interviewer_name: null,
        interviewer_code: null,
        interviewer_info: null,
        typer_name: null,
        typer_code: null,
        typer_info: null,
        interview_date: null,
        follow_up_applied: null,
        follow_up_reason: null,
        interview_report_submitted: 0,
    });
    await ctx.reply('✅ 대상자 매칭 및 인터뷰 설정이 모두 초기화되었습니다.');
});

// 행정 등록 내역 확인 (/행정확인)[cite: 7]
bot.hears(/^[\/!]행정확인(?:@\w+)?$/i, async (ctx) => {
    try {
        const chat = await getChatRecord(ctx.chat.id);

        if (!chat || !chat.matched_member_id) {
            await ctx.reply(
                '⚠️ <b>매칭된 대상자가 없습니다.</b>\n\n먼저 <code>/최초등록 섭외자/지역/팀/인도자</code>로 등록해주세요.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const query = `
            SELECT 
                s.*,
                m."이름" AS guide_name,
                m."지역" AS guide_region,
                m."구역" AS guide_district
            FROM students s
            LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
            WHERE s.id::text = $1::text
            LIMIT 1;
        `;
        const res = await neonPool.query(query, [chat.matched_member_id]);

        if (res.rows.length === 0) {
            await ctx.reply('❌ <b>DB에서 대상자 정보를 찾을 수 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const s = res.rows[0];
        const studentName = escapeHtml(s['이름'] || '미등록');
        const stage = escapeHtml(s['단계'] || '-');
        const guideInfo = s.guide_name
            ? `${escapeHtml(s.guide_name)} (${escapeHtml(s.guide_region || '')} ${escapeHtml(s.guide_district || '')})`
            : '미등록';

        const getFieldVal = (candidates: string[]): string | null => {
            for (const key of candidates) {
                if (s[key] !== undefined && s[key] !== null) {
                    const val = String(s[key]).trim();
                    if (val !== '' && val !== 'EMPTY_STRING' && val !== 'NULL') {
                        return val;
                    }
                }
            }
            return null;
        };

        const balComplete = getFieldVal(['발_완료일', '발완료일', '발완료']);
        const balReg = getFieldVal(['발_등록일', '발등록일']);
        const bokComplete = getFieldVal(['복_완료일', '복완료일', '복완료']);
        const bokReg = getFieldVal(['복_등록일', '복등록일']);
        const subComplete = getFieldVal(['섭_완료일', '섭완료일', '섭완료']);
        const subReg = getFieldVal(['섭_등록일', '섭등록일']);
        const regDate = getFieldVal(['등록일', '생성일']);

        let msg = `📑 <b>[${studentName}] 행정 등록 현황</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n`;
        msg += `• <b>담당 인도자</b>: ${guideInfo}\n`;
        msg += `• <b>현재 단계</b>: <b>${stage}</b>\n\n`;

        msg += `🗓 <b>[주요 행정 일자]</b>\n`;
        let foundDateCount = 0;

        if (balComplete) {
            msg += `• <b>발_완료일</b>: <b>${escapeHtml(balComplete)}</b>\n`;
            foundDateCount++;
        }
        if (balReg) {
            msg += `• 발_등록일: <b>${escapeHtml(balReg)}</b>\n`;
            foundDateCount++;
        }
        if (bokComplete) {
            msg += `• <b>복_완료일</b>: <b>${escapeHtml(bokComplete)}</b>\n`;
            foundDateCount++;
        }
        if (bokReg) {
            msg += `• 복_등록일: <b>${escapeHtml(bokReg)}</b>\n`;
            foundDateCount++;
        }
        if (subComplete) {
            msg += `• <b>섭_완료일</b>: <b>${escapeHtml(subComplete)}</b>\n`;
            foundDateCount++;
        }
        if (subReg) {
            msg += `• 섭_등록일: <b>${escapeHtml(subReg)}</b>\n`;
            foundDateCount++;
        }
        if (regDate) {
            msg += `• 기본 등록일: <b>${escapeHtml(regDate)}</b>\n`;
            foundDateCount++;
        }

        if (foundDateCount === 0) {
            msg += `• 등록된 행정 완료/등록 일자 기록이 없습니다.\n`;
        }

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[/행정확인 에러]:', err);
        await ctx.reply(`⚠️ 행정 확인 중 오류 발생: ${err.message}`);
    }
});

// 개별 방 상태 확인 (/상태확인)[cite: 7]
bot.hears(/^[\/!]상태확인(?:@\w+)?$/i, async (ctx) => {
    const record = await getChatRecord(ctx.chat.id);
    if (!record) {
        await ctx.reply(
            '⚠️ 등록된 방 정보가 없습니다.\n<code>/최초등록 섭외자/지역/팀/인도자</code>로 먼저 등록해주세요.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    let memberText = '• <b>매칭 정보</b>: ⚠️ 미매칭 (<code>/최초등록 섭외자/지역/팀/인도자</code>)\n';
    if (record.matched_student_name) {
        memberText =
            `• <b>섭외 대상자</b>: 👤 <b>${escapeHtml(record.matched_student_name)}</b>\n` +
            `• <b>담당 인도자</b>: ${escapeHtml(record.guide_name || '-')} (${escapeHtml(
                record.guide_region || ''
            )} ${escapeHtml(record.guide_district || '')})\n`;
    }

    let typeText = '• <b>만남 유형</b>: ⚠️ 미선택\n';
    if (record.meeting_type === '교사') {
        typeText = '• <b>만남 유형</b>: 👨‍🏫 <b>교사 만남 진행 중</b>\n';
    } else if (record.meeting_type === '인터뷰') {
        typeText = '• <b>만남 유형</b>: 🎙️ <b>인터뷰 만남 단계</b>\n';
        typeText += `   - <b>인터뷰어</b>: ${
            record.interviewer_info ? escapeHtml(record.interviewer_info) : '⚠️ 미등록'
        }\n`;
        typeText += `   - <b>타이퍼</b>: ${record.typer_info ? escapeHtml(record.typer_info) : '미지정'}\n`;
        if (record.interview_date) {
            typeText += `   - <b>인터뷰 예정일</b>: <b>${escapeHtml(record.interview_date)}</b>\n`;
        }
        if (record.follow_up_applied) {
            typeText += `   - <b>후속 신청</b>: <b>${escapeHtml(record.follow_up_applied)}</b>\n`;
            if (record.follow_up_reason) {
                typeText += `   - <b>미신청 사유</b>: ${escapeHtml(record.follow_up_reason)}\n`;
            }
        }
    }

    const stageText = record.progress_stage
        ? `🏷 <b>진행 단계</b>: <b>${record.progress_stage}</b>${
              record.progress_note ? ` (${escapeHtml(record.progress_note)})` : ''
          }\n`
        : '';

    if (record.meeting_date === '중단') {
        await ctx.reply(
            `📊 <b>[현재 방 일정 상태]</b>\n\n` +
                memberText +
                typeText +
                stageText +
                `• <b>만남 상태</b>: 🛑 <b>만남 중단</b>\n` +
                `• <b>중단 사유</b>: ${escapeHtml(record.stop_reason || '사유 미입력')}\n\n` +
                `💡 만남이 재개되면 <code>/만남일 MM-DD</code>를 입력해주세요.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (record.meeting_date === '미정') {
        const reportStatus = record.report_submitted ? '✅ 제출 완료' : '⏳ 대기 중';
        await ctx.reply(
            `📊 <b>[현재 방 일정 상태]</b>\n\n` +
                memberText +
                typeText +
                stageText +
                `• <b>만남 예정일</b>: ⚠️ <b>미정 (일정 확정 필요)</b>\n` +
                `• <b>보고서 상태</b>: ${reportStatus}\n\n` +
                `💡 만남 일정이 확정되면 <code>/만남일 MM-DD</code>로 알려주세요!`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (!record.meeting_date) {
        await ctx.reply(
            `📊 <b>[현재 방 일정 상태]</b>\n\n` +
                memberText +
                typeText +
                stageText +
                `• <b>만남 예정일</b>: ⚠️ <b>미등록</b>\n\n` +
                `💡 <code>/만남일 MM-DD</code> 또는 인터뷰 사전 보고서로 일정을 등록해주세요.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    const mDate = dayjs(record.meeting_date);
    const feedbackStatus = record.feedback_submitted ? '✅ 제출 완료' : '❌ 미제출';
    const reportStatus = record.report_submitted ? '✅ 제출 완료' : '⏳ 대기 중';

    await ctx.reply(
        `📊 <b>[현재 방 일정 상태]</b>\n\n` +
            memberText +
            typeText +
            stageText +
            `• <b>다음 만남일</b>: ${mDate.format('YYYY년 MM월 DD일')}\n` +
            `• <b>피드백 작성</b>: ${feedbackStatus}\n` +
            `• <b>보고서 제출</b>: ${reportStatus}`,
        { parse_mode: 'HTML' }
    );
});

// 만남 중단 설정 (/만남중단 [사유])[cite: 7]
bot.hears(/^[\/!]만남중단(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const reason = ctx.match[1]?.trim();
    if (!reason) {
        await ctx.reply(
            '⚠️ <b>중단 사유를 함께 입력해주세요.</b>\n' +
                '예: <code>/만남중단 개인 사정으로 잠정 보류</code>\n' +
                '예: <code>/만남중단 대상자 시험 기간으로 인한 일시 중단</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    await ensureChatRecord(ctx.chat.id, title);
    await updateChat(ctx.chat.id, {
        meeting_date: '중단',
        stop_reason: reason,
        feedback_submitted: 0,
        report_submitted: 0,
        d_minus_1_notified: 0,
        d_day_22_notified: 0,
        overdue_1_notified: 0,
        overdue_2_notified: 0,
    });

    await ctx.reply(
        `🛑 <b>만남 일정이 [중단] 처리되었습니다.</b>\n\n` +
            `• <b>중단 사유</b>: ${escapeHtml(reason)}\n\n` +
            `💡 만남이 재개되면 <code>/만남일 MM-DD</code>를 입력하여 새 일정을 등록해주세요.`,
        { parse_mode: 'HTML' }
    );
});

// 만남일 수동 설정 (/만남일 MM-DD, 만남일 미정 등)[cite: 7]
bot.hears(/^[\/!]만남일(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply('⚠️ 날짜를 함께 입력해주세요.\n예: <code>/만남일 09-24</code> 또는 <code>/만남일 미정</code>', {
            parse_mode: 'HTML',
        });
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    if (rawInput.includes('미정')) {
        await upsertMeetingDate(ctx.chat.id, title, '미정');
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

    await upsertMeetingDate(ctx.chat.id, title, formatted);

    await ctx.reply(
        `🗓 만남일이 <b>${formatted}</b>로 등록되었습니다.\n\n` +
            `• <b>만남 전날 (10:00)</b>: 피드백(#피드백) 등록 요청 알림\n` +
            `• <b>만남 당일 (22:00)</b>: 만남 보고서 등록 알림\n` +
            `• <b>미제출 시</b>: 1일/2일 경과 경고 알림`,
        { parse_mode: 'HTML' }
    );
});

// 방 구분 설정 (/섭등예정, /예정가능일, /가능가능일 [메모])[cite: 7]
bot.hears(/^[\/!](섭등예정|예정가능일|가능가능일)(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const stage = ctx.match[1] as '섭등예정' | '예정가능일' | '가능가능일';
    const note = ctx.match[2]?.trim() || '';
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    await ensureChatRecord(ctx.chat.id, title);
    await updateChat(ctx.chat.id, {
        progress_stage: stage,
        progress_note: note,
    });

    let replyMsg = `📌 <b>대화방 구분이 [${stage}]으로 설정되었습니다.</b>\n`;
    if (note) replyMsg += `• 내용: ${escapeHtml(note)}\n`;
    replyMsg += `\n💡 일반 상태로 복귀하려면 <code>/구분해제</code>를 입력하세요.`;

    await ctx.reply(replyMsg, { parse_mode: 'HTML' });
});

// 방 구분 해제 (/구분해제, /일반)[cite: 7]
bot.hears(/^[\/!](구분해제|일반)(?:@\w+)?$/i, async (ctx) => {
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    await ensureChatRecord(ctx.chat.id, title);

    await updateChat(ctx.chat.id, {
        progress_stage: '',
        progress_note: '',
    });

    await ctx.reply('✅ <b>특수 구분이 해제되어 [일반] 상태로 전환되었습니다.</b>', { parse_mode: 'HTML' });
});

// 관리자 명령어 1. 날짜별 만남 조회[cite: 7]
bot.hears(
    /^(?:[\/!]?관리자(?:\s+(?!(?:미제출|미등록|미정|미갱신|최초미등록|점검|현황|중단|구분|단계|특수|섭등예정|예정가능일|가능가능일|일반|일반방|미분류))(.+))?|[\/!](?:만남명단|만남일정)(?:@\w+)?(?:\s+(.+))?)$/i,
    async (ctx) => {
        try {
            const userId = String(ctx.from?.id);
            if (!isAdmin(userId)) {
                await ctx.reply(`⛔ <b>접근 권한이 없습니다.</b> 관리자만 사용할 수 있습니다.`, {
                    parse_mode: 'HTML',
                });
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
                    await ctx.reply('⚠️ 형식 오류: <code>관리자 오늘만남</code>, <code>관리자 09-25</code>', {
                        parse_mode: 'HTML',
                    });
                    return;
                }
            }

            const allChats = await getAllChats();
            const targetChats = allChats.filter((chat) => chat.meeting_date === targetDateStr);

            if (targetChats.length === 0) {
                await ctx.reply(`🗓 <b>[${targetDateStr}] 예정된 만남 일정이 없습니다.</b>`, { parse_mode: 'HTML' });
                return;
            }

            const header =
                `📋 <b>[만남 일정 명단] (총 ${targetChats.length}건)</b>\n` +
                `📅 기준일: <b>${targetDateStr}</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n\n`;

            await sendChunkedList(ctx, header, targetChats, (chat, idx) => {
                const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
                const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기 중';
                const stageBadge = chat.progress_stage ? ` [🏷 ${chat.progress_stage}]` : '';
                const typeBadge = chat.meeting_type ? ` [${chat.meeting_type}]` : '';
                const memberBadge = chat.matched_student_name
                    ? ` (👤 ${escapeHtml(chat.matched_student_name)} / 인도자: ${escapeHtml(chat.guide_name || '-')})`
                    : '';

                return (
                    `<b>${idx}. ${escapeHtml(
                        chat.room_title || '대화방'
                    )}${memberBadge}${typeBadge}${stageBadge}</b>\n` +
                    `   • 사전 피드백: ${feedbackBadge}\n` +
                    `   • 만남 보고서: ${reportBadge}\n\n`
                );
            });
        } catch (err: any) {
            console.error('[만남 명단 조회 에러]:', err);
        }
    }
);

// 관리자 명령어 2. 보고서 미제출 명단[cite: 7]
bot.hears(/^(?:[\/!]?관리자\s+)((?:만남\s*)?보고서\s*미제출|미제출\s*명단|미제출)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ <b>접근 권한이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const overdueChats = allChats
            .filter((chat) => {
                if (
                    !chat.meeting_date ||
                    chat.meeting_date === '미정' ||
                    chat.meeting_date === '중단' ||
                    chat.report_submitted
                )
                    return false;
                const mDate = dayjs(chat.meeting_date).startOf('day');
                return mDate.isBefore(today) || mDate.isSame(today, 'day');
            })
            .sort((a, b) => dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf());

        if (overdueChats.length === 0) {
            await ctx.reply('🎉 <b>현재 미제출된 보고서가 없습니다!</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `🚨 <b>[보고서 미제출 명단] (총 ${overdueChats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, overdueChats, (chat, idx) => {
            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day');

            let delayBadge = diffDays === 0 ? '⏳ 당일 대기' : diffDays === 1 ? '⚠️ 1일 지연' : `🚨 ${diffDays}일 경과`;
            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            const typeBadge = chat.meeting_type ? ` [${chat.meeting_type}]` : '';

            return (
                `<b>${idx}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}${typeBadge}\n` +
                `   • 만남일: ${mDate.format('YYYY-MM-DD')} (${delayBadge})\n\n`
            );
        });
    } catch (err: any) {
        console.error('[미제출 명단 조회 에러]:', err);
    }
});

// 관리자 명령어 3. 종합 점검[cite: 7]
bot.hears(/^(?:[\/!]?관리자\s+)(점검|현황|종합\s*점검|전체\s*점검)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const unassigned = allChats.filter((c) => !c.meeting_date || c.meeting_date.trim() === '');
        const undecided = allChats.filter((c) => c.meeting_date === '미정');
        const stopped = allChats.filter((c) => c.meeting_date === '중단');
        const interviewCount = allChats.filter((c) => c.meeting_type === '인터뷰').length;
        const teacherCount = allChats.filter((c) => c.meeting_type === '교사').length;

        let msg = `📊 <b>[상담/복음방 전체 관리 현황]</b>\n`;
        msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        msg += `총 등록 방: <b>${allChats.length}개</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n\n`;

        msg += `🎙️ <b>인터뷰 만남 진행</b>: ${interviewCount}개 방\n`;
        msg += `👨‍🏫 <b>교사 만남 진행</b>: ${teacherCount}개 방\n\n`;

        msg += `• ❓ <b>만남일 미등록</b>: ${unassigned.length}개 방\n`;
        msg += `• ⏳ <b>만남일정 미정</b>: ${undecided.length}개 방\n`;
        msg += `• 🛑 <b>만남 중단 상태</b>: ${stopped.length}개 방\n`;

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('[종합 점검 에러]:', err);
    }
});

// 10. 일반 텍스트 수신 (사전 보고서, 결과 보고서, 만남 보고서 및 #피드백 감지)
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat.id;
    const roomTitle = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    await ensureChatRecord(chatId, roomTitle);

    // 슬래시(/)나 느낌표(!)로 시작하는 정식 명령어 텍스트는 무시[cite: 7]
    if (/^[!/]/i.test(text) || /^관리자\s+/i.test(text)) {
        return;
    }

    // A. [인터뷰 사전 보고서] 자동 감지 및 파싱
    const isInterviewPreReport =
        text.includes('인터뷰 사전 보고서') ||
        text.includes('인터뷰 사전보고서') ||
        text.includes('인터뷰 신청서') ||
        text.includes('인터뷰 계획서');

    if (isInterviewPreReport) {
        // 인터뷰어 추출
        const interviewerMatch = text.match(/인터뷰어\s*[:：\-]?\s*([^\n\r]+)/i);
        const interviewerRaw = interviewerMatch ? interviewerMatch[1].trim() : '';

        // 타이퍼 추출
        const typerMatch = text.match(/타이퍼\s*[:：\-]?\s*([^\n\r]+)/i);
        const typerRaw = typerMatch ? typerMatch[1].trim() : '';

        // 날짜 추출
        const dateMatch = text.match(
            /(?:인터뷰\s*(?:예정일|일시|일)|만남\s*(?:예정일|일시|일)|일시|일정)\s*[:：\-]?\s*([^\n\r]+)/i
        );
        const dateRaw = dateMatch ? dateMatch[1].trim() : '';

        if (!interviewerRaw) {
            await ctx.reply(
                '⚠️ 인터뷰어 정보가 누락되었습니다. <code>• 인터뷰어: 지역 팀 이름</code> 형식으로 작성해주세요.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const iInfo = parseMemberString(interviewerRaw);
        if (!iInfo) {
            await ctx.reply(
                `⚠️ 인터뷰어(<b>${escapeHtml(interviewerRaw)}</b>)의 소속 형식을 인식하지 못했습니다.\n` +
                    `예: <code>• 인터뷰어: 강북 1팀 귀요미</code> 또는 <code>강북/1/귀요미</code>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        try {
            const interviewer = await findMemberFromDB(iInfo.name, iInfo.region, iInfo.team);
            if (!interviewer) {
                await ctx.reply(
                    `❌ <b>DB에서 인터뷰어를 찾을 수 없습니다.</b>\n• ${escapeHtml(iInfo.region)} / ${escapeHtml(
                        iInfo.team
                    )}팀 / ${escapeHtml(iInfo.name)}`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            // 타이퍼 조회 (타이퍼가 작성된 경우)
            let typer: any = null;
            const hasTyper = typerRaw && !/^(없음|미지정|\-|없|X)$/i.test(typerRaw);
            if (hasTyper) {
                let tInfo = parseMemberString(typerRaw);
                // 소속 생략 시 인터뷰어 소속 상속
                if (!tInfo && /^[가-힣]{2,4}$/.test(typerRaw)) {
                    tInfo = { region: iInfo.region, team: iInfo.team, name: typerRaw };
                }

                if (tInfo) {
                    typer = await findMemberFromDB(tInfo.name, tInfo.region, tInfo.team);
                    if (!typer) {
                        await ctx.reply(
                            `⚠️ 타이퍼(<b>${escapeHtml(
                                typerRaw
                            )}</b>)를 DB에서 찾지 못하여 [미지정] 처리하고 계속 진행합니다.`,
                            { parse_mode: 'HTML' }
                        );
                    }
                }
            }

            // 날짜 파싱
            let formattedDate = '미정';
            if (dateRaw && !dateRaw.includes('미정')) {
                const parsed = parseFlexibleDate(dateRaw);
                if (parsed) formattedDate = parsed;
            }

            await upsertMeetingDate(chatId, roomTitle, formattedDate);

            const patch: Partial<ChatRecord> = {
                meeting_type: '인터뷰',
                interview_date: formattedDate,
                interviewer_name: interviewer['이름'],
                interviewer_code: interviewer['고유번호'],
                interviewer_info: `${interviewer['지역']} ${interviewer['구역']} ${interviewer['이름']}`,
                typer_name: typer ? typer['이름'] : null,
                typer_code: typer ? typer['고유번호'] : null,
                typer_info: typer ? `${typer['지역']} ${typer['구역']} ${typer['이름']}` : null,
            };
            await updateChat(chatId, patch);

            let resMsg = `🎙️ <b>[인터뷰 사전 보고서]가 정상 반영되었습니다!</b>\n\n`;
            resMsg += `• <b>인터뷰어</b>: <b>${escapeHtml(interviewer['이름'])}</b> (${escapeHtml(
                interviewer['지역']
            )} / ${escapeHtml(interviewer['구역'])})\n`;
            resMsg += `• <b>타이퍼</b>: ${
                typer
                    ? `<b>${escapeHtml(typer['이름'])}</b> (${escapeHtml(typer['지역'])} / ${escapeHtml(
                          typer['구역']
                      )})`
                    : '미지정'
            }\n`;
            resMsg += `• <b>인터뷰 예정일</b>: <b>${formattedDate}</b>\n\n`;
            resMsg += `• <b>D-1 알림 (10:00)</b>: 인터뷰 안내 알림\n`;
            resMsg += `• <b>당일 알림 (22:00)</b>: 결과 보고서 등록 알림\n\n`;
            resMsg += `💡 인터뷰 종료 후 <code>/인터뷰양식</code>을 복사하여 결과를 등록해주세요.`;

            await ctx.reply(resMsg, { parse_mode: 'HTML' });
            return;
        } catch (err: any) {
            console.error('[사전 보고서 자동 처리 에러]:', err);
            await ctx.reply(`⚠️ 사전 보고서 처리 중 오류가 발생했습니다: ${err.message}`);
            return;
        }
    }

    // B. [인터뷰 결과 보고서] 감지[cite: 7]
    const isInterviewReport =
        text.includes('인터뷰 결과 보고서') ||
        text.includes('인터뷰 결과') ||
        text.includes('인터뷰보고서') ||
        text.includes('인터뷰 보고서');

    if (isInterviewReport) {
        const followUpMatch = text.match(/후속\s*신청\s*[:：\-]?\s*([^\n\r]+)/i);
        const followUpRaw = followUpMatch ? followUpMatch[1].trim() : '';

        const isNotApplied = /미신청|안함|거절|취소|보류|불가|X|x/i.test(followUpRaw);
        const isApplied = /신청|완료|진행|O|o/i.test(followUpRaw) && !isNotApplied;

        if (isNotApplied) {
            const reasonMatch = text.match(/미신청\s*사유\s*[:：\-]?\s*([^\n\r]+)/i);
            const reason = reasonMatch ? reasonMatch[1].trim() : '사유 미입력';

            await updateChat(chatId, {
                meeting_type: '인터뷰',
                follow_up_applied: '미신청',
                follow_up_reason: reason,
                meeting_date: '중단',
                stop_reason: `인터뷰 후속 미신청: ${reason}`,
                interview_report_submitted: 1,
                report_submitted: 1,
            });

            await ctx.reply(
                `🛑 <b>인터뷰 결과 보고서가 반영되었습니다.</b>\n\n` +
                    `• <b>후속 신청</b>: <b>미신청</b>\n` +
                    `• <b>미신청 사유</b>: ${escapeHtml(reason)}\n` +
                    `• <b>대화방 상태</b>: 만남 중단 처리됨\n\n` +
                    `<i>(후속 미신청 사유가 DB에 안전하게 기록되었습니다.)</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        if (isApplied) {
            const rawNextDate = extractNextMeetingRaw(text);
            const nextDate = rawNextDate ? parseFlexibleDate(rawNextDate) : null;
            const isUndecided = rawNextDate && rawNextDate.includes('미정');

            let nextMeetingStr = '미정';
            if (!isUndecided && nextDate) {
                nextMeetingStr = nextDate;
            }

            await upsertMeetingDate(chatId, roomTitle, nextMeetingStr);
            await updateChat(chatId, {
                meeting_type: '교사',
                follow_up_applied: '신청',
                follow_up_reason: '',
                interview_report_submitted: 1,
                report_submitted: 0,
            });

            await ctx.reply(
                `🎉 <b>인터뷰 결과 보고서가 정상 반영되었습니다!</b>\n\n` +
                    `• <b>후속 신청</b>: <b>신청 완료 ✅</b>\n` +
                    `• <b>만남 단계</b>: <b>👨‍🏫 교사 만남</b>으로 자동 전환되었습니다.\n` +
                    `• <b>다음 만남 예정일</b>: <b>${nextMeetingStr}</b>\n\n` +
                    `앞으로 교사 만남 주기(D-1 피드백, 당일 만남보고서)에 맞춰 자동 관리됩니다.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        await ctx.reply(
            '⚠️ <b>[후속신청 여부 확인 필요]</b>\n\n' +
                '인터뷰 결과 보고서에서 <b>후속신청</b>(신청 또는 미신청)을 판별하지 못했습니다.\n' +
                '양식에 <code>• 후속신청: 신청</code> 또는 <code>• 후속신청: 미신청</code>을 명시해주세요.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    // C. 일반 [만남 보고서] 감지[cite: 7]
    const isReport =
        text.includes('상담,복음방 보고서') ||
        text.includes('상담 보고서') ||
        text.includes('복음방 보고서') ||
        text.includes('만남 보고서') ||
        text.includes('다음만남일') ||
        text.includes('다음 만남일');

    if (isReport) {
        const rawNextDate = extractNextMeetingRaw(text);

        if (rawNextDate && rawNextDate.includes('미정')) {
            await upsertMeetingDate(chatId, roomTitle, '미정');
            await updateChat(chatId, { report_submitted: 1 });

            await ctx.reply(
                '✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n\n' +
                    '📌 <b>다음 만남일이 [미정]으로 기록되었습니다.</b>\n' +
                    '추후 만남 일정이 다시 잡히면 <code>/만남일 MM-DD</code>로 알려주세요!',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const nextDate = rawNextDate ? parseFlexibleDate(rawNextDate) : null;

        if (!nextDate) {
            await updateChat(chatId, { report_submitted: 1 });
            await ctx.reply(
                '⚠️ 만남 보고서는 확인되었으나 <b>다음만남일</b> 날짜를 인식하지 못했습니다.\n' +
                    '<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 일정을 등록해주세요.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        await upsertMeetingDate(chatId, roomTitle, nextDate);
        await ctx.reply(
            `✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n다음 만남일이 <b>${nextDate}</b>로 자동 갱신되었습니다.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    // D. 피드백 감지[cite: 7]
    if (/#피드백내용|#피드백/.test(text)) {
        await updateChat(chatId, { feedback_submitted: 1 });
        await ctx.reply('📝 <b>피드백 내용이 확인되었습니다.</b> 감사합니다.', { parse_mode: 'HTML' });
    }
});

/* =====================================================
 * ⏰ 스케줄러 트리거 함수들
 * ===================================================== */
async function triggerMorningReminder() {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const chats = await getAllChats();

    for (const chat of chats) {
        if (!chat.meeting_date || chat.meeting_date === '미정' || chat.meeting_date === '중단') continue;

        const mDate = dayjs(chat.meeting_date).startOf('day');
        if (!mDate.isValid()) continue;

        const diffDays = today.diff(mDate, 'day');

        // D-1 안내[cite: 7]
        if (diffDays === -1 && !chat.d_minus_1_notified) {
            try {
                if (chat.meeting_type === '인터뷰') {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `🔔 <b>[D-1 인터뷰 만남 안내]</b>\n` +
                            `내일(${mDate.format('MM/DD')})은 인터뷰 만남 예정일입니다.\n` +
                            `• 담당 인터뷰어: ${escapeHtml(chat.interviewer_info || '미등록')}\n` +
                            `• 타이퍼: ${escapeHtml(chat.typer_info || '미지정')}\n\n` +
                            `인터뷰 전 사전 준비사항과 대상자 상태를 점검해 주세요!`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `🔔 <b>[D-1 만남 안내]</b>\n` +
                            `내일(${mDate.format('MM/DD')})은 만남 예정일입니다.\n` +
                            `만남 전 <b>피드백 내용</b>을 <code>#피드백</code> 태그를 포함하여 작성해 주세요!`,
                        { parse_mode: 'HTML' }
                    );
                }
                await updateChat(chat.chat_id, { d_minus_1_notified: 1 });
            } catch (err: any) {
                console.error(`[오전 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        // D+1 미제출 알림[cite: 7]
        if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
            try {
                const reportTitle = chat.meeting_type === '인터뷰' ? '인터뷰 결과 보고서' : '만남 보고서';
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `⚠️ <b>[보고서 미제출 안내]</b>\n` +
                        `어제(${mDate.format(
                            'MM/DD'
                        )}) 진행된 만남의 <b>${reportTitle}</b>가 아직 제출되지 않았습니다.\n` +
                        `확인 후 작성해 주세요.`,
                    { parse_mode: 'HTML' }
                );
                await updateChat(chat.chat_id, { overdue_1_notified: 1 });
            } catch (err: any) {
                console.error(`[D+1 지연 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }

        // D+2 경고 알림[cite: 7]
        if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🚨 <b>[보고서 제출 지연 경고]</b>\n` +
                        `만남일(${mDate.format('MM/DD')})로부터 2일이 경과했습니다.\n` +
                        `만남 보고서는 <b>2일 이내 필수 제출</b> 대상입니다!`,
                    { parse_mode: 'HTML' }
                );
                await updateChat(chat.chat_id, { overdue_2_notified: 1 });
            } catch (err: any) {
                console.error(`[D+2 경고 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }
    }
}

async function triggerNightReminder() {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const chats = await getAllChats();

    for (const chat of chats) {
        if (!chat.meeting_date || chat.meeting_date === '미정' || chat.meeting_date === '중단' || chat.report_submitted)
            continue;

        const mDate = dayjs(chat.meeting_date).startOf('day');
        if (!mDate.isValid()) continue;

        if (today.isSame(mDate, 'day') && !chat.d_day_22_notified) {
            try {
                if (chat.meeting_type === '인터뷰') {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `📋 <b>[인터뷰 결과 보고서 제출 안내]</b>\n` +
                            `오늘 인터뷰 만남 잘 마치셨나요?\n` +
                            `금일 인터뷰에 대한 <b>인터뷰 결과 보고서</b>를 등록해 주세요!\n\n` +
                            `💡 양식이 필요하시면 <code>/인터뷰양식</code>을 입력하세요.`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `📋 <b>[만남 보고서 제출 안내]</b>\n` +
                            `오늘 만남 잘 마치셨나요?\n` +
                            `금일 만남에 대한 <b>상담,복음방 보고서</b>를 등록해 주세요!`,
                        { parse_mode: 'HTML' }
                    );
                }
                await updateChat(chat.chat_id, { d_day_22_notified: 1 });
            } catch (err: any) {
                console.error(`[22시 알림 실패] Chat: ${chat.chat_id}`, err.message);
            }
        }
    }
}

/* =====================================================
 * 🌐 HTTP 웹훅 서버 구동[cite: 7]
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

    // DB 테이블 컬럼 점검 및 자동 생성[cite: 7]
    await initDb();

    const webhookUrl = 'https://teacherfollow.alwaysdata.net/webhook';
    try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Telegram Webhook 등록 완료: ${webhookUrl}`);
    } catch (e: any) {
        console.error('Webhook 등록 에러:', e.message);
    }
});
