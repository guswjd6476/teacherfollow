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

neonPool.on('error', (err: unknown) => {
    console.error('🚨 [Neon Pool 유휴 연결 에러]:', getErrorMessage(err));
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
            ADD COLUMN IF NOT EXISTS interview_report_submitted INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS stop_category VARCHAR(30),
            ADD COLUMN IF NOT EXISTS stage_notified_date VARCHAR(10);
        `);
        console.log('✅ [DB 점검] counseling_chats 테이블 신규 컬럼 점검 완료');

        // 진행 구분 이름 변경 반영 (섭등예정→섭등목표, 예정가능일→예정목표, 가능가능일→가능목표)
        for (const [oldName, newName] of Object.entries(LEGACY_STAGE_NAMES)) {
            const res = await neonPool.query(
                `UPDATE counseling_chats SET progress_stage = $2 WHERE progress_stage = $1;`,
                [oldName, newName]
            );
            if (res.rowCount) console.log(`✅ [DB 점검] 진행 구분 이름 변경: ${oldName} → ${newName} (${res.rowCount}건)`);
        }
    } catch (err: unknown) {
        console.error('⚠️ [DB 점검 경고]:', getErrorMessage(err));
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

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function escapeHtml(text?: string | number | null): string {
    if (text === undefined || text === null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 진행 구분 (방 단위 목표 단계) — 이름 변경 시 이 목록만 수정
const PROGRESS_STAGES = ['섭등목표', '예정목표', '가능목표', '확정목표'] as const;
type ProgressStage = (typeof PROGRESS_STAGES)[number];
// 이전 이름 → 새 이름 (기존 명령어 호환 및 DB 값 변환용)
const LEGACY_STAGE_NAMES: Record<string, ProgressStage> = {
    섭등예정: '섭등목표',
    예정가능일: '예정목표',
    가능가능일: '가능목표',
};
const STAGE_CODES: Record<ProgressStage, string> = { 섭등목표: 'sub', 예정목표: 'yej', 가능목표: 'gan', 확정목표: 'hwa' };
const STAGE_EMOJI: Record<ProgressStage, string> = { 섭등목표: '📌', 예정목표: '🗓', 가능목표: '✨', 확정목표: '✅' };
// 명령어 정규식용: 새 이름 + 이전 이름
const STAGE_COMMAND_ALT = [...PROGRESS_STAGES, ...Object.keys(LEGACY_STAGE_NAMES)].join('|');

function normalizeStage(raw: string): ProgressStage {
    return LEGACY_STAGE_NAMES[raw] ?? (raw as ProgressStage);
}

function isProgressStage(v: unknown): v is ProgressStage {
    return PROGRESS_STAGES.includes(v as ProgressStage);
}

// 만남 중단 / 인터뷰 후속 미신청 사유 분류 (버튼 선택 → counseling_chats.stop_category 저장)
const STOP_CATEGORIES = [
    { code: 'contact', label: '연락두절' },
    { code: 'chim', label: '침맞음' },
    { code: 'refuse', label: '관심부족·거부' },
    { code: 'study', label: '학업·시험' },
    { code: 'busy', label: '직장·바쁨' },
    { code: 'health', label: '건강' },
    { code: 'move', label: '이사·거리' },
    { code: 'personal', label: '개인사정' },
    { code: 'romance', label: '이성목적' },
    { code: 'etc', label: '기타' },
] as const;

function getStopCategoryLabel(code: string): string | null {
    return STOP_CATEGORIES.find((c) => c.code === code)?.label ?? null;
}

// prefix: 'stop' (만남 중단) / 'fu' (인터뷰 후속 미신청)
function buildStopCategoryKeyboard(prefix: 'stop' | 'fu') {
    const buttons = STOP_CATEGORIES.map((c) => ({ text: c.label, callback_data: `${prefix}:${c.code}` }));
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    if (prefix === 'stop') rows.push([{ text: '❌ 취소', callback_data: 'stop:cancel' }]);
    return { inline_keyboard: rows };
}

// 날짜를 'M/D' (예: 10/2) 형태로 포맷팅
function formatDateDisplay(raw: any): string {
    if (!raw) return '-';
    const str = String(raw).trim();
    if (str === '' || str === 'EMPTY_STRING' || str === 'NULL') return '-';

    const d = dayjs(raw);
    if (d.isValid()) {
        return d.format('M/D');
    }
    return str;
}

/* =====================================================
 * 💾 Neon PostgreSQL 데이터베이스 인터페이스 및 함수
 * ===================================================== */
interface ChatRecord {
    chat_id: string;
    room_title: string;
    matched_member_id?: number | null;
    matched_student_name?: string | null;
    student_target?: unknown;
    student_stage?: string | null;
    guide_name?: string | null;
    guide_region?: string | null;
    guide_district?: string | null;
    teacher_name?: string | null;
    teacher_region?: string | null;
    teacher_district?: string | null;
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
    stop_category?: string | null;
    progress_stage?: ProgressStage | '';
    progress_note?: string;
    stage_notified_date?: string | null;
    feedback_submitted: number;
    report_submitted: number;
    d_minus_1_notified: number;
    d_day_22_notified: number;
    overdue_1_notified: number;
    overdue_2_notified: number;
    created_at: string;
    updated_at: string;
}

// 텍스트에서 지역/팀/이름 추출 헬퍼 (슬래시 및 띄어쓰기 모두 지원)
function parseMemberString(raw: string): { region: string; team: string; name: string } | null {
    if (!raw) return null;
    const cleaned = raw.trim();

    if (cleaned.includes('/')) {
        const parts = cleaned.split('/').map((s) => s.trim());
        if (parts.length >= 3) {
            return { region: parts[0], team: parts[1].replace(/팀/g, ''), name: parts[2] };
        }
    }

    const spaceParts = cleaned.split(/\s+/).filter(Boolean);
    if (spaceParts.length >= 3) {
        return { region: spaceParts[0], team: spaceParts[1].replace(/팀/g, ''), name: spaceParts[2] };
    }

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

// 교사 표시 ('이름 (지역 구역)') — students."교사_고유번호" → members 조인 결과 사용
function teacherText(row: { teacher_name?: string | null; teacher_region?: string | null; teacher_district?: string | null }): string {
    if (!row.teacher_name) return '미등록';
    const where = [row.teacher_region, row.teacher_district].filter(Boolean).join(' ');
    return `${escapeHtml(row.teacher_name)}${where ? ` (${escapeHtml(where)})` : ''}`;
}

// 전체 방 목록 조회
async function getAllChats(): Promise<ChatRecord[]> {
    const query = `
        SELECT 
            c.*,
            s."이름" AS matched_student_name,
            s.target AS student_target,
            s."단계" AS student_stage,
            m."이름" AS guide_name,
            m."지역" AS guide_region,
            m."구역" AS guide_district,
            t."이름" AS teacher_name,
            t."지역" AS teacher_region,
            t."구역" AS teacher_district
        FROM counseling_chats c
        LEFT JOIN students s ON c.matched_member_id::text = s.id::text
        LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
        LEFT JOIN members t ON s."교사_고유번호" = t."고유번호"
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
    const ignoredKeys = ['chat_id', 'matched_student_name', 'student_target', 'student_stage', 'guide_name', 'guide_region', 'guide_district', 'teacher_name', 'teacher_region', 'teacher_district'];
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

// 진행 구분 예정일 (progress_note에 'YYYY-MM-DD'로 저장) — 날짜가 아니면 null
function getStageDate(note?: string | null): dayjs.Dayjs | null {
    if (!note || !/^\d{4}-\d{2}-\d{2}$/.test(note.trim())) return null;
    const d = dayjs(note.trim());
    return d.isValid() ? d : null;
}

function formatStageDate(note?: string | null): string {
    const d = getStageDate(note);
    if (!d) return note ? `미입력 (기존 메모: ${escapeHtml(note)})` : '미입력';
    return `${d.format('YYYY-MM-DD')} (${'일월화수목금토'[d.day()]})`;
}

// 진행 구분(섭등목표 등) 조회 대상: 행정 단계가 합 이상(합·섭)인 대상자만
function isHapOrAbove(c: { student_stage?: string | null }): boolean {
    return getStudentStageRank(c.student_stage) >= 2;
}

// 예정일 내림차순 (최신 날짜 먼저), 날짜 없는 방은 맨 뒤
function sortByStageDateDesc<T extends { progress_note?: string }>(chats: T[]): T[] {
    return [...chats].sort((a, b) => {
        const da = getStageDate(a.progress_note);
        const db = getStageDate(b.progress_note);
        if (da && db) return db.valueOf() - da.valueOf();
        return da ? -1 : db ? 1 : 0;
    });
}

// 보고서 항목 내용 추출: 라벨 줄의 나머지 + 다음 항목 전까지의 줄, 라벨이 없으면 null
// 줄 머리의 기호/번호 (예: '▶️', '▪️', '•', '2.')
const REPORT_LINE_PREFIX = String.raw`^\s*[•\-*▪◾■□○●▶►✔✅☑️\d.)]*\s*`;
// '• 항목: 값' 형태의 줄 (머리 기호가 있어야 항목으로 간주 — 본문의 '공과 제목 : ...' 같은 줄은 내용)
const REPORT_FIELD_LINE = /^\s*[•▪◾■□○●▶►✔✅☑️]+\s*[가-힣A-Za-z][가-힣A-Za-z0-9 ()\/·,\-]{0,20}\s*[:：]/u;
const REPORT_KNOWN_LABEL = new RegExp(
    REPORT_LINE_PREFIX +
        String.raw`(?:진행\s*내용|진행\s*내역|상담\s*반응|교육\s*후\s*반응|특이\s*사항|섭외자\s*느낀\s*점|입막음|다음\s*만남)`,
    'u'
);
// 양식의 섹션 머리 기호 (▶️ 진행내용, ▪️만남일시, 🖤 해결해야 할 것 등)
const REPORT_SECTION_HEAD = /^\s*(?:▶|►|▪|◾|■|🖤|🏷)/u;

function extractReportField(text: string, label: RegExp): string | null {
    const lines = text.split(/\r?\n/);
    const anchored = new RegExp(REPORT_LINE_PREFIX + label.source, 'u');
    const start = lines.findIndex((l) => anchored.test(l));
    if (start < 0) return null;

    const m = lines[start].match(anchored)!;
    const first = lines[start].slice(m[0].length).replace(/^\s*[:：\-]?\s*/, '');
    const body = [first];
    for (
        let i = start + 1;
        i < lines.length &&
        !REPORT_FIELD_LINE.test(lines[i]) &&
        !REPORT_KNOWN_LABEL.test(lines[i]) &&
        !REPORT_SECTION_HEAD.test(lines[i]);
        i++
    ) {
        body.push(lines[i]);
    }
    return body.join('\n').trim();
}

// 괄호 안내문구·번호(1. 2.)·기호만 있으면 빈칸으로 간주
function isBlankReportField(value: string | null): boolean {
    if (value === null) return true;
    const stripped = value
        .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
        .replace(/^\s*\d+\s*[.)]/gm, '')
        .replace(/[\s\-_.·~:：xX]/g, '');
    return stripped.length === 0;
}

function extractNextMeetingRaw(text: string): string | null {
    const match = text.match(/다음\s*(?:만남일시|만남\s*일시|만남일|만남\s*일|만남|일정)\s*[:：\-]?\s*([^\n\r]+)/i);
    return match && match[1] ? match[1].trim() : null;
}

// students."단계" 진행 순서 (첫 글자 기준: 발 → 찾 → 합 → 섭)
const STUDENT_STAGE_ORDER = ['발', '찾', '합', '섭'] as const;

function getStudentStageRank(stage: unknown): number {
    const first = String(stage ?? '').trim().charAt(0);
    return STUDENT_STAGE_ORDER.indexOf(first as (typeof STUDENT_STAGE_ORDER)[number]);
}

// 단계별 등록일 조회 (예: '찾' → 찾_등록일 / 찾등록일 / 찾*등록* / 찾*일 순으로 탐색)
function getStageRegDate(row: Record<string, any>, prefix: string): string | null {
    const keys = Object.keys(row).filter((k) => k.startsWith(prefix));
    const ordered = [
        ...[`${prefix}_등록일`, `${prefix}등록일`].filter((k) => keys.includes(k)),
        ...keys.filter((k) => k.includes('등록')),
        ...keys.filter((k) => k.endsWith('일')),
    ];
    for (const key of ordered) {
        const formatted = formatDateDisplay(row[key]);
        if (formatted !== '-') return formatted;
    }
    return null;
}

// students.target 값을 'n월'로 표시 (숫자 / 날짜 / 'n월' 문자 모두 지원)
function formatTargetMonth(raw: unknown): string {
    if (raw === undefined || raw === null || String(raw).trim() === '') return '미설정';
    const month = getTargetMonthNumber(raw);
    return month ? `${month}월` : escapeHtml(String(raw).trim());
}

// students.target 값에서 월(1~12) 추출, 판별 불가 시 null
function getTargetMonthNumber(raw: unknown): number | null {
    if (raw === undefined || raw === null) return null;
    if (raw instanceof Date) return raw.getMonth() + 1;
    const str = String(raw).trim();
    if (!str) return null;
    if (/^\d{1,2}\s*월?$/.test(str)) {
        const n = parseInt(str, 10);
        return n >= 1 && n <= 12 ? n : null;
    }
    const d = dayjs(str);
    return d.isValid() ? d.month() + 1 : null;
}

// '관리자 n월 ...' 입력의 월 필터 (월 미입력 시 전체)
function filterByTargetMonth<T extends { student_target?: unknown }>(chats: T[], month: number | null): T[] {
    return month ? chats.filter((c) => getTargetMonthNumber(c.student_target) === month) : chats;
}

function parseMonthArg(raw?: string): number | null {
    const n = raw ? parseInt(raw, 10) : NaN;
    return n >= 1 && n <= 12 ? n : null;
}

async function sendChunkedList<T>(
    ctx: any,
    header: string,
    items: T[],
    renderItem: (item: T, globalIndex: number) => string,
    chunkSize = 15,
    lastMessageExtra: Record<string, unknown> = {}
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

        const isLast = i + chunkSize >= items.length;
        await ctx.reply(message, { parse_mode: 'HTML', ...(isLast ? lastMessageExtra : {}) });
    }
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err: unknown, ctx) => {
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
        } catch (err: unknown) {
            console.error('[방 제목 갱신 실패]:', getErrorMessage(err));
        }
    }
});

// 봇이 방에 추가되거나 퇴장당했을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id;

    if (status === 'member' || status === 'administrator') {
        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
        try {
            await ensureChatRecord(chatId, title);

            await ctx.reply(
                '👋 <b>상담/복음방 일정 관리 봇이 등록되었습니다.</b>\n\n' +
                    '먼저 대상자 매칭을 위해 아래 명령어를 입력해주세요:\n' +
                    '<code>/최초등록 섭외자/지역/팀/인도자</code>\n' +
                    '<i>(예: <code>/최초등록 홍길동/강북/1/강현정</code>)</i>',
                { parse_mode: 'HTML' }
            );
        } catch (err: unknown) {
            console.error('[방 등록 초기화 실패]:', getErrorMessage(err));
        }
    } else if (status === 'left' || status === 'kicked') {
        try {
            await neonPool.query(`DELETE FROM counseling_chats WHERE chat_id = $1;`, [String(chatId)]);
        } catch (err: unknown) {
            console.error('[방 퇴장 데이터 삭제 실패]:', getErrorMessage(err));
        }
    }
});

// 종합 도움말 (/start, /help, /도움말)
bot.hears(/^[\/!](start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>[상담/복음방 일정 관리 봇 안내]</b>\n\n' +
            '<b>1. 기본 설정 및 등록</b>\n' +
            '• <b>대상자 최초 등록</b>: <code>/최초등록 섭외자/지역/팀/인도자</code>\n' +
            '• <b>현재 방 상태 확인</b>: <code>/상태확인</code>\n' +
            '• <b>행정 등록 확인</b>: <code>/행정확인</code>\n' +
            '• <b>목표월 수정</b>: <code>/목표월수정 n월</code>\n\n' +
            '<b>2. 인터뷰 만남 단계</b>\n' +
            '• <b>사전 보고서 등록</b>: 채팅방에 <code>[인터뷰 사전 보고서]</code> 양식 전송\n' +
            '• <b>사전 보고서 양식</b>: <code>/인터뷰사전양식</code>\n' +
            '• <b>인터뷰 항목 개별 수정</b>:\n' +
            '   - 인터뷰어: <code>/인터뷰어 강북 1팀 귀요미</code>\n' +
            '   - 타이퍼: <code>/타이퍼 강북 1팀 김공주</code> (해제: <code>/타이퍼 없음</code>)\n' +
            '   - 예정일: <code>/인터뷰일 MM-DD</code>\n' +
            '• <b>결과 보고서 양식</b>: <code>/인터뷰사후양식</code>\n' +
            '   <i>(결과 보고서에서 [신청] 시 교사 만남으로 자동 전환)</i>\n\n' +
            '<b>3. 교사 만남 및 일정 관리</b>\n' +
            '• <b>만남일 설정</b>: <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>\n' +
            '• <b>만남 중단 처리</b>: <code>/만남중단 [상세 사유]</code> → 사유 버튼 선택\n' +
            '• <b>피드백 제출</b>: 메시지 내 <code>#피드백</code> 태그 포함\n' +
            '• <b>만남 보고서 양식</b>: <code>/만남보고서양식</code> 또는 <code>/교사만남양식</code>\n' +
            '• <b>만남 보고서 제출</b>: 양식 내 <code>다음만남일: MM-DD</code> 포함\n\n' +
            '<b>4. 방 진행 단계 (특수 구분)</b>\n' +
            '• <b>단계 설정</b>: <code>/섭등목표 MM-DD</code>, <code>/예정목표 MM-DD</code>, <code>/가능목표 MM-DD</code>, <code>/확정목표 MM-DD</code> (날짜만 입력)\n' +
            '• <b>단계 해제</b>: <code>/구분해제</code> (일반 상태로 복귀)\n\n' +
            '👑 <b>관리자 전용 명령어</b>\n' +
            '• <b>인터뷰 예정건 모아보기</b>: <code>관리자 인터뷰</code>\n' +
            '• <b>교사 만남 진행건 모아보기</b>: <code>관리자 교사</code>\n' +
            '• <b>만남 명단 조회</b>: <code>관리자 오늘만남</code>, <code>관리자 내일만남</code>, <code>관리자 일자만남 MM-DD</code>\n' +
            '• <b>보고서 미제출 명단</b>: <code>관리자 미제출</code>\n' +
            '• <b>미등록 및 미정 방 조회</b>: <code>관리자 미등록</code>\n' +
            '• <b>만남일 경과 미갱신 방</b>: <code>관리자 미갱신</code>\n' +
            '• <b>합등 이상 봇 미초대 명단</b>: <code>관리자 미초대</code>\n' +
            '• <b>만남 중단 방 목록</b>: <code>관리자 중단</code>\n' +
            '• <b>특수 구분 현황 (3가지 종합)</b>: <code>관리자 구분</code>\n' +
            '• <b>구분별 단독 조회</b>: <code>관리자 n월 섭등목표</code>, <code>관리자 n월 예정목표</code>, <code>관리자 n월 가능목표</code>, <code>관리자 n월 확정목표</code>\n' +
            '• <b>일반방 조회 (특수 3종 및 중단 제외)</b>: <code>관리자 n월 일반</code>\n' +
            '   <i>(n월 = 대상자 목표월, 생략 시 전체)</i>\n' +
            '• <b>전체 종합 관리 현황</b>: <code>관리자 점검</code>',
        { parse_mode: 'HTML' }
    );
});

// 섭외자 최초 등록 (/최초등록 섭외자/지역/팀/인도자)
bot.hears(/^[\/!]최초등록(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️️ <b>입력 양식이 올바르지 않습니다.</b>\n\n' +
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
    } catch (err: unknown) {
        console.error('[최초등록 JOIN 매칭 에러]:', err);
        await ctx.reply(`⚠️ DB 매칭 조회 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 버튼 콜백: 만남 유형 선택
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
    } catch (err: unknown) {
        console.error('[type_interview 에러]:', err);
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
    } catch (err: unknown) {
        console.error('[type_teacher 에러]:', err);
    }
});

// 인터뷰 사전 보고서 양식 출력 (/인터뷰사전양식)
// 예시는 일반 텍스트로 보여주고, 탭하여 복사되는 <code> 블록은 빈 양식만 제공
bot.hears(/^[\/!](인터뷰사전양식|사전양식|사전보고서양식)(?:@\w+)?$/i, async (ctx) => {
    const example =
        `[인터뷰 사전 보고서]\n` +
        `• 인터뷰어: 강북 1팀 귀요미\n` +
        `• 타이퍼: 강북 1팀 김공주\n` +
        `• 인터뷰일시: 10-12\n` +
        `• 사전메모: 마음 문 열려 있음`;
    const blank =
        `[인터뷰 사전 보고서]\n` +
        `• 인터뷰어: \n` +
        `• 타이퍼: \n` +
        `• 인터뷰일시: \n` +
        `• 사전메모: `;

    await ctx.reply(
        `📋 <b>[인터뷰 사전 보고서 양식]</b>\n\n` +
            `✏️ <b>작성 예시</b>\n` +
            `<i>${escapeHtml(example)}</i>\n\n` +
            `👇 <b>아래 빈 양식을 눌러 복사</b>한 뒤 작성하여 이 방에 전송해주세요.\n` +
            `<code>${escapeHtml(blank)}</code>\n\n` +
            `💡 <b>안내:</b>\n` +
            `• 인터뷰어/타이퍼는 <code>지역 팀 이름</code> 형태로 적어주시면 됩니다.\n` +
            `• 타이퍼가 없는 경우 <code>없음</code> 또는 <code>미지정</code>으로 작성하세요.`,
        { parse_mode: 'HTML' }
    );
});

// 인터뷰 결과(사후) 보고서 양식 출력 (/인터뷰사후양식)
// 예시는 일반 텍스트로 보여주고, 탭하여 복사되는 <code> 블록은 빈 양식만 제공
bot.hears(/^[\/!](인터뷰사후양식|사후양식|사후보고서양식)(?:@\w+)?$/i, async (ctx) => {
    const example =
        `[인터뷰 결과 보고서]\n` +
        `• 후속신청: 신청\n` +
        `• 미신청사유: (미신청 시 상세 사유 작성)\n` +
        `• 다음만남일: 10-15\n` +
        `• 종합소견: 말씀에 관심이 많고 질문을 적극적으로 함`;
    const blank =
        `[인터뷰 결과 보고서]\n` +
        `• 후속신청: \n` +
        `• 미신청사유: \n` +
        `• 다음만남일: \n` +
        `• 종합소견: `;

    await ctx.reply(
        `📋 <b>[인터뷰 결과 보고서 양식]</b>\n\n` +
            `✏️ <b>작성 예시</b>\n` +
            `<i>${escapeHtml(example)}</i>\n\n` +
            `👇 <b>아래 빈 양식을 눌러 복사</b>한 뒤 작성하여 이 방에 전송해주세요.\n` +
            `<code>${escapeHtml(blank)}</code>\n\n` +
            `💡 <b>안내:</b>\n` +
            `• 후속신청: <b>신청</b> ➔ 다음 교사 만남 일정으로 자동 인계됩니다.\n` +
            `• 후속신청: <b>미신청</b> ➔ 사유가 저장되고 방이 중단 처리됩니다.`,
        { parse_mode: 'HTML' }
    );
});

// 만남(상담·복음방) 보고서 양식 출력 (/만남보고서양식, /교사만남양식)
const MEETING_REPORT_TEMPLATE = [
    '🏷 상담,복음방 보고서 ',
    '',
    '',
    '▪️섭-인-교 : ',
    '▪️목표개강월 : ',
    '▪️만남일시 : ',
    '▪️만남장소 :  ',
    '▪️총 횟수 : ',
    ' ',
    '',
    '▶️ 발굴 경로',
    '-',
    '',
    '▶️ 교사 컨셉',
    '-',
    '',
    '▶️ 진행 내역(누적)',
    '1. ',
    '2. ',
    '',
    '▶️ 단계향상 목표 및 달성여부',
    '항목(단계향상점검표 기반)/',
    '',
    '▶️ 진행내용',
    '1. ',
    '',
    '',
    '▶️ 상담반응 및 특이사항',
    '',
    '',
    '▶️ 섭외자 느낀점  (그대로의 반응) ',
    '',
    '',
    '▶️입막음',
    '',
    '',
    '▶️ 다음만남일 : ',
    '',
    '',
    '',
    '',
    '🖤 해결해야 할 것',
    '1. 주 3회/',
    '2. 8개월 따기/',
    '3. 침요소 파악/ ',
    '4. 환경변화요소 파악/',
].join('\n');

bot.hears(/^[\/!](만남보고서양식|교사만남양식|만남양식|보고서양식)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        `📋 <b>[상담·복음방 보고서 양식]</b>\n` +
            `👇 아래 양식을 눌러 복사한 뒤 작성하여 이 방에 전송해주세요.\n` +
            `<i>(진행내용, 상담반응 및 특이사항은 필수 작성 항목입니다)</i>\n\n` +
            `<pre>${escapeHtml(MEETING_REPORT_TEMPLATE)}</pre>`,
        { parse_mode: 'HTML' }
    );
});

// 인터뷰어 개별 수정 (/인터뷰어 [지역 팀 이름])
bot.hears(/^[\/!](인터뷰어|인터뷰어수정|인터뷰어변경)(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[2]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️ 변경할 인터뷰어 정보를 입력해주세요.\n' +
                '예: <code>/인터뷰어 강북 1팀 귀요미</code> 또는 <code>/인터뷰어 강북/1/귀요미</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const info = parseMemberString(rawInput);
    if (!info) {
        await ctx.reply(
            '⚠️ 형식 오류입니다. <code>지역 팀 이름</code> 형태로 입력해주세요.\n(예: <code>/인터뷰어 강북 1팀 귀요미</code>)',
            {
                parse_mode: 'HTML',
            }
        );
        return;
    }

    try {
        const member = await findMemberFromDB(info.name, info.region, info.team);
        if (!member) {
            await ctx.reply(`❌ DB에서 인터뷰어를 찾을 수 없습니다: ${escapeHtml(rawInput)}`, { parse_mode: 'HTML' });
            return;
        }

        const infoStr = `${member['지역']} ${member['구역']} ${member['이름']}`;
        await updateChat(ctx.chat.id, {
            meeting_type: '인터뷰',
            interviewer_name: member['이름'],
            interviewer_code: member['고유번호'],
            interviewer_info: infoStr,
        });

        await ctx.reply(
            `🎙️ <b>인터뷰어가 성공적으로 수정되었습니다!</b>\n\n` +
                `• <b>담당 인터뷰어</b>: <b>${escapeHtml(member['이름'])}</b> (${escapeHtml(
                    member['지역']
                )} / ${escapeHtml(member['구역'])})`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/인터뷰어 개별 수정 에러]:', err);
        await ctx.reply(`⚠ 인터뷰어 수정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 타이퍼 개별 수정 (/타이퍼 [지역 팀 이름] 또는 /타이퍼 없음)
bot.hears(/^[\/!](타이퍼|타이퍼수정|타이퍼변경)(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[2]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️ 변경할 타이퍼 정보를 입력해주세요.\n' +
                '• 지정: <code>/타이퍼 강북 1팀 김공주</code>\n' +
                '• 해제: <code>/타이퍼 없음</code> 또는 <code>/타이퍼 미지정</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (/^(없음|미지정|해제|\-|X)$/i.test(rawInput)) {
        try {
            await updateChat(ctx.chat.id, {
                typer_name: null,
                typer_code: null,
                typer_info: null,
            });
            await ctx.reply('⌨️ <b>타이퍼가 [미지정]으로 해제되었습니다.</b>', { parse_mode: 'HTML' });
        } catch (err: unknown) {
            console.error('[/타이퍼 해제 에러]:', getErrorMessage(err));
            await ctx.reply(`⚠️ 타이퍼 해제 중 오류 발생: ${getErrorMessage(err)}`);
        }
        return;
    }

    const info = parseMemberString(rawInput);
    if (!info) {
        await ctx.reply(
            '⚠️ 형식 오류입니다. <code>지역 팀 이름</code> 형태로 입력해주세요.\n(예: <code>/타이퍼 강북 1팀 김공주</code>)',
            {
                parse_mode: 'HTML',
            }
        );
        return;
    }

    try {
        const member = await findMemberFromDB(info.name, info.region, info.team);
        if (!member) {
            await ctx.reply(`❌ DB에서 타이퍼를 찾을 수 없습니다: ${escapeHtml(rawInput)}`, { parse_mode: 'HTML' });
            return;
        }

        const infoStr = `${member['지역']} ${member['구역']} ${member['이름']}`;
        await updateChat(ctx.chat.id, {
            typer_name: member['이름'],
            typer_code: member['고유번호'],
            typer_info: infoStr,
        });

        await ctx.reply(
            `⌨️ <b>타이퍼가 성공적으로 수정되었습니다!</b>\n\n` +
                `• <b>담당 타이퍼</b>: <b>${escapeHtml(member['이름'])}</b> (${escapeHtml(
                    member['지역']
                )} / ${escapeHtml(member['구역'])})`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/타이퍼 개별 수정 에러]:', err);
        await ctx.reply(`⚠️ 타이퍼 수정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 인터뷰 예정일 개별 수정 (/인터뷰일 [MM-DD])
bot.hears(/^[\/!](인터뷰일|인터뷰일자|인터뷰일정)(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[2]?.trim();
    if (!rawInput) {
        await ctx.reply('⚠️ 날짜를 입력해주세요.\n예: <code>/인터뷰일 10-12</code> 또는 <code>/인터뷰일 미정</code>', {
            parse_mode: 'HTML',
        });
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    try {
        if (rawInput.includes('미정')) {
            await upsertMeetingDate(ctx.chat.id, title, '미정');
            await updateChat(ctx.chat.id, { meeting_type: '인터뷰', interview_date: '미정' });
            await ctx.reply('📌 <b>인터뷰 일정이 [미정]으로 변경되었습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const formatted = parseFlexibleDate(rawInput);
        if (!formatted) {
            await ctx.reply('⚠️ 올바른 날짜 형식이 아닙니다. (예: 10-12, 10/12, 2026-10-12)');
            return;
        }

        await upsertMeetingDate(ctx.chat.id, title, formatted);
        await updateChat(ctx.chat.id, { meeting_type: '인터뷰', interview_date: formatted });

        await ctx.reply(`🎙️ <b>인터뷰 예정일이 [${formatted}]로 변경되었습니다!</b>`, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[/인터뷰일 수정 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 인터뷰 일정 수정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 매칭 해제 (/매칭해제)
bot.hears(/^[\/!]매칭해제(?:@\w+)?$/i, async (ctx) => {
    try {
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
            stop_category: null,
            interview_report_submitted: 0,
        });
        await ctx.reply('✅ 대상자 매칭 및 인터뷰 설정이 모두 초기화되었습니다.');
    } catch (err: unknown) {
        console.error('[/매칭해제 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 매칭 해제 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 행정 등록 내역 확인 (/행정확인)
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
                m."구역" AS guide_district,
                t."이름" AS teacher_name,
                t."지역" AS teacher_region,
                t."구역" AS teacher_district
            FROM students s
            LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
            LEFT JOIN members t ON s."교사_고유번호" = t."고유번호"
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

        // 단계별 표시 대상: 발 → 발 / 찾 → 발,찾 / 합·섭 → 발,찾,합
        const rank = getStudentStageRank(s['단계']);
        const targetPrefixes: string[] =
            rank < 0 ? [] : STUDENT_STAGE_ORDER.slice(0, Math.min(rank, 2) + 1);

        let msg = `📑 <b>[${studentName}] 행정 등록 현황</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n`;
        msg += `• <b>담당 인도자</b>: ${guideInfo}\n`;
        msg += `• <b>현재 단계</b>: <b>${stage}</b>\n`;
        if (getStudentStageRank(s['단계']) >= 2) {
            msg += `• <b>교사</b>: ${teacherText(s)}\n`;
        }
        msg += `• <b>목표월</b>: ${formatTargetMonth(s.target)}\n\n`;

        msg += `🗓 <b>[단계별 등록일]</b>\n`;

        if (targetPrefixes.length > 0) {
            for (const prefix of targetPrefixes) {
                const regDate = getStageRegDate(s, prefix);
                msg += `• ${prefix}_등록일: <b>${regDate ? escapeHtml(regDate) : '미등록'}</b>\n`;
            }
        } else {
            // 단계를 알 수 없는 경우: 기록된 단계 등록일만 표시
            let foundDateCount = 0;
            for (const prefix of STUDENT_STAGE_ORDER) {
                const regDate = getStageRegDate(s, prefix);
                if (regDate) {
                    msg += `• ${prefix}_등록일: <b>${escapeHtml(regDate)}</b>\n`;
                    foundDateCount++;
                }
            }
            if (foundDateCount === 0) {
                msg += `• 등록된 행정 등록 일자 기록이 없습니다.\n`;
            }
        }

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[/행정확인 에러]:', err);
        await ctx.reply(`⚠️ 행정 확인 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// students.target 컬럼 타입 (숫자/날짜/문자에 따라 저장 형식이 다름)
let studentTargetColumnType: string | null = null;
async function getStudentTargetColumnType(): Promise<string> {
    if (studentTargetColumnType) return studentTargetColumnType;
    const res = await neonPool.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'target' LIMIT 1;`
    );
    if (res.rows.length === 0) throw new Error('students 테이블에 target 컬럼이 없습니다.');
    studentTargetColumnType = String(res.rows[0].data_type);
    return studentTargetColumnType;
}

// 목표월 수정 (/목표월수정 n월)
bot.hears(/^[\/!]목표월(?:\s*(?:수정|변경|설정))?(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim() || '';
    const monthMatch = rawInput.match(/^(\d{1,2})\s*월?$/);
    const month = monthMatch ? Number(monthMatch[1]) : NaN;

    if (!(month >= 1 && month <= 12)) {
        await ctx.reply(
            '⚠️ <b>입력 양식이 올바르지 않습니다.</b>\n\n' +
                '• <b>입력 양식</b>: <code>/목표월수정 n월</code> (1~12)\n' +
                '• <b>입력 예시</b>: <code>/목표월수정 11월</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    try {
        const chat = await getChatRecord(ctx.chat.id);
        if (!chat || !chat.matched_member_id) {
            await ctx.reply(
                '⚠️ <b>매칭된 대상자가 없습니다.</b>\n\n먼저 <code>/최초등록 섭외자/지역/팀/인도자</code>로 등록해주세요.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const columnType = await getStudentTargetColumnType();
        let value: string | number;
        if (/int|numeric|real|double/.test(columnType)) {
            value = month;
        } else if (/date|timestamp/.test(columnType)) {
            // 이번 달보다 이전 월이면 내년으로 간주
            const now = dayjs().tz('Asia/Seoul');
            const year = month < now.month() + 1 ? now.year() + 1 : now.year();
            value = `${year}-${String(month).padStart(2, '0')}-01`;
        } else {
            value = `${month}월`;
        }

        const res = await neonPool.query(
            `UPDATE students SET target = $1 WHERE id::text = $2::text RETURNING "이름";`,
            [value, chat.matched_member_id]
        );

        if (res.rows.length === 0) {
            await ctx.reply('❌ <b>DB에서 대상자 정보를 찾을 수 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        await ctx.reply(
            `✅ <b>[${escapeHtml(res.rows[0]['이름'] || '대상자')}] 목표월이 ${month}월로 수정되었습니다.</b>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/목표월수정 에러]:', err);
        await ctx.reply(`⚠️ 목표월 수정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 개별 방 상태 확인 (/상태확인)
bot.hears(/^[\/!]상태확인(?:@\w+)?$/i, async (ctx) => {
    try {
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
              record.progress_note ? ` (${record.progress_stage}일: ${formatStageDate(record.progress_note)})` : ''
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
    } catch (err: unknown) {
        console.error('[/상태확인 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 상태 확인 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 만남 중단 설정 (/만남중단 [상세 사유]) → 사유 분류 버튼 선택 시 중단 처리
const STOP_DETAIL_LABEL = '상세 사유: ';

bot.hears(/^[\/!]만남중단(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const detail = ctx.match[1]?.trim() || '';
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    try {
        await ensureChatRecord(ctx.chat.id, title);
        await ctx.reply(
            `🛑 <b>만남 중단 사유를 선택해주세요.</b>\n` +
                (detail ? `• ${STOP_DETAIL_LABEL}${escapeHtml(detail)}\n` : '') +
                `\n<i>버튼을 누르면 중단 처리됩니다. 상세 사유는 <code>/만남중단 상세내용</code>으로 함께 남길 수 있습니다.</i>`,
            { parse_mode: 'HTML', reply_markup: buildStopCategoryKeyboard('stop') }
        );
    } catch (err: unknown) {
        console.error('[/만남중단 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 만남 중단 처리 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 버튼 콜백: 만남 중단 사유 선택
bot.action(/^stop:(\w+)$/, async (ctx) => {
    try {
        const code = ctx.match[1];
        if (code === 'cancel') {
            await ctx.answerCbQuery('취소되었습니다.');
            await ctx.editMessageText('↩️ 만남 중단이 취소되었습니다.');
            return;
        }

        const label = getStopCategoryLabel(code);
        if (!label || !ctx.chat) {
            await ctx.answerCbQuery('알 수 없는 선택입니다.');
            return;
        }

        // 상세 사유는 안내 메시지 본문에서 복원 (서버 재시작에도 안전)
        const msg = ctx.callbackQuery.message;
        const msgText = msg && 'text' in msg ? msg.text : '';
        const detailLine = msgText.split('\n').find((l) => l.includes(STOP_DETAIL_LABEL));
        const detail = detailLine
            ? detailLine.slice(detailLine.indexOf(STOP_DETAIL_LABEL) + STOP_DETAIL_LABEL.length).trim()
            : '';
        const reason = detail ? `${label} - ${detail}` : label;

        await updateChat(ctx.chat.id, {
            meeting_date: '중단',
            stop_reason: reason,
            stop_category: label,
            feedback_submitted: 0,
            report_submitted: 0,
            d_minus_1_notified: 0,
            d_day_22_notified: 0,
            overdue_1_notified: 0,
            overdue_2_notified: 0,
        });

        await ctx.answerCbQuery(`${label}(으)로 중단 처리되었습니다.`);
        await ctx.editMessageText(
            `🛑 <b>만남 일정이 [중단] 처리되었습니다.</b>\n\n` +
                `• <b>중단 사유</b>: <b>${escapeHtml(label)}</b>\n` +
                (detail ? `• <b>상세 사유</b>: ${escapeHtml(detail)}\n` : '') +
                `\n💡 만남이 재개되면 <code>/만남일 MM-DD</code>를 입력하여 새 일정을 등록해주세요.`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[만남 중단 사유 선택 에러]:', getErrorMessage(err));
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

// 버튼 콜백: 인터뷰 후속 미신청 사유 선택 (미신청 처리는 보고서 접수 시 이미 완료됨)
bot.action(/^fu:(\w+)$/, async (ctx) => {
    try {
        const label = getStopCategoryLabel(ctx.match[1]);
        if (!label || !ctx.chat) {
            await ctx.answerCbQuery('알 수 없는 선택입니다.');
            return;
        }

        const record = await getChatRecord(ctx.chat.id);
        const detail = record?.follow_up_reason && record.follow_up_reason !== '사유 미입력' ? record.follow_up_reason : '';

        await updateChat(ctx.chat.id, {
            stop_category: label,
            stop_reason: `인터뷰 후속 미신청: ${detail ? `${label} - ${detail}` : label}`,
        });

        await ctx.answerCbQuery(`${label}(으)로 저장되었습니다.`);
        await ctx.editMessageText(
            `🛑 <b>인터뷰 결과 보고서가 반영되었습니다.</b>\n\n` +
                `• <b>후속 신청</b>: <b>미신청</b>\n` +
                `• <b>미신청 사유</b>: <b>${escapeHtml(label)}</b>\n` +
                (detail ? `• <b>상세 사유</b>: ${escapeHtml(detail)}\n` : '') +
                `• <b>대화방 상태</b>: 만남 중단 처리됨`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[미신청 사유 선택 에러]:', getErrorMessage(err));
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

// 만남일 수동 설정 (/만남일 MM-DD, 만남일 미정 등)
bot.hears(/^[\/!]만남일(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply(
            '⚠️️ 날짜를 함께 입력해주세요.\n예: <code>/만남일 09-24</code> 또는 <code>/만남일 미정</code>',
            {
                parse_mode: 'HTML',
            }
        );
        return;
    }

    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    try {
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
    } catch (err: unknown) {
        console.error('[/만남일 설정 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 만남일 설정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 방 구분 설정 (/섭등목표, /예정목표, /가능목표, /확정목표 MM-DD) — 날짜만 허용
bot.hears(new RegExp(`^[\\/!](${STAGE_COMMAND_ALT})(?:@\\w+)?(?:\\s+(.+))?$`, 'i'), async (ctx) => {
    const stage = normalizeStage(ctx.match[1]);
    const rawDate = ctx.match[2]?.trim() || '';
    const stageDate = parseFlexibleDate(rawDate);
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    if (!stageDate) {
        await ctx.reply(
            `⚠️ <b>${stage} 날짜를 입력해주세요.</b> (날짜만 입력 가능)\n\n` +
                `• <b>입력 양식</b>: <code>/${stage} MM-DD</code>\n` +
                `• <b>입력 예시</b>: <code>/${stage} 10-15</code>, <code>/${stage} 10월15일</code>` +
                (rawDate ? `\n\n❌ 인식하지 못한 입력: ${escapeHtml(rawDate)}` : ''),
            { parse_mode: 'HTML' }
        );
        return;
    }

    try {
        await ensureChatRecord(ctx.chat.id, title);
        await updateChat(ctx.chat.id, {
            progress_stage: stage,
            progress_note: stageDate,
        });

        let replyMsg = `📌 <b>대화방 구분이 [${stage}]으로 설정되었습니다.</b>\n`;
        replyMsg += `• ${stage}일: <b>${formatStageDate(stageDate)}</b>\n`;
        replyMsg += `\n💡 일반 상태로 복귀하려면 <code>/구분해제</code>를 입력하세요.`;

        await ctx.reply(replyMsg, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[방 구분 설정 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 구분 설정 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 방 구분 해제 (/구분해제, /일반)
bot.hears(/^[\/!](구분해제|일반)(?:@\w+)?$/i, async (ctx) => {
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    try {
        await ensureChatRecord(ctx.chat.id, title);

        await updateChat(ctx.chat.id, {
            progress_stage: '',
            progress_note: '',
        });

        await ctx.reply('✅ <b>특수 구분이 해제되어 [일반] 상태로 전환되었습니다.</b>', { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[구분 해제 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 구분 해제 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

/* =====================================================
 * 👑 관리자 전용 명령어 핸들러 (인터뷰 / 교사 분리 체계)
 * ===================================================== */

// [신규] 관리자 인터뷰 예정건 전체 모아보기
bot.hears(/^(?:[\/!]?관리자\s+)(인터뷰|인터뷰예정|인터뷰목록|인터뷰건)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ <b>접근 권한이 없습니다.</b> 관리자만 사용할 수 있습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const interviewChats = allChats
            .filter((c) => c.meeting_type === '인터뷰' && c.meeting_date !== '중단')
            .sort((a, b) => {
                if (!a.meeting_date || a.meeting_date === '미정') return 1;
                if (!b.meeting_date || b.meeting_date === '미정') return -1;
                return dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf();
            });

        if (interviewChats.length === 0) {
            await ctx.reply('✨ <b>현재 진행 중인 인터뷰 만남 일정이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `🎙️ <b>[인터뷰 예정건 목록] (총 ${interviewChats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, interviewChats, (chat, idx) => {
            const studentName = chat.matched_student_name
                ? `👤 <b>${escapeHtml(chat.matched_student_name)}</b>`
                : '미매칭';
            const interviewer = chat.interviewer_info ? escapeHtml(chat.interviewer_info) : '⚠️ 미등록';
            const typer = chat.typer_info ? escapeHtml(chat.typer_info) : '미지정';

            let dateDisplay = '미등록';
            if (chat.meeting_date === '미정') {
                dateDisplay = '⚠️️ 일정 미정';
            } else if (chat.meeting_date) {
                const mDate = dayjs(chat.meeting_date).startOf('day');
                const diff = mDate.diff(today, 'day');
                const dDayStr = diff === 0 ? '오늘' : diff > 0 ? `D-${diff}` : `${Math.abs(diff)}일 경과`;
                dateDisplay = `${mDate.format('YYYY-MM-DD')} (${dDayStr})`;
            }

            return (
                `<b>${idx}. ${studentName}</b> [${escapeHtml(chat.room_title || '대화방')}]\n` +
                `   • 인터뷰일: <b>${dateDisplay}</b>\n` +
                `   • 인터뷰어: ${interviewer}\n` +
                `   • 타이퍼: ${typer}\n` +
                `   • 담당인도자: ${escapeHtml(chat.guide_name || '-')} (${escapeHtml(
                    chat.guide_region || ''
                )} ${escapeHtml(chat.guide_district || '')})\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[관리자 인터뷰 조회 에러]:', err);
    }
});

// [신규] 관리자 교사 만남 진행건 전체 모아보기
bot.hears(/^(?:[\/!]?관리자\s+)(교사|교사만남|교사목록|교사건)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ <b>접근 권한이 없습니다.</b> 관리자만 사용할 수 있습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const teacherChats = allChats
            .filter((c) => c.meeting_type === '교사' && c.meeting_date !== '중단')
            .sort((a, b) => {
                if (!a.meeting_date || a.meeting_date === '미정') return 1;
                if (!b.meeting_date || b.meeting_date === '미정') return -1;
                return dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf();
            });

        if (teacherChats.length === 0) {
            await ctx.reply('✨ <b>현재 진행 중인 교사 만남 일정이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `👨‍🏫 <b>[교사 만남 진행건 목록] (총 ${teacherChats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, teacherChats, (chat, idx) => {
            const studentName = chat.matched_student_name
                ? `👤 <b>${escapeHtml(chat.matched_student_name)}</b>`
                : '미매칭';
            const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
            const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기';
            const stageBadge = chat.progress_stage ? ` [🏷 ${chat.progress_stage}]` : '';

            let dateDisplay = '미등록';
            if (chat.meeting_date === '미정') {
                dateDisplay = '⚠️ 일정 미정';
            } else if (chat.meeting_date) {
                const mDate = dayjs(chat.meeting_date).startOf('day');
                const diff = mDate.diff(today, 'day');
                const dDayStr = diff === 0 ? '오늘' : diff > 0 ? `D-${diff}` : `${Math.abs(diff)}일 경과`;
                dateDisplay = `${mDate.format('YYYY-MM-DD')} (${dDayStr})`;
            }

            return (
                `<b>${idx}. ${studentName}</b>${stageBadge} [${escapeHtml(chat.room_title || '대화방')}]\n` +
                `   • 다음만남일: <b>${dateDisplay}</b>\n` +
                `   • 사전피드백: ${feedbackBadge} / 만남보고서: ${reportBadge}\n` +
                `   • 담당인도자: ${escapeHtml(chat.guide_name || '-')} (${escapeHtml(
                    chat.guide_region || ''
                )} ${escapeHtml(chat.guide_district || '')})\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[관리자 교사 조회 에러]:', err);
    }
});

// 날짜별 만남 조회 (관리자 오늘만남, 관리자 내일만남, 관리자 일자만남 MM-DD)
bot.hears(
    /^(?:[\/!]?관리자(?:\s+(?!\d{1,2}\s*월\s*(?:섭등목표|예정목표|가능목표|확정목표|섭등예정|예정가능일|가능가능일|일반|일반방|미분류)$)(?!(?:미초대|봇미초대|초대누락|미제출|미등록|미정|미갱신|최초미등록|점검|현황|중단|구분|단계|특수|섭등목표|예정목표|가능목표|확정목표|섭등예정|예정가능일|가능가능일|일반|일반방|미분류|인터뷰|인터뷰예정|인터뷰목록|인터뷰건|교사|교사만남|교사목록|교사건))(.+))?|[\/!](?:만남명단|만남일정)(?:@\w+)?(?:\s+(.+))?)$/i,
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
                const isInterview = chat.meeting_type === '인터뷰';
                const typeBadge = isInterview
                    ? ' [🎙️ 인터뷰]'
                    : chat.meeting_type === '교사'
                    ? ' [👨‍🏫 교사]'
                    : ' [미선택]';
                const stageBadge = chat.progress_stage ? ` [🏷 ${chat.progress_stage}]` : '';
                const memberBadge = chat.matched_student_name
                    ? ` (👤 ${escapeHtml(chat.matched_student_name)} / 인도자: ${escapeHtml(chat.guide_name || '-')})`
                    : '';

                let detailLine = '';
                if (isInterview) {
                    detailLine = `   • 인터뷰어: ${escapeHtml(
                        chat.interviewer_info || '미등록'
                    )} / 타이퍼: ${escapeHtml(chat.typer_info || '미지정')}\n`;
                } else {
                    const feedbackBadge = chat.feedback_submitted ? '✅ 완료' : '❌ 미제출';
                    const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기 중';
                    detailLine = `   • 사전 피드백: ${feedbackBadge} / 만남 보고서: ${reportBadge}\n`;
                }

                return (
                    `<b>${idx}. ${escapeHtml(
                        chat.room_title || '대화방'
                    )}${memberBadge}${typeBadge}${stageBadge}</b>\n` +
                    detailLine +
                    `\n`
                );
            });
        } catch (err: unknown) {
            console.error('[만남 명단 조회 에러]:', err);
        }
    }
);

// 보고서 미제출 명단 (관리자 미제출)
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
    } catch (err: unknown) {
        console.error('[미제출 명단 조회 에러]:', err);
    }
});

// 미등록 및 미정 방 조회 (관리자 미등록)
bot.hears(
    /^(?:[\/!]?관리자\s+)(최초\s*미등록|미등록\s*명단|미등록|신규\s*미등록|미정|미정\s*만남|미정\s*명단)$/i,
    async (ctx) => {
        try {
            const userId = String(ctx.from?.id);
            if (!isAdmin(userId)) {
                await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
                return;
            }

            const today = dayjs().tz('Asia/Seoul').startOf('day');
            const allChats = await getAllChats();

            const unassignedChats = allChats
                .filter((chat) => !chat.meeting_date || chat.meeting_date.trim() === '')
                .sort((a, b) => dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf());

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

            if (undecidedChats.length > 0) {
                message += `⏳ <b>[만남 예정일 미정 상태] (${undecidedChats.length}건)</b>\n`;
                undecidedChats.forEach((chat, index) => {
                    const updated = chat.updated_at
                        ? dayjs(chat.updated_at).tz('Asia/Seoul').format('MM/DD HH:mm')
                        : '-';
                    const memberBadge = chat.matched_student_name
                        ? ` (👤 ${escapeHtml(chat.matched_student_name)})`
                        : '';
                    const typeBadge = chat.meeting_type ? ` [${chat.meeting_type}]` : '';

                    message += `<b>${index + 1}. ${escapeHtml(
                        chat.room_title || '대화방'
                    )}</b>${memberBadge}${typeBadge}\n`;
                    message += `   • 상태: <b>만남일 미정 (일정 확정 필요)</b>\n`;
                    message += `   • 최근 변경: ${updated}\n`;
                    message += `   • Chat ID: <code>${chat.chat_id}</code>\n\n`;
                });
            }

            if (unassignedChats.length > 0) {
                message += `❓ <b>[초대 후 첫 만남일 미등록] (${unassignedChats.length}건)</b>\n`;
                unassignedChats.forEach((chat, index) => {
                    const created = chat.created_at ? dayjs(chat.created_at).tz('Asia/Seoul') : null;
                    let durationStr = '확인 불가';

                    if (created) {
                        const diffDays = today.diff(created.startOf('day'), 'day');
                        durationStr = diffDays === 0 ? '오늘 초대됨' : `${diffDays}일째 미등록`;
                    }
                    const memberBadge = chat.matched_student_name
                        ? ` (👤 ${escapeHtml(chat.matched_student_name)})`
                        : '';

                    message += `<b>${index + 1}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}\n`;
                    message += `   • 봇 초대일: ${
                        created ? created.format('YYYY-MM-DD') : '기록 없음'
                    } (${durationStr})\n`;
                    message += `   • Chat ID: <code>${chat.chat_id}</code>\n\n`;
                });
            }

            await ctx.reply(message, { parse_mode: 'HTML' });
        } catch (err: unknown) {
            console.error('[미등록/미정 조회 에러]:', err);
        }
    }
);

// 만남일 경과 후 미갱신 방 명단 (관리자 미갱신)
bot.hears(/^(?:[\/!]?관리자\s+)(미갱신\s*명단|미갱신|일정\s*미갱신)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const expiredChats = allChats
            .filter((chat) => {
                if (
                    !chat.meeting_date ||
                    chat.meeting_date.trim() === '' ||
                    chat.meeting_date === '미정' ||
                    chat.meeting_date === '중단'
                )
                    return false;
                const mDate = dayjs(chat.meeting_date).startOf('day');
                return mDate.isBefore(today);
            })
            .sort((a, b) => dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf());

        if (expiredChats.length === 0) {
            await ctx.reply('🎉 <b>일정이 만료되어 갱신되지 않은 대화방이 없습니다!</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `⌛ <b>[만남일 경과 후 미갱신 대화방] (총 ${expiredChats.length}건)</b>\n` +
            `<i>(이전 만남일이 지났으나 다음 일정이 설정되지 않음)</i>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, expiredChats, (chat, idx) => {
            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day');
            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            const typeBadge = chat.meeting_type ? ` [${chat.meeting_type}]` : '';

            return (
                `<b>${idx}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}${typeBadge}\n` +
                `   • 지난 만남일: ${mDate.format('YYYY-MM-DD')} (${diffDays}일 경과)\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[미갱신 명단 조회 에러]:', err);
    }
});

// 합등 이상인데 봇이 초대(매칭)된 방이 없는 대상자 (관리자 미초대)
bot.hears(/^(?:[\/!]?관리자\s+)(미초대|봇미초대|초대누락)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const res = await neonPool.query(`
            SELECT
                s.*,
                m."이름" AS guide_name,
                m."지역" AS guide_region,
                m."구역" AS guide_district,
                t."이름" AS teacher_name,
                t."지역" AS teacher_region,
                t."구역" AS teacher_district
            FROM students s
            LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
            LEFT JOIN members t ON s."교사_고유번호" = t."고유번호"
            WHERE LEFT(TRIM(COALESCE(s."단계"::text, '')), 1) IN ('합', '섭')
              AND NOT EXISTS (
                  SELECT 1 FROM counseling_chats c
                  WHERE c.matched_member_id::text = s.id::text
              )
            ORDER BY m."지역", m."구역", m."이름", s."이름";
        `);

        if (res.rows.length === 0) {
            await ctx.reply('✨ <b>합등 이상 대상자 중 봇이 초대되지 않은 건이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `📭 <b>[합등 이상 · 봇 미초대 명단] (총 ${res.rows.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `<i>(봇이 있어도 /최초등록 매칭이 안 된 방은 미초대로 집계됩니다)</i>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, res.rows, (s: Record<string, any>, idx) => {
            const guideInfo = s.guide_name
                ? `${escapeHtml(s.guide_name)} (${escapeHtml(s.guide_region || '')} ${escapeHtml(s.guide_district || '')})`
                : '미등록';
            const hapDate = getStageRegDate(s, '합');
            return (
                `<b>${idx}. ${escapeHtml(s['이름'] || '이름 없음')}</b> [${escapeHtml(s['단계'] || '-')}]\n` +
                `   • 인도자: ${guideInfo}\n` +
                `   • 교사: ${teacherText(s)}\n` +
                `   • 합_등록일: ${hapDate ? escapeHtml(hapDate) : '미등록'}\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[미초대 명단 조회 에러]:', err);
        await ctx.reply(`⚠️ 미초대 명단 조회 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 만남 중단 방 목록 (관리자 중단)
bot.hears(/^(?:[\/!]?관리자\s+)(중단\s*명단|중단|만남중단)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const allChats = await getAllChats();
        const stoppedChats = allChats
            .filter((chat) => chat.meeting_date === '중단')
            .sort((a, b) => dayjs(b.updated_at).valueOf() - dayjs(a.updated_at).valueOf());

        if (stoppedChats.length === 0) {
            await ctx.reply('✨ <b>현재 만남이 중단된 대화방이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const header =
            `🛑 <b>[만남 중단 대화방 목록] (총 ${stoppedChats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, stoppedChats, (chat, idx) => {
            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            return (
                `<b>${idx}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}\n` +
                `   • 중단 사유: <b>${escapeHtml(chat.stop_reason || '사유 미입력')}</b>\n` +
                `   • Chat ID: <code>${chat.chat_id}</code>\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[중단 명단 조회 에러]:', err);
    }
});

// 특수 구분 종합 현황 (관리자 구분, 관리자 단계)
bot.hears(/^(?:[\/!]?관리자\s+)(구분|단계|특수|진행구분)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const allChats = (await getAllChats()).filter(isHapOrAbove);
        const groups = PROGRESS_STAGES.map((stage) => ({
            stage,
            chats: allChats.filter((c) => c.progress_stage === stage),
        }));
        const totalSpecial = groups.reduce((sum, g) => sum + g.chats.length, 0);

        if (totalSpecial === 0) {
            await ctx.reply(`✨ <b>행정 합 이상 중 [${PROGRESS_STAGES.join(' / ')}]로 지정된 대화방이 없습니다.</b>`, {
                parse_mode: 'HTML',
            });
            return;
        }

        let msg = `🏷 <b>[진행 구분별 대화방 목록 · 행정 합 이상] (총 ${totalSpecial}건)</b>\n`;
        msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n\n`;

        for (const { stage, chats } of groups) {
            if (chats.length === 0) continue;
            msg += `${STAGE_EMOJI[stage]} <b>[${stage}] (${chats.length}건)</b>\n`;
            sortByStageDateDesc(chats).forEach((c, i) => {
                const note = ` (${stage}일: ${formatStageDate(c.progress_note)})`;
                const mDate = c.meeting_date ? ` [만남일: ${c.meeting_date}]` : '';
                const member = c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : '';
                msg += `${i + 1}. <b>${escapeHtml(c.room_title)}</b>${member}${mDate}${note}\n`;
                msg += `   └ 교사: ${teacherText(c)}\n`;
            });
            msg += `\n`;
        }

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[관리자 구분 조회 에러]:', err);
    }
});

// 구분별 단독 조회 (관리자 섭등목표 / 예정목표 / 가능목표 / 확정목표) — 정렬 버튼 지원
type StageSortMode = 'date' | 'target';

// 목표월순: 이번 달부터 가까운 순 (10월 기준 10 → 11 → 12 → 1 …), 목표월 없음은 맨 뒤 / 같은 달은 예정일 최신순
function sortByTargetMonth<T extends { student_target?: unknown; progress_note?: string }>(chats: T[]): T[] {
    const current = dayjs().tz('Asia/Seoul').month() + 1;
    const key = (c: T) => {
        const m = getTargetMonthNumber(c.student_target);
        return m ? (m - current + 12) % 12 : 99;
    };
    return sortByStageDateDesc(chats).sort((a, b) => key(a) - key(b));
}

async function sendStageList(ctx: any, stage: ProgressStage, month: number | null, mode: StageSortMode) {
    const monthLabel = month ? `${month}월 목표 ` : '';
    const allChats = await getAllChats();
    const filtered = filterByTargetMonth(
        allChats.filter((c) => c.progress_stage === stage && isHapOrAbove(c)),
        month
    );
    const targets = mode === 'target' ? sortByTargetMonth(filtered) : sortByStageDateDesc(filtered);

    if (targets.length === 0) {
        await ctx.reply(`✨ <b>행정 합 이상 중 [${monthLabel}${stage}] 상태인 대화방이 없습니다.</b>`, {
            parse_mode: 'HTML',
        });
        return;
    }

    const sortLabel = mode === 'target' ? '목표월순' : `${stage} 최신순`;
    const header =
        `🏷 <b>[${monthLabel}${stage} 대화방 목록 · 행정 합 이상] (총 ${targets.length}건, ${sortLabel})</b>\n` +
        `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
        (month ? '' : `💡 <code>관리자 10월 ${stage}</code>처럼 월을 붙이면 해당 목표월만 조회됩니다.\n`) +
        `━━━━━━━━━━━━━━━━━━\n\n`;

    const code = STAGE_CODES[stage];
    const m = month ?? 0;
    const sortButtons = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `${mode === 'date' ? '✅ ' : ''}📅 날짜순`, callback_data: `ssort:${code}:${m}:date` },
                    { text: `${mode === 'target' ? '✅ ' : ''}🎯 목표월순`, callback_data: `ssort:${code}:${m}:target` },
                ],
            ],
        },
    };

    await sendChunkedList(
        ctx,
        header,
        targets,
        (c, i) => {
            const memberBadge = c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : '';
            let itemStr = `<b>${i}. ${escapeHtml(c.room_title || '대화방')}</b>${memberBadge}\n`;
            itemStr += `   • ${stage}: <b>${formatStageDate(c.progress_note)}</b>\n`;
            if (!month) itemStr += `   • 목표월: <b>${formatTargetMonth(c.student_target)}</b>\n`;
            itemStr += `   • 교사: ${teacherText(c)}\n`;
            itemStr += `   • 만남일정: ${c.meeting_date || '일정 미등록'}\n`;
            itemStr += `   • Chat ID: <code>${c.chat_id}</code>\n\n`;
            return itemStr;
        },
        15,
        sortButtons
    );
}

bot.hears(new RegExp(`^(?:[\\/!]?관리자\\s+)(?:(\\d{1,2})\\s*월\\s*)?(${STAGE_COMMAND_ALT})$`, 'i'), async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }
        await sendStageList(ctx, normalizeStage(ctx.match[2]), parseMonthArg(ctx.match[1]), 'date');
    } catch (err: unknown) {
        console.error('[단계별 조회 에러]:', err);
    }
});

// 버튼 콜백: 구분별 목록 정렬 전환 (ssort:<구분코드>:<목표월|0>:<date|target>)
bot.action(/^ssort:(sub|yej|gan|hwa):(\d{1,2}):(date|target)$/, async (ctx) => {
    try {
        if (!isAdmin(String(ctx.from?.id))) {
            await ctx.answerCbQuery('관리자만 사용할 수 있습니다.');
            return;
        }
        const stage = PROGRESS_STAGES.find((k) => STAGE_CODES[k] === ctx.match[1])!;
        const mode = ctx.match[3] as StageSortMode;
        await ctx.answerCbQuery(mode === 'target' ? '목표월순으로 정렬합니다.' : '날짜순으로 정렬합니다.');
        await sendStageList(ctx, stage, parseMonthArg(ctx.match[2]), mode);
    } catch (err: unknown) {
        console.error('[구분 목록 정렬 에러]:', err);
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

// 일반방 조회 (관리자 일반 - 특수 3종 및 중단 제외)
bot.hears(/^(?:[\/!]?관리자\s+)(?:(\d{1,2})\s*월\s*)?(일반|일반방|미분류)$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const month = parseMonthArg(ctx.match[1]);
        const monthLabel = month ? `${month}월 목표 ` : '';
        const allChats = await getAllChats();
        const normalChats = filterByTargetMonth(
            allChats.filter(
                (c) =>
                    !isProgressStage(c.progress_stage) &&
                    c.meeting_date !== '중단'
            ),
            month
        );

        if (normalChats.length === 0) {
            await ctx.reply(`✨ <b>특수 단계 및 중단 상태를 제외한 ${monthLabel}일반 대화방이 없습니다.</b>`, {
                parse_mode: 'HTML',
            });
            return;
        }

        const header =
            `📋 <b>[${monthLabel}일반 대화방 목록 (특수 3종 및 중단 제외)] (총 ${normalChats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            (month ? '' : `💡 <code>관리자 10월 일반</code>처럼 월을 붙이면 해당 목표월만 조회됩니다.\n`) +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, normalChats, (chat, index) => {
            let statusText = chat.meeting_date;
            if (!statusText) statusText = '미등록';

            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            const safeTitle = escapeHtml(chat.room_title || '대화방');
            const reportBadge = chat.report_submitted ? '✅ 완료' : '⏳ 대기';

            return (
                `<b>${index}. ${safeTitle}</b>${memberBadge}\n` +
                `   • 현재 상태: <b>${statusText}</b> (보고서: ${reportBadge})\n` +
                (month ? '' : `   • 목표월: ${formatTargetMonth(chat.student_target)}\n`) +
                `   • Chat ID: <code>${chat.chat_id}</code>\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[일반방 조회 에러]:', err);
    }
});

// 전체 종합 점검 (관리자 점검)
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
        const overdue = allChats.filter((c) => {
            if (!c.meeting_date || c.meeting_date === '미정' || c.meeting_date === '중단' || c.report_submitted)
                return false;
            return (
                dayjs(c.meeting_date).startOf('day').isBefore(today) ||
                dayjs(c.meeting_date).startOf('day').isSame(today, 'day')
            );
        });
        const expired = allChats.filter((c) => {
            if (
                !c.meeting_date ||
                c.meeting_date.trim() === '' ||
                c.meeting_date === '미정' ||
                c.meeting_date === '중단'
            )
                return false;
            return dayjs(c.meeting_date).startOf('day').isBefore(today);
        });

        const normalCount = allChats.filter(
            (c) => !isProgressStage(c.progress_stage) && c.meeting_date !== '중단'
        ).length;

        const interviewCount = allChats.filter((c) => c.meeting_type === '인터뷰' && c.meeting_date !== '중단').length;
        const teacherCount = allChats.filter((c) => c.meeting_type === '교사' && c.meeting_date !== '중단').length;

        let msg = `📊 <b>[상담/복음방 전체 관리 현황]</b>\n`;
        msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        msg += `총 등록된 대화방: <b>${allChats.length}개</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n\n`;

        msg += `🎙️ <b>[진행 분류별 현황]</b>\n`;
        msg += `• 인터뷰 만남 진행: <b>${interviewCount}개 방</b> (조회: <code>관리자 인터뷰</code>)\n`;
        msg += `• 교사 만남 진행: <b>${teacherCount}개 방</b> (조회: <code>관리자 교사</code>)\n\n`;

        msg += `🏷 <b>[진행 단계별 현황]</b>\n`;
        for (const stage of PROGRESS_STAGES) {
            msg += `• ${stage}: <b>${allChats.filter((c) => c.progress_stage === stage).length}개</b>\n`;
        }
        msg += `• 일반(중단 제외): <b>${normalCount}개</b> (조회: <code>관리자 일반</code>)\n\n`;

        msg += `🗓 <b>[일정 및 보고서 상태]</b>\n`;
        msg += `• ❓ <b>첫 만남일 미등록</b>: ${unassigned.length}개 방\n`;
        msg += `• ⏳ <b>만남일정 미정</b>: ${undecided.length}개 방 (조회: <code>관리자 미등록</code>)\n`;
        msg += `• 🛑 <b>만남 중단 상태</b>: ${stopped.length}개 방 (조회: <code>관리자 중단</code>)\n`;
        msg += `• 🚨 <b>보고서 미제출</b>: ${overdue.length}개 방 (조회: <code>관리자 미제출</code>)\n`;
        msg += `• ⌛ <b>만남일 경과 미갱신</b>: ${expired.length}개 방 (조회: <code>관리자 미갱신</code>)\n`;

        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[종합 점검 에러]:', err);
    }
});

// 10. 일반 텍스트 수신 (사전 보고서, 결과 보고서, 만남 보고서 및 #피드백 감지)
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat.id;
    const roomTitle = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    try {

    await ensureChatRecord(chatId, roomTitle);

    // 슬래시(/)나 느낌표(!)로 시작하는 정식 명령어 텍스트는 무시
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
        const interviewerMatch = text.match(/인터뷰어[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
        const interviewerRaw = interviewerMatch ? interviewerMatch[1].trim() : '';

        const typerMatch = text.match(/타이퍼[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
        const typerRaw = typerMatch ? typerMatch[1].trim() : '';

        const dateMatch = text.match(
            /(?:인터뷰[ \t]*(?:예정일|일시|일)|만남[ \t]*(?:예정일|일시|일)|일시|일정)[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i
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

            let typer: any = null;
            const hasTyper = typerRaw && !/^(없음|미지정|\-|없|X)$/i.test(typerRaw);
            if (hasTyper) {
                let tInfo = parseMemberString(typerRaw);
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
            resMsg += `💡 개별 수정: <code>/인터뷰어</code>, <code>/타이퍼</code>, <code>/인터뷰일</code>`;

            await ctx.reply(resMsg, { parse_mode: 'HTML' });
            return;
        } catch (err: unknown) {
            console.error('[사전 보고서 처리 에러]:', err);
            await ctx.reply(`⚠️ 사전 보고서 처리 중 오류가 발생했습니다: ${getErrorMessage(err)}`);
            return;
        }
    }

    // B. [인터뷰 결과 보고서] 감지
    const isInterviewReport =
        text.includes('인터뷰 결과 보고서') ||
        text.includes('인터뷰 결과') ||
        text.includes('인터뷰보고서') ||
        text.includes('인터뷰 보고서');

    if (isInterviewReport) {
        const followUpMatch = text.match(/후속[ \t]*신청[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
        const followUpRaw = followUpMatch ? followUpMatch[1].trim() : '';

        const isNotApplied = /미신청|안함|거절|취소|보류|불가|X|x/i.test(followUpRaw);
        const isApplied = /신청|완료|진행|O|o/i.test(followUpRaw) && !isNotApplied;

        if (isNotApplied) {
            const reasonMatch = text.match(/미신청[ \t]*사유[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
            const reason = reasonMatch?.[1].trim() || '사유 미입력';

            await updateChat(chatId, {
                meeting_type: '인터뷰',
                follow_up_applied: '미신청',
                follow_up_reason: reason,
                meeting_date: '중단',
                stop_reason: `인터뷰 후속 미신청: ${reason}`,
                stop_category: null,
                interview_report_submitted: 1,
                report_submitted: 1,
            });

            await ctx.reply(
                `🛑 <b>인터뷰 결과 보고서가 반영되었습니다.</b>\n\n` +
                    `• <b>후속 신청</b>: <b>미신청</b>\n` +
                    `• <b>상세 사유</b>: ${escapeHtml(reason)}\n` +
                    `• <b>대화방 상태</b>: 만남 중단 처리됨\n\n` +
                    `👇 <b>미신청 사유 분류를 선택해주세요:</b>`,
                { parse_mode: 'HTML', reply_markup: buildStopCategoryKeyboard('fu') }
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

    // C. 일반 [만남 보고서] 감지
    const isReport =
        text.includes('상담,복음방 보고서') ||
        text.includes('상담 보고서') ||
        text.includes('복음방 보고서') ||
        text.includes('만남 보고서') ||
        text.includes('다음만남일') ||
        text.includes('다음 만남일');

    if (isReport) {
        // 진행내용 / 상담반응 및 특이사항이 비어 있으면 제출로 처리하지 않음 (일정 갱신도 보류)
        // 양식마다 제목이 달라 후보 라벨 중 하나라도 작성되어 있으면 인정
        const missingFields = [
            { name: '진행내용', labels: [/진행\s*내용/] },
            {
                name: '상담반응 및 특이사항',
                labels: [/상담\s*반응(?:\s*및\s*특이\s*사항)?/, /교육\s*후\s*반응/, /특이\s*사항/],
            },
        ]
            .filter((f) => f.labels.every((label) => isBlankReportField(extractReportField(text, label))))
            .map((f) => f.name);

        if (missingFields.length > 0) {
            await ctx.reply(
                `⚠️ <b>만남 보고서가 아직 제출 처리되지 않았습니다.</b>\n\n` +
                    `아래 항목이 비어 있습니다:\n` +
                    missingFields.map((n) => `• <b>${n}</b>`).join('\n') +
                    `\n\n내용을 작성하여 보고서를 다시 올려주세요.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

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

    // D. 피드백 감지
    if (/#피드백내용|#피드백/.test(text)) {
        await updateChat(chatId, { feedback_submitted: 1 });
        await ctx.reply('📝 <b>피드백 내용이 확인되었습니다.</b> 감사합니다.', { parse_mode: 'HTML' });
    }
    } catch (err: unknown) {
        console.error('[텍스트 메시지 처리 에러]:', getErrorMessage(err));
        await ctx.reply(`⚠️ 메시지 처리 중 오류가 발생했습니다: ${getErrorMessage(err)}`);
    }
});

/* =====================================================
 * ⏰ 스케줄러 트리거 함수들
 * ===================================================== */
let isMorningReminderRunning = false;

async function triggerMorningReminder() {
    if (isMorningReminderRunning) {
        console.warn('[오전 알림] 이전 실행이 아직 진행 중이라 중복 호출을 건너뜁니다.');
        return;
    }
    isMorningReminderRunning = true;

    try {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const chats = await getAllChats();

    for (const chat of chats) {
        // 진행 구분 날짜(섭등목표 / 예정목표 / 가능목표 / 확정목표) 당일 안내 — 같은 날짜로는 한 번만
        const stageDate = getStageDate(chat.progress_note);
        const todayStr = today.format('YYYY-MM-DD');
        if (
            chat.progress_stage &&
            chat.meeting_date !== '중단' &&
            stageDate?.format('YYYY-MM-DD') === todayStr &&
            chat.stage_notified_date !== todayStr
        ) {
            try {
                const stageLabel = `${chat.progress_stage}일`;
                const member = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `📌 <b>[${stageLabel} 당일 안내]</b>${member}\n` +
                        `오늘(${today.format('MM/DD')})은 <b>${stageLabel}</b>입니다.\n` +
                        `진행 상황을 확인해 주세요!\n\n` +
                        `💡 날짜가 바뀌었다면 <code>/${chat.progress_stage} MM-DD</code>로 다시 등록해주세요.`,
                    { parse_mode: 'HTML' }
                );
                await updateChat(chat.chat_id, { stage_notified_date: todayStr });
            } catch (err: unknown) {
                console.error(`[구분 예정일 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
            }
        }

        if (!chat.meeting_date || chat.meeting_date === '미정' || chat.meeting_date === '중단') continue;

        const mDate = dayjs(chat.meeting_date).startOf('day');
        if (!mDate.isValid()) continue;

        const diffDays = today.diff(mDate, 'day');

        // D-1 안내
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
            } catch (err: unknown) {
                console.error(`[오전 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
            }
        }

        // D+1 미제출 알림
        if (diffDays === 1 && !chat.report_submitted && !chat.overdue_1_notified) {
            try {
                const isInterview = chat.meeting_type === '인터뷰';
                const reportTitle = isInterview ? '인터뷰 사후 보고서(결과 보고서)' : '만남 보고서';
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `⚠️ <b>[${isInterview ? '인터뷰 사후 보고서' : '보고서'} 미제출 안내]</b>\n` +
                        `어제(${mDate.format('MM/DD')}) 진행된 ${
                            isInterview ? '인터뷰' : '만남'
                        }의 <b>${reportTitle}</b>가 아직 제출되지 않았습니다.\n` +
                        `확인 후 작성해 주세요.` +
                        (isInterview ? `\n\n💡 양식: <code>/인터뷰사후양식</code>` : ''),
                    { parse_mode: 'HTML' }
                );
                await updateChat(chat.chat_id, { overdue_1_notified: 1 });
            } catch (err: unknown) {
                console.error(`[D+1 지연 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
            }
        }

        // D+2 경고 알림
        if (diffDays >= 2 && !chat.report_submitted && !chat.overdue_2_notified) {
            try {
                await bot.telegram.sendMessage(
                    chat.chat_id,
                    `🚨 <b>[보고서 제출 지연 경고]</b>\n` +
                        `${chat.meeting_type === '인터뷰' ? '인터뷰일' : '만남일'}(${mDate.format(
                            'MM/DD'
                        )})로부터 2일이 경과했습니다.\n` +
                        `${
                            chat.meeting_type === '인터뷰' ? '인터뷰 사후 보고서' : '만남 보고서'
                        }는 <b>2일 이내 필수 제출</b> 대상입니다!`,
                    { parse_mode: 'HTML' }
                );
                await updateChat(chat.chat_id, { overdue_2_notified: 1 });
            } catch (err: unknown) {
                console.error(`[D+2 경고 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
            }
        }
    }
    } finally {
        isMorningReminderRunning = false;
    }
}

let isNightReminderRunning = false;

async function triggerNightReminder() {
    if (isNightReminderRunning) {
        console.warn('[야간 알림] 이전 실행이 아직 진행 중이라 중복 호출을 건너뜁니다.');
        return;
    }
    isNightReminderRunning = true;

    try {
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
                        `📋 <b>[인터뷰 사후 보고서 미제출 안내]</b>\n` +
                            `오늘(${mDate.format('MM/DD')}) 인터뷰의 <b>사후 보고서(결과 보고서)</b>가 아직 올라오지 않았습니다.\n` +
                            `인터뷰를 마치셨다면 사후 보고서를 등록해 주세요!\n\n` +
                            `💡 양식이 필요하시면 <code>/인터뷰사후양식</code>을 입력하세요.`,
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
            } catch (err: unknown) {
                console.error(`[22시 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
            }
        }
    }
    } finally {
        isNightReminderRunning = false;
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

    // DB 테이블 컬럼 점검 및 자동 생성
    await initDb();

    const webhookUrl = 'https://teacherfollow.alwaysdata.net/webhook';
    try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Telegram Webhook 등록 완료: ${webhookUrl}`);
    } catch (e: unknown) {
        console.error('Webhook 등록 에러:', getErrorMessage(e));
    }
});
