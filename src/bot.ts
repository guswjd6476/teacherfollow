import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import crypto from 'crypto';
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

// 웹훅 비밀값: 텔레그램이 보낸 요청에만 붙는 헤더로, 없거나 다르면 거절 (웹훅 주소로 가짜 업데이트를 보내는 것 방지)
// WEBHOOK_SECRET을 지정하지 않으면 봇 토큰에서 만들어 사용 (토큰을 모르면 알 수 없음)
const WEBHOOK_SECRET =
    process.env.WEBHOOK_SECRET || crypto.createHash('sha256').update(`webhook:${BOT_TOKEN}`).digest('hex');
if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
    console.error('❌ WEBHOOK_SECRET은 영문·숫자·_·- 로 된 1~256자여야 합니다.');
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
    // 사용 인증 테이블 — 다른 점검이 실패해도 인증은 동작하도록 먼저 따로 처리
    try {
        await neonPool.query(`
            CREATE TABLE IF NOT EXISTS verified_users (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                username TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                requested_at TIMESTAMPTZ DEFAULT NOW(),
                decided_at TIMESTAMPTZ,
                decided_by TEXT
            );
            CREATE TABLE IF NOT EXISTS authorized_chats (
                chat_id TEXT PRIMARY KEY,
                authorized_by TEXT,
                authorized_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS bot_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS region_chats (
                chat_id TEXT NOT NULL,
                region TEXT NOT NULL,
                registered_by TEXT,
                registered_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (chat_id, region)
            );
            -- 신규 만남 발생 기록 (인터뷰 매칭 = 상담 이하 / 교사 매칭 = 상담 1회차)
            -- category: 인터뷰매칭 / 지인매칭 / 교사매칭
            -- source: '최초등록'(첫 만남 유형 선택) / '인터뷰후속'(인터뷰 결과 보고서 후속 신청) / '지인후속'(/교사전환)
            -- 교사 만남 누적 기록: 대상자·만남일당 1회 (보고서를 고쳐서 다시 올려도 1회)
            CREATE TABLE IF NOT EXISTS teacher_meetings (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                student_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                meeting_date VARCHAR(10),
                recorded_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (chat_id, message_id)
            );
            DELETE FROM teacher_meetings a USING teacher_meetings b
                WHERE a.chat_id = b.chat_id AND a.student_id = b.student_id
                  AND a.meeting_date = b.meeting_date AND a.id > b.id;
            CREATE UNIQUE INDEX IF NOT EXISTS teacher_meetings_once_per_date
                ON teacher_meetings (chat_id, student_id, meeting_date);
            -- 기능 도입 전 진행한 회차 (/교사만남회차 n 으로 보정)
            ALTER TABLE counseling_chats ADD COLUMN IF NOT EXISTS teacher_meeting_base INTEGER DEFAULT 0;
            -- 섭등 후 회차 중 봇 기록 이전 진행분 (/섭등회차 n 으로 보정)
            ALTER TABLE counseling_chats ADD COLUMN IF NOT EXISTS seop_meeting_base INTEGER DEFAULT 0;
            CREATE TABLE IF NOT EXISTS meeting_events (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                student_id TEXT NOT NULL,
                category VARCHAR(20) NOT NULL,
                source VARCHAR(20) NOT NULL,
                occurred_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (chat_id, student_id, source)
            );
        `);

        // 인증 기능 도입 전부터 쓰던 방은 그대로 사용 가능하도록 1회 이전
        const migrated = await neonPool.query(`SELECT 1 FROM bot_meta WHERE key = 'auth_chats_migrated'`);
        if (migrated.rows.length === 0) {
            const res = await neonPool.query(`
                INSERT INTO authorized_chats (chat_id, authorized_by)
                SELECT chat_id::text, 'migration' FROM counseling_chats
                ON CONFLICT (chat_id) DO NOTHING;
            `);
            await neonPool.query(`INSERT INTO bot_meta (key, value) VALUES ('auth_chats_migrated', NOW()::text);`);
            console.log(`✅ [DB 점검] 기존 방 ${res.rowCount}개를 인증된 방으로 이전`);
        }
    } catch (err: unknown) {
        console.error('⚠️ [인증 테이블 점검 경고]:', getErrorMessage(err));
    }

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
            ADD COLUMN IF NOT EXISTS stage_notified_date VARCHAR(10),
            ADD COLUMN IF NOT EXISTS meeting_time VARCHAR(20),
            ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS type_selected_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS stage_reminder_key VARCHAR(20),
            ADD COLUMN IF NOT EXISTS stage_reminder_date VARCHAR(10),
            ADD COLUMN IF NOT EXISTS stage_reminder_count INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS drop_ack_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS stop_phase VARCHAR(30),
            -- 오전 10시 점검 때 계산한 지금 걸린 진행 멈춤 안내 (웹 상담 현황이 같은 기준으로 보여준다)
            ADD COLUMN IF NOT EXISTS nudge_key VARCHAR(20),
            ADD COLUMN IF NOT EXISTS nudge_label VARCHAR(40),
            ADD COLUMN IF NOT EXISTS nudge_checked_on VARCHAR(10);
        `);
        // 중단 시점 기록 도입 전에 중단된 방 채우기 (여러 번 실행돼도 빈 것만 채움)
        await neonPool.query(`
            UPDATE counseling_chats SET stop_phase = CASE
                WHEN stop_reason LIKE '인터뷰 후속 미신청%' THEN '인터뷰 후'
                WHEN meeting_type = '인터뷰' AND COALESCE(interview_report_submitted, 0) = 0 THEN '인터뷰 전'
                WHEN meeting_type = '인터뷰' THEN '인터뷰 후'
                WHEN meeting_type = '교사' THEN '교사 만남 중'
                WHEN meeting_type = '지인' THEN '지인 만남 중'
            END
            WHERE meeting_date = '중단' AND stop_phase IS NULL AND COALESCE(meeting_type, '') <> '';
        `);
        // 봇이 방에서 나가면 방 기록을 여기로 옮겨 두었다가, 다시 초대되면 복원
        await neonPool.query(`
            CREATE TABLE IF NOT EXISTS counseling_chats_left (
                chat_id TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                left_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✅ [DB 점검] counseling_chats 테이블 신규 컬럼 점검 완료');

        await neonPool.query(`CREATE TABLE IF NOT EXISTS bot_meta (key TEXT PRIMARY KEY, value TEXT);`);

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
    teacher_code?: string | null;
    meeting_type?: '인터뷰' | '교사' | '지인' | '행사' | '' | null;
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
    meeting_time?: string | null;
    last_message_at?: string | null;
    matched_at?: string | null;
    type_selected_at?: string | null;
    stage_reminder_key?: string | null;
    stage_reminder_date?: string | null;
    stage_reminder_count?: number | null;
    drop_ack_at?: string | null;
    stop_phase?: string | null;
    student_dropped_at?: string | null;
    teacher_meeting_base?: number | null;
    seop_meeting_base?: number | null;
    teacher_meeting_count?: number;
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

// 지인 만남·행사 참석은 일정만 관리 — 보고서 제출·미제출 알림·독촉 대상에서 제외
function needsReport(c: { meeting_type?: string | null }): boolean {
    return c.meeting_type !== '지인' && c.meeting_type !== '행사';
}

// 만남이 어느 단계에서 중단됐는지 (중단 처리 직전 상태 기준)
//   인터뷰 전: 인터뷰 만남인데 결과 보고서 전 (연락두절·거절 등으로 인터뷰를 못 함)
function getStopPhase(c: Pick<ChatRecord, 'meeting_type' | 'interview_report_submitted'> | undefined): string {
    switch (c?.meeting_type) {
        case '인터뷰':
            return c.interview_report_submitted ? '인터뷰 후' : '인터뷰 전';
        case '교사':
            return '교사 만남 중';
        case '지인':
            return '지인 만남 중';
        case '행사':
            return '행사 참석 단계';
        default:
            return '유형 선택 전';
    }
}

// 타부서 교사: 교사_고유번호가 우리 부서 고유번호('00'으로 시작)가 아닌 uid
function isOtherDeptTeacher(c: { teacher_code?: string | null }): boolean {
    const code = String(c.teacher_code ?? '').trim();
    return code !== '' && !code.startsWith('00');
}

// 전체 방 목록 조회
async function getAllChats(): Promise<ChatRecord[]> {
    const query = `
        SELECT 
            c.*,
            s."이름" AS matched_student_name,
            s.target AS student_target,
            s."단계" AS student_stage,
            s."탈락" AS student_dropped_at,
            m."이름" AS guide_name,
            m."지역" AS guide_region,
            m."구역" AS guide_district,
            t."이름" AS teacher_name,
            t."지역" AS teacher_region,
            t."구역" AS teacher_district,
            s."교사_고유번호"::text AS teacher_code,
            COALESCE(c.teacher_meeting_base, 0) + (
                SELECT COUNT(*) FROM teacher_meetings tm
                WHERE tm.chat_id = c.chat_id AND tm.student_id = c.matched_member_id::text
            )::int AS teacher_meeting_count
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
            s."단계" AS student_stage,
            s."탈락" AS student_dropped_at,
            m."이름" AS guide_name,
            m."지역" AS guide_region,
            m."구역" AS guide_district,
            t."이름" AS teacher_name,
            t."지역" AS teacher_region,
            t."구역" AS teacher_district,
            COALESCE(c.teacher_meeting_base, 0) + (
                SELECT COUNT(*) FROM teacher_meetings tm
                WHERE tm.chat_id = c.chat_id AND tm.student_id = c.matched_member_id::text
            )::int AS teacher_meeting_count
        FROM counseling_chats c
        LEFT JOIN students s ON c.matched_member_id::text = s.id::text
        LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
        LEFT JOIN members t ON s."교사_고유번호" = t."고유번호"
        WHERE c.chat_id = $1
        LIMIT 1;
    `;
    const res = await neonPool.query(query, [String(chatId)]);
    return res.rows[0];
}

// 방 기본 레코드 보장 (+ 마지막 대화 시각 기록 — updated_at은 일정·상태가 바뀔 때만 갱신)
async function ensureChatRecord(chatId: string | number, title: string) {
    const id = String(chatId);
    const safeTitle = title || '대화방';
    // 기록이 없는 방 (웹에서 지웠거나 보관된 방): 보관해 둔 기록이 있으면 먼저 복원
    const exists = await neonPool.query(`SELECT 1 FROM counseling_chats WHERE chat_id = $1`, [id]);
    if (exists.rowCount === 0) {
        if (await restoreArchivedChat(id)) console.log(`[보관 기록 복원] Chat: ${id}`);
        else await adoptBasicGroupRecord(id, safeTitle);
    }

    const query = `
        INSERT INTO counseling_chats (chat_id, room_title, updated_at, last_message_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (chat_id) DO UPDATE SET
            room_title = EXCLUDED.room_title,
            last_message_at = NOW();
    `;
    await neonPool.query(query, [id, safeTitle]);
}

// 만남일 등록/변경 (새 일정이면 알림 상태·인터뷰 단계 안내 횟수도 초기화)
async function upsertMeetingDate(chatId: string | number, title: string, meetingDate: string, meetingTime = '') {
    const id = String(chatId);
    const safeTitle = title || '대화방';

    const query = `
        INSERT INTO counseling_chats (
            chat_id, room_title, meeting_date, meeting_time, stop_reason,
            feedback_submitted, report_submitted,
            d_minus_1_notified, d_day_22_notified, overdue_1_notified, overdue_2_notified,
            updated_at
        ) VALUES (
            $1, $2, $3, $4, '',
            0, 0,
            0, 0, 0, 0,
            NOW()
        )
        ON CONFLICT (chat_id) DO UPDATE SET
            room_title = EXCLUDED.room_title,
            meeting_date = EXCLUDED.meeting_date,
            meeting_time = EXCLUDED.meeting_time,
            stop_reason = '',
            feedback_submitted = 0,
            report_submitted = 0,
            d_minus_1_notified = 0,
            d_day_22_notified = 0,
            overdue_1_notified = 0,
            overdue_2_notified = 0,
            stage_reminder_count = 0,
            stop_phase = NULL,
            updated_at = NOW();
    `;
    await neonPool.query(query, [id, safeTitle, meetingDate, meetingTime || null]);
}

// 방 정보 동적 업데이트
async function updateChat(chatId: string | number, patch: Partial<ChatRecord>) {
    const id = String(chatId);
    const ignoredKeys = ['chat_id', 'matched_student_name', 'student_target', 'student_stage', 'student_dropped_at', 'guide_name', 'guide_region', 'guide_district', 'teacher_name', 'teacher_region', 'teacher_district', 'teacher_code', 'teacher_meeting_count'];
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
// 입력 문자열에서 날짜를 찾아 'YYYY-MM-DD'로 변환 (실패 시 null)
// 지원: 10.8(월), 10/8, 10-08, 10월 8일, 2026.10.8, 26.10.8, 오늘/내일/모레
function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    // 전각 숫자·기호(１０．８ 등) → 반각
    const text = rawText.normalize('NFKC');
    const today = dayjs().tz('Asia/Seoul').startOf('day');

    const toYmd = (year: number, month: number, day: number): string | null => {
        const str = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return dayjs(str, 'YYYY-MM-DD', true).isValid() ? str : null; // 2/30 같은 없는 날짜는 거부
    };

    // 연도 포함: 2026.10.8 / 2026년 10월 8일 / 26.10.8 (두 자리 연도는 13 이상일 때만 연도로 인정 → 10.8 14시 오인 방지)
    const withYear = text.match(/(?:^|[^\d])(\d{4}|\d{2})\s*[\-\/\.년]\s*(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (withYear && (withYear[1].length === 4 || parseInt(withYear[1], 10) > 12)) {
        const year = withYear[1].length === 4 ? parseInt(withYear[1], 10) : 2000 + parseInt(withYear[1], 10);
        const ymd = toYmd(year, parseInt(withYear[2], 10), parseInt(withYear[3], 10));
        if (ymd) return ymd;
    }

    // 월·일만: 10.8 / 10/8 / 10-08 / 10월 8일 (뒤의 시간·요일은 무시)
    const monthDay = text.match(/(?:^|[^\d])(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (monthDay) {
        const month = parseInt(monthDay[1], 10);
        const day = parseInt(monthDay[2], 10);
        // 연도 생략 시 오늘 기준 ±6개월 안에 들어오는 해로 결정 (12월에 1월 입력 → 내년, 1월에 12월 입력 → 작년)
        for (const year of [today.year(), today.year() + 1, today.year() - 1]) {
            const ymd = toYmd(year, month, day);
            if (!ymd) continue;
            const diff = dayjs(ymd).diff(dayjs(today.format('YYYY-MM-DD')), 'day');
            if (diff >= -183 && diff <= 183) return ymd;
        }
        return toYmd(today.year(), month, day);
    }

    const relative = text.match(/오늘|내일|모레/);
    if (relative) {
        const offset = { 오늘: 0, 내일: 1, 모레: 2 }[relative[0] as '오늘' | '내일' | '모레'];
        return today.add(offset, 'day').format('YYYY-MM-DD');
    }

    return null;
}

// 입력한 요일이 실제 날짜의 요일과 다르면 안내 문구 반환 (예: 10.8(월) 인데 10/8이 목요일)
function getWeekdayWarning(rawText: string, ymd: string): string {
    const text = rawText.normalize('NFKC');
    const m = text.match(/\(\s*([월화수목금토일])(?:요일)?\s*\)|([월화수목금토일])요일/);
    if (!m) return '';
    const written = m[1] || m[2];
    const actual = '일월화수목금토'[dayjs(ymd).day()];
    return written === actual
        ? ''
        : `\n\n⚠️ 입력한 요일(${written})과 실제 요일이 다릅니다: <b>${ymd} (${actual})</b>\n날짜가 틀렸다면 다시 입력해주세요.`;
}

// 지난 날짜면 안내 문구 반환
function getPastDateWarning(ymd: string): string {
    const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    return ymd < todayStr ? `\n\n⚠️ <b>이미 지난 날짜</b>입니다 (${ymd}). 잘못 입력했다면 다시 입력해주세요.` : '';
}

// 입력에서 시간 추출 (예: 19:00, 19시, 오후 7시, 7시 반, 오후 2시 30분) — 표시용 문자열 반환, 없으면 ''
// 오전/오후 표기가 없고 12시 미만이면 입력 그대로 'N시'로 둔다 (오전/오후 추측하지 않음)
function parseFlexibleTime(rawText: string): string {
    if (!rawText) return '';
    const text = rawText.normalize('NFKC');
    const m =
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*:\s*(\d{2})(?!\d)/) ||
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(?:(\d{1,2})\s*분|(반))?/);
    if (!m) return '';
    let hour = parseInt(m[2], 10);
    const minute = m[4] === '반' ? 30 : m[3] ? parseInt(m[3], 10) : 0;
    if (hour > 24 || minute > 59) return '';
    const period = m[1];
    if (period && ['오후', '저녁', '밤'].includes(period) && hour < 12) hour += 12;
    if (period === '낮' && hour <= 6) hour += 12;
    if (period && ['오전', '아침', '새벽'].includes(period) && hour === 12) hour = 0;
    if (!period && hour < 12) return minute ? `${hour}시 ${minute}분` : `${hour}시`;
    return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 시간 추출 전에 날짜 부분(10.8 / 2026.10.8 / 10월 8일)을 제거 — '10.8'의 8을 시간으로 오인하지 않도록
function stripDatePart(rawText: string): string {
    return rawText
        .normalize('NFKC')
        .replace(/(?:(?:\d{4}|1[3-9]|[2-9]\d)\s*[\-\/\.년]\s*)?\d{1,2}\s*[\-\/\.월]\s*\d{1,2}\s*일?/, ' ');
}

// 마지막 대화 시각 표시 (예: 10/08 21:30 (2일 전))
function formatLastMessage(value?: string | Date | null): string {
    if (!value) return '기록 없음';
    const d = dayjs(value).tz('Asia/Seoul');
    if (!d.isValid()) return '기록 없음';
    const days = dayjs().tz('Asia/Seoul').startOf('day').diff(d.startOf('day'), 'day');
    return `${d.format('MM/DD HH:mm')} (${days === 0 ? '오늘' : `${days}일 전`})`;
}

// 날짜(+시간) 표시용
function formatMeetingWhen(date: string, time?: string | null): string {
    return time ? `${date} ${time}` : date;
}

// 날짜 + 요일 표시 (예: 2026-10-08 (목))
function formatYmdWithDay(ymd: string): string {
    const d = dayjs(ymd);
    return d.isValid() ? `${ymd} (${'일월화수목금토'[d.day()]})` : ymd;
}

// 진행 구분 예정일 (progress_note에 'YYYY-MM-DD'로 저장) — 날짜가 아니면 null
// 예전·직접 입력으로 '10/16', '10.16', '10,09'처럼 월·일만 있으면 오늘에서 가장 가까운 해로 본다
function getStageDate(note?: string | null): dayjs.Dayjs | null {
    const v = (note ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const d = dayjs(v);
        return d.isValid() ? d : null;
    }
    const m = v.match(/^(\d{1,2})\s*[/.,\-월]\s*(\d{1,2})일?$/);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const now = dayjs().tz('Asia/Seoul');
    const candidates = [-1, 0, 1].map((dy) => dayjs(new Date(now.year() + dy, month - 1, day)));
    return candidates.reduce((best, d) => (Math.abs(d.diff(now)) < Math.abs(best.diff(now)) ? d : best));
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

// 보고서의 '다음만남일' 값 추출
// 1순위: 줄 맨 앞(기호·이모지 뒤)에 있는 라벨 줄 — 본문 속 "다음 만남 때 ~" 같은 문장 오인 방지
//        라벨 뒤가 비어 있으면 바로 아래 줄에 적은 날짜/미정을 사용
// 2순위: 기존 방식 (문장 어디든 첫 번째 '다음 만남 …')
function extractNextMeetingRaw(text: string): string | null {
    const lines = text.split(/\r?\n/);
    const labelRe = /^[^가-힣\d]*다음\s*(?:만남\s*(?:일시|일자|예정일|일)?|일정)\s*[:：\-]?\s*(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(labelRe);
        if (!m) continue;
        const rest = m[1].trim();
        if (rest) return rest;
        const next = lines.slice(i + 1).find((l) => l.trim() !== '');
        if (next && (parseFlexibleDate(next) || next.includes('미정'))) return next.trim();
        return null;
    }
    const match = text.match(/다음[ \t]*(?:만남일시|만남[ \t]*일시|만남일|만남[ \t]*일|만남|일정)[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
    return match && match[1] ? match[1].trim() : null;
}

// students."단계" 진행 순서 (첫 글자 기준: 발 → 찾 → 합 → 섭)
const STUDENT_STAGE_ORDER = ['발', '찾', '합', '섭'] as const;

function getStudentStageRank(stage: unknown): number {
    const first = String(stage ?? '').trim().charAt(0);
    return STUDENT_STAGE_ORDER.indexOf(first as (typeof STUDENT_STAGE_ORDER)[number]);
}

// 단계별 등록일 조회 (예: '찾' → 찾_등록일 / 찾등록일 / 찾*등록* / 찾*일 순으로 탐색)
function stageRegDateKeys(row: Record<string, any>, prefix: string): string[] {
    const keys = Object.keys(row).filter((k) => k.startsWith(prefix));
    return [
        ...[`${prefix}_등록일`, `${prefix}등록일`].filter((k) => keys.includes(k)),
        ...keys.filter((k) => k.includes('등록')),
        ...keys.filter((k) => k.endsWith('일')),
    ];
}

function getStageRegDate(row: Record<string, any>, prefix: string): string | null {
    for (const key of stageRegDateKeys(row, prefix)) {
        const formatted = formatDateDisplay(row[key]);
        if (formatted !== '-') return formatted;
    }
    return null;
}

// 단계 등록일을 날짜 비교용 'YYYY-MM-DD'로 (없거나 날짜가 아니면 null)
function getStageRegYmd(row: Record<string, any>, prefix: string): string | null {
    for (const key of stageRegDateKeys(row, prefix)) {
        const raw = row[key];
        if (!raw || ['', 'EMPTY_STRING', 'NULL'].includes(String(raw).trim())) continue;
        const d = raw instanceof Date ? dayjs(raw).tz('Asia/Seoul') : dayjs(String(raw).trim());
        if (d.isValid()) return d.format('YYYY-MM-DD');
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
        await replyLong(ctx, message, isLast ? lastMessageExtra : {});
    }
}

// 텔레그램 메시지 길이 제한(4096자) 대응: 줄 단위로 나눠 여러 메시지로 전송 (HTML 태그는 줄 안에서 닫혀 있어야 함)
const TELEGRAM_SAFE_LENGTH = 3800;

function splitLongMessage(text: string, limit = TELEGRAM_SAFE_LENGTH): string[] {
    const parts: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (current && current.length + line.length + 1 > limit) {
            parts.push(current);
            current = '';
        }
        current += (current ? '\n' : '') + line;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

async function replyLong(ctx: any, html: string, lastMessageExtra: Record<string, unknown> = {}) {
    const parts = splitLongMessage(html);
    for (let i = 0; i < parts.length; i++) {
        await ctx.reply(parts[i], { parse_mode: 'HTML', ...(i === parts.length - 1 ? lastMessageExtra : {}) });
    }
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);
const BOT_STARTED_AT = dayjs();

// 오류를 관리자 개인 대화로 전달 — 같은 방·같은 작업 오류는 10분에 한 번만
const recentErrorAlerts = new Map<string, number>();
async function alertAdmins(where: string, label: string, err: unknown) {
    const key = `${where}:${label}`;
    const now = Date.now();
    if (now - (recentErrorAlerts.get(key) ?? 0) < 10 * 60 * 1000) return;
    recentErrorAlerts.set(key, now);
    const text =
        `🚨 <b>[봇 오류]</b> ${escapeHtml(label)}\n` +
        `• 위치: ${escapeHtml(where)}\n` +
        `• 내용: <code>${escapeHtml(getErrorMessage(err).slice(0, 500))}</code>`;
    for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
    }
}

function chatLabel(ctx: any): string {
    const chat = ctx.chat;
    if (!chat) return '알 수 없음';
    const title = 'title' in chat ? chat.title : `개인 대화 (${chat.first_name || ''})`;
    return `${title} (${chat.id})`;
}

// 처리 중 오류 응답 — 관리자에게는 오류 내용을 그대로, 그 외에는 DB 내용이 드러나지 않게 일반 문구로 답하고 관리자에게 전달
async function replyError(ctx: any, label: string, err: unknown) {
    if (isAdmin(ctx.from?.id)) {
        await ctx.reply(`⚠️ ${label} 중 오류 발생: ${getErrorMessage(err)}`).catch(() => {});
        return;
    }
    await ctx
        .reply(`⚠️ ${label} 중 오류가 발생했습니다. 관리자에게 자동으로 전달했으니 잠시 후 다시 시도해주세요.`)
        .catch(() => {});
    await alertAdmins(chatLabel(ctx), label, err);
}

bot.catch((err: unknown, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
    alertAdmins(chatLabel(ctx), '처리되지 않은 오류', err).catch(() => {});
});

/* =====================================================
 * 🔐 사용 인증
 * - 사람: 봇 개인 대화에서 /start → [인증 요청] → 관리자 승인 (1회)
 * - 방: 인증된 사람(또는 관리자)이 초대한 방만 사용 가능, 그 외에는 안내 후 자동 퇴장
 * ===================================================== */
async function getUserAuthStatus(userId?: number | string): Promise<string | null> {
    if (!userId) return null;
    if (isAdmin(userId)) return 'approved';
    const res = await neonPool.query(`SELECT status FROM verified_users WHERE user_id = $1`, [String(userId)]);
    return res.rows[0]?.status ?? null;
}

async function isVerifiedUser(userId?: number | string): Promise<boolean> {
    return (await getUserAuthStatus(userId)) === 'approved';
}

async function isAuthorizedChat(chatId: number | string): Promise<boolean> {
    const res = await neonPool.query(`SELECT 1 FROM authorized_chats WHERE chat_id = $1`, [String(chatId)]);
    return res.rows.length > 0;
}

// 슈퍼그룹(-100…) 방에 처음 기록이 생길 때, 전환 신호를 놓친 경우를 대비해 같은 제목의 옛 일반 그룹 기록을 이어받는다
// (같은 제목의 -100이 아닌 방이 딱 하나이고, 그 방이 더 먼저 생겼을 때만. 일반 그룹 ID로는 전환 뒤 메시지가 오지 않는다)
async function adoptBasicGroupRecord(newChatId: string, title: string) {
    if (!newChatId.startsWith('-100') || !title || title === '대화방') return;
    const res = await neonPool.query(
        `SELECT chat_id FROM counseling_chats WHERE room_title = $1 AND chat_id NOT LIKE '-100%' AND chat_id LIKE '-%'`,
        [title]
    );
    if (res.rows.length !== 1) return;
    const oldId = String(res.rows[0].chat_id);
    console.log(`[슈퍼그룹 전환 추정] 같은 제목의 옛 방 ${oldId} -> ${newChatId}`);
    await mergeMigratedChat(oldId, newChatId);
}

// 일반 그룹이 슈퍼그룹으로 바뀌면 텔레그램이 방 ID를 새로 준다 (-100으로 시작).
// 새 ID로 빈 상담방 기록이 생기므로, 옛 ID의 기록(매칭·일정·회차·만남 기록·담당방 등록)을 새 ID로 합친다.
// 최초 등록(학생 연결)이 된 쪽 값을 기준으로 하고 빈 칸만 다른 쪽 값으로 채운다. 여러 번 불려도 결과가 같다
async function mergeMigratedChat(oldChatId: number | string, newChatId: number | string) {
    const oldId = String(oldChatId);
    const newId = String(newChatId);
    if (oldId === newId) return;
    const client = await neonPool.connect();
    try {
        await client.query('BEGIN');
        const rows = (
            await client.query(`SELECT * FROM counseling_chats WHERE chat_id = ANY($1::text[]) FOR UPDATE`, [[oldId, newId]])
        ).rows;
        const oldRow = rows.find((r) => r.chat_id === oldId);
        const newRow = rows.find((r) => r.chat_id === newId);
        if (oldRow && !newRow) {
            await client.query(`UPDATE counseling_chats SET chat_id = $2 WHERE chat_id = $1`, [oldId, newId]);
        } else if (oldRow && newRow) {
            // 최초 등록(학생 연결)이 된 방을 기준으로 (둘 다 됐거나 둘 다 안 됐으면 새 방 기준), 기준 방에서 빈 칸만 다른 방 값으로
            const empty = (v: unknown) => v === null || v === undefined || v === '' || v === 0 || v === false;
            const [base, other] = !newRow.matched_member_id && oldRow.matched_member_id ? [oldRow, newRow] : [newRow, oldRow];
            const cols = Object.keys(newRow).filter((c) => c !== 'chat_id');
            const merged = cols.map((c) => {
                if (c === 'created_at') return oldRow.created_at < newRow.created_at ? oldRow.created_at : newRow.created_at;
                if (c === 'room_title') return newRow.room_title || oldRow.room_title; // 방 제목은 지금 것
                return empty(base[c]) ? other[c] : base[c];
            });
            await client.query(
                `UPDATE counseling_chats SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE chat_id = $1`,
                [newId, ...merged]
            );
            await client.query(`DELETE FROM counseling_chats WHERE chat_id = $1`, [oldId]);
        }
        // 회차·만남 기록 (새 방에 같은 기록이 이미 있으면 옛 것은 버림)
        await client.query(
            `UPDATE teacher_meetings t SET chat_id = $2 WHERE t.chat_id = $1 AND NOT EXISTS (
                 SELECT 1 FROM teacher_meetings x WHERE x.chat_id = $2
                   AND (x.message_id = t.message_id OR (x.student_id = t.student_id AND x.meeting_date = t.meeting_date)))`,
            [oldId, newId]
        );
        await client.query(`DELETE FROM teacher_meetings WHERE chat_id = $1`, [oldId]);
        await client.query(
            `UPDATE meeting_events e SET chat_id = $2 WHERE e.chat_id = $1 AND NOT EXISTS (
                 SELECT 1 FROM meeting_events x WHERE x.chat_id = $2 AND x.student_id = e.student_id AND x.source = e.source)`,
            [oldId, newId]
        );
        await client.query(`DELETE FROM meeting_events WHERE chat_id = $1`, [oldId]);
        await client.query(`UPDATE counseling_meeting_log SET chat_id = $2 WHERE chat_id = $1`, [oldId, newId]);
        // 지역 담당방이 바뀐 경우
        await client.query(
            `INSERT INTO region_chats (chat_id, region, registered_by, registered_at)
             SELECT $2, region, registered_by, registered_at FROM region_chats WHERE chat_id = $1
             ON CONFLICT (chat_id, region) DO NOTHING`,
            [oldId, newId]
        );
        await client.query(`DELETE FROM region_chats WHERE chat_id = $1`, [oldId]);
        await client.query(
            `INSERT INTO authorized_chats (chat_id, authorized_by) VALUES ($1, 'migration') ON CONFLICT (chat_id) DO NOTHING`,
            [newId]
        );
        await client.query('COMMIT');
        console.log(`[슈퍼그룹 전환 기록 합침] ${oldId} -> ${newId}`);
    } catch (err: unknown) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[슈퍼그룹 전환 기록 합치기 실패]:', getErrorMessage(err));
    } finally {
        client.release();
    }
}

async function authorizeChat(chatId: number | string, byUserId: number | string) {
    await neonPool.query(
        `INSERT INTO authorized_chats (chat_id, authorized_by) VALUES ($1, $2) ON CONFLICT (chat_id) DO NOTHING;`,
        [String(chatId), String(byUserId)]
    );
}

function displayName(user: { first_name?: string; last_name?: string; username?: string }): string {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || '이름 없음';
    return user.username ? `${name} (@${user.username})` : name;
}

const CHAT_ID_COMMAND = /^[\/!](?:방|채팅방|대화방|내)\s*(?:ID|아이디)(?:@\w+)?$|^[\/!](?:chat_?id|id)(?:@\w+)?$/i;

const AUTH_REQUEST_KEYBOARD = {
    reply_markup: { inline_keyboard: [[{ text: '🔐 인증 요청하기', callback_data: 'auth_request' }]] },
};

bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    // 봇 초대/퇴장 이벤트는 my_chat_member 핸들러에서 초대한 사람을 직접 확인
    if (!chat || ctx.myChatMember) return next();

    if (chat.type === 'private') {
        const status = await getUserAuthStatus(ctx.from?.id);
        if (status === 'approved') return next();

        const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
        if (data === 'auth_request') return handleAuthRequest(ctx);
        if (ctx.callbackQuery) return ctx.answerCbQuery('🔒 인증 후 사용할 수 있습니다.');

        if (ctx.message) {
            if (status === 'pending') {
                await ctx.reply('⏳ 인증 요청이 접수되어 관리자 승인을 기다리고 있습니다. 승인되면 알려드릴게요.');
            } else if (status === 'rejected') {
                await ctx.reply('⛔ 사용 권한이 없습니다. 필요하시면 관리자에게 문의해주세요.');
            } else {
                await ctx.reply(
                    '🔒 <b>이 봇은 인증된 사용자만 사용할 수 있습니다.</b>\n\n' +
                        '아래 버튼을 눌러 인증을 요청해주세요. 관리자가 승인하면 바로 사용할 수 있습니다.\n' +
                        '<i>(인증은 처음 한 번만 하면 됩니다)</i>',
                    { parse_mode: 'HTML', ...AUTH_REQUEST_KEYBOARD }
                );
            }
        }
        return;
    }

    const message = ctx.message as Record<string, any> | undefined;
    // 일반 그룹이 슈퍼그룹으로 바뀌면 방 ID가 바뀐다. 옛 방에는 migrate_to_chat_id, 새 방에는 migrate_from_chat_id가 온다.
    // 새 방은 '봇이 추가됨'(my_chat_member)으로 먼저 인증·빈 기록이 생길 수 있으므로, 인증 여부와 관계없이 먼저 기록을 합친다
    if (message?.migrate_to_chat_id && (await isAuthorizedChat(chat.id))) {
        await authorizeChat(message.migrate_to_chat_id, 'migration');
        await mergeMigratedChat(chat.id, message.migrate_to_chat_id);
        return;
    }
    if (message?.migrate_from_chat_id && (await isAuthorizedChat(message.migrate_from_chat_id))) {
        await authorizeChat(chat.id, 'migration');
        await mergeMigratedChat(message.migrate_from_chat_id, chat.id);
        return;
    }
    if (await isAuthorizedChat(chat.id)) return next();
    // 인증되지 않은 방의 메시지는 무시 — 단, 관리자의 /방ID 는 허용
    const text = typeof message?.text === 'string' ? message.text : '';
    if (CHAT_ID_COMMAND.test(text) && isAdmin(ctx.from?.id)) return next();
});

async function handleAuthRequest(ctx: any) {
    await ctx.answerCbQuery();
    const from = ctx.from;
    const userId = String(from.id);

    const status = await getUserAuthStatus(userId);
    if (status === 'pending') {
        await ctx.reply('⏳ 이미 인증 요청이 접수되어 있습니다. 관리자 승인을 기다려주세요.');
        return;
    }
    if (status === 'rejected') {
        await ctx.reply('⛔ 사용 권한이 없습니다. 필요하시면 관리자에게 문의해주세요.');
        return;
    }

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
    await neonPool.query(
        `INSERT INTO verified_users (user_id, name, username, status, requested_at)
         VALUES ($1, $2, $3, 'pending', NOW())
         ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username,
             status = 'pending', requested_at = NOW();`,
        [userId, name, from.username || null]
    );

    let delivered = 0;
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(
                adminId,
                '🔐 <b>[봇 사용 인증 요청]</b>\n\n' +
                    `• 이름: <b>${escapeHtml(displayName(from))}</b>\n` +
                    `• 텔레그램 ID: <code>${userId}</code>\n\n` +
                    '승인하면 이 사람이 봇을 사용하고 방에 초대할 수 있습니다.',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ 승인', callback_data: `auth_ok:${userId}` },
                                { text: '❌ 거절', callback_data: `auth_no:${userId}` },
                            ],
                        ],
                    },
                }
            );
            delivered++;
        } catch (err: unknown) {
            // 관리자가 봇과 개인 대화를 시작하지 않았으면 보낼 수 없음
            console.error(`[인증 요청 알림 실패] Admin: ${adminId}`, getErrorMessage(err));
        }
    }

    await ctx.reply(
        delivered > 0
            ? '📨 인증 요청을 보냈습니다. 관리자가 승인하면 알려드릴게요.'
            : '📨 인증 요청이 접수되었습니다. 관리자에게 승인을 요청해주세요.'
    );
}

// 관리자: 인증 요청 승인/거절 버튼
bot.action(/^auth_(ok|no):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
        await ctx.answerCbQuery('⛔ 관리자만 처리할 수 있습니다.');
        return;
    }
    const approved = ctx.match[1] === 'ok';
    const userId = ctx.match[2];

    const res = await neonPool.query(
        `UPDATE verified_users SET status = $2, decided_at = NOW(), decided_by = $3
         WHERE user_id = $1 AND status = 'pending'
         RETURNING name, username;`,
        [userId, approved ? 'approved' : 'rejected', String(ctx.from?.id)]
    );

    if (!res.rowCount) {
        await ctx.answerCbQuery('이미 처리된 요청입니다.');
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        return;
    }

    const user = res.rows[0];
    await ctx.answerCbQuery(approved ? '승인했습니다.' : '거절했습니다.');
    await ctx
        .editMessageText(
            `🔐 <b>[봇 사용 인증 요청]</b>\n\n` +
                `• 이름: <b>${escapeHtml(displayName({ first_name: user.name, username: user.username }))}</b>\n` +
                `• 텔레그램 ID: <code>${userId}</code>\n\n` +
                (approved ? '✅ <b>승인 완료</b>' : '❌ <b>거절됨</b>') +
                ` (처리: ${escapeHtml(displayName(ctx.from))})`,
            { parse_mode: 'HTML' }
        )
        .catch(() => {});

    try {
        await bot.telegram.sendMessage(
            userId,
            approved
                ? '✅ <b>인증이 승인되었습니다!</b>\n\n이제 상담방에 봇을 초대해서 사용할 수 있습니다. 사용법은 /도움말 을 입력하세요.'
                : '⛔ 인증 요청이 거절되었습니다. 필요하시면 관리자에게 문의해주세요.',
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error(`[인증 결과 알림 실패] User: ${userId}`, getErrorMessage(err));
    }
});

// 관리자: 인증 사용자 목록 (관리자 인증목록)
bot.hears(/^(?:[\/!]?관리자\s+)(인증\s*목록|인증\s*현황|인증)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const res = await neonPool.query(
            `SELECT user_id, name, username, status FROM verified_users
             ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, requested_at DESC;`
        );
        if (res.rows.length === 0) {
            await ctx.reply('ℹ️ 인증 요청한 사용자가 아직 없습니다.');
            return;
        }

        const label: Record<string, string> = { pending: '⏳ 대기', approved: '✅ 승인', rejected: '⛔ 차단' };
        const header =
            `🔐 <b>[봇 사용 인증 현황] (총 ${res.rows.length}명)</b>\n` +
            `<i>해제: <code>관리자 인증해제 ID</code> · 승인: <code>관리자 인증승인 ID</code></i>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, res.rows, (u: Record<string, any>, idx) =>
            `${idx}. ${label[u.status] || u.status} <b>${escapeHtml(
                displayName({ first_name: u.name, username: u.username })
            )}</b> · <code>${escapeHtml(u.user_id)}</code>\n`
        );
    } catch (err: unknown) {
        console.error('[인증 목록 조회 에러]:', err);
        await replyError(ctx, '인증 목록 조회', err);
    }
});

// 관리자: 인증 해제/승인 (관리자 인증해제 ID, 관리자 인증승인 ID)
bot.hears(/^(?:[\/!]?관리자\s+)인증\s*(해제|승인)\s+(\d+)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }
        const approve = ctx.match[1] === '승인';
        const userId = ctx.match[2];

        const res = await neonPool.query(
            `UPDATE verified_users SET status = $2, decided_at = NOW(), decided_by = $3
             WHERE user_id = $1 RETURNING name, username;`,
            [userId, approve ? 'approved' : 'rejected', String(ctx.from?.id)]
        );
        if (!res.rowCount) {
            await ctx.reply(`❌ ID <code>${escapeHtml(userId)}</code> 사용자를 찾을 수 없습니다.`, { parse_mode: 'HTML' });
            return;
        }

        const name = escapeHtml(displayName({ first_name: res.rows[0].name, username: res.rows[0].username }));
        if (approve) {
            await ctx.reply(`✅ <b>${name}</b> 님을 승인했습니다.`, { parse_mode: 'HTML' });
            return;
        }

        // 이 사람이 초대해서 쓰고 있는 방
        const rooms = await getChatsAuthorizedBy(userId);
        let msg = `⛔ <b>${name}</b> 님의 인증을 해제했습니다.\n`;
        if (rooms.length === 0) {
            msg += `<i>(이 사람이 초대한 방은 없습니다)</i>`;
            await ctx.reply(msg, { parse_mode: 'HTML' });
            return;
        }
        msg +=
            `\n이 사람이 초대한 방 <b>${rooms.length}개</b>는 계속 사용됩니다:\n` +
            rooms.map((r, i) => `${i + 1}. ${escapeHtml(r.title)}`).join('\n') +
            `\n\n<i>막으려면 아래 버튼으로 이 방들에서 봇을 내보낼 수 있습니다. (방 기록은 보관되어 다시 초대하면 복원됩니다)</i>`;
        await replyLong(ctx, msg, {
            reply_markup: {
                inline_keyboard: [[{ text: `🚪 ${rooms.length}개 방에서 봇 내보내기`, callback_data: `authleave:${userId}` }]],
            },
        });
    } catch (err: unknown) {
        console.error('[인증 변경 에러]:', err);
        await replyError(ctx, '인증 변경', err);
    }
});

// 특정 사용자가 초대해서 인증된 상담방 목록 (방 이름이 기록에 없으면 ID)
async function getChatsAuthorizedBy(userId: string): Promise<{ chat_id: string; title: string }[]> {
    const res = await neonPool.query(
        `SELECT a.chat_id, COALESCE(c.room_title, a.chat_id) AS title
         FROM authorized_chats a
         LEFT JOIN counseling_chats c ON c.chat_id = a.chat_id
         WHERE a.authorized_by = $1
           AND NOT EXISTS (SELECT 1 FROM region_chats r WHERE r.chat_id = a.chat_id) -- 지역 담당방은 관리자가 관리하므로 제외
         ORDER BY title;`,
        [userId]
    );
    return res.rows;
}

// 관리자: 인증 해제한 사람이 초대한 방에서 봇 내보내기
bot.action(/^authleave:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
        await ctx.answerCbQuery('⛔ 관리자만 처리할 수 있습니다.');
        return;
    }
    await ctx.answerCbQuery('처리 중입니다…');
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    try {
        const rooms = await getChatsAuthorizedBy(ctx.match[1]);
        let left = 0;
        const failed: string[] = [];
        for (const r of rooms) {
            try {
                await bot.telegram.leaveChat(r.chat_id);
                left++;
            } catch (err: unknown) {
                // 이미 봇이 없는 방이면 인증 기록만 정리
                await neonPool.query(`DELETE FROM authorized_chats WHERE chat_id = $1`, [r.chat_id]).catch(() => {});
                failed.push(`${r.title} (${getErrorMessage(err)})`);
            }
        }
        await ctx.reply(
            `🚪 <b>${left}개 방에서 봇을 내보냈습니다.</b>` +
                (failed.length
                    ? `\n\n⚠️ 내보내지 못한 방 ${failed.length}개 (인증 기록은 정리함):\n` + failed.map((f) => `• ${escapeHtml(f)}`).join('\n')
                    : ''),
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[인증 해제 방 내보내기 에러]:', err);
        await replyError(ctx, '봇 내보내기', err);
    }
});

/* =====================================================
 * 📍 지역 담당방 (인도자·교사 지역별 담당자 단톡방으로 자동 알림)
 * - 담당방에서 관리자가 /담당방등록 강북  (여러 지역: /담당방등록 강북,강남)
 * - 알림: 보고서 지연(D+2), 만남 중단, 매일 오전 10시·밤 10시 지역 요약
 * - 인도자 지역과 교사 지역 담당방 모두에 보내고, 같은 방이면 한 번만
 * ===================================================== */
type RegionChat = { chat_id: string; region: string };

function normalizeRegion(region?: string | null): string {
    return (region || '').replace(/\s/g, '');
}

// '강북' 등록 시 members.지역 '강북' / '강북지역' 모두 매칭 (/최초등록과 같은 양방향 포함 비교)
function regionMatches(registered: string, actual?: string | null): boolean {
    const r = normalizeRegion(registered);
    const a = normalizeRegion(actual);
    return !!r && !!a && (a === r || a.includes(r) || r.includes(a));
}

async function getRegionChats(): Promise<RegionChat[]> {
    const res = await neonPool.query(`SELECT chat_id, region FROM region_chats ORDER BY region, chat_id;`);
    return res.rows;
}

async function isRegionChat(chatId: number | string): Promise<boolean> {
    const res = await neonPool.query(`SELECT 1 FROM region_chats WHERE chat_id = $1 LIMIT 1`, [String(chatId)]);
    return res.rows.length > 0;
}

function regionChatIdsFor(chat: Pick<ChatRecord, 'guide_region' | 'teacher_region'>, regionChats: RegionChat[]): string[] {
    const ids = regionChats
        .filter((rc) => regionMatches(rc.region, chat.guide_region) || regionMatches(rc.region, chat.teacher_region))
        .map((rc) => rc.chat_id);
    return [...new Set(ids)];
}

function regionRoomInfo(c: ChatRecord): string {
    const guideWhere = [c.guide_region, c.guide_district].filter(Boolean).join(' ');
    return (
        `• 방: <b>${escapeHtml(c.room_title || '대화방')}</b>` +
        (c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : '') +
        `\n• 인도자: ${
            c.guide_name ? `${escapeHtml(c.guide_name)}${guideWhere ? ` (${escapeHtml(guideWhere)})` : ''}` : '미등록'
        }\n` +
        `• 교사: ${teacherText(c)}\n`
    );
}

// 상담방 하나에 대한 알림을 해당 지역 담당방들에 발송 (실패해도 상담방 처리는 계속)
// 담당방이 없는 지역(또는 미매칭 방)이면 관리자 개인 대화로 대신 보냄 — 알림이 사라지지 않도록
async function notifyRegionChats(chat: ChatRecord, message: string, regionChats?: RegionChat[]) {
    try {
        const targets = regionChatIdsFor(chat, regionChats ?? (await getRegionChats()));
        if (targets.length === 0) {
            const regions = [...new Set([chat.guide_region, chat.teacher_region].filter(Boolean))].join(', ') || '지역 미확인';
            for (const adminId of ADMIN_IDS) {
                await bot.telegram
                    .sendMessage(adminId, `<i>(담당방 없음: ${escapeHtml(regions)} → 관리자에게 대신 전달)</i>\n` + message, {
                        parse_mode: 'HTML',
                    })
                    .catch((err) => console.error(`[담당방 대체 알림 실패] ${adminId}:`, getErrorMessage(err)));
            }
            return;
        }
        for (const target of targets) {
            await bot.telegram
                .sendMessage(target, message, { parse_mode: 'HTML' })
                .catch((err) => console.error(`[지역 담당방 알림 실패] ${target}:`, getErrorMessage(err)));
        }
    } catch (err: unknown) {
        console.error('[지역 담당방 알림 에러]:', getErrorMessage(err));
    }
}

// 담당방 등록 (/담당방등록 강북 또는 /담당방등록 강북,강남)
bot.hears(/^[\/!]담당방\s*등록(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 관리자만 담당방을 등록할 수 있습니다.');
            return;
        }
        if (ctx.chat.type === 'private') {
            await ctx.reply('⚠️ 지역 담당자 단톡방에서 입력해주세요.');
            return;
        }

        const regions = (ctx.match[1] || '')
            .split(/[,，/\s]+/)
            .map((r) => r.trim())
            .filter(Boolean);
        if (regions.length === 0) {
            await ctx.reply(
                '⚠️ 지역을 입력해주세요.\n예: <code>/담당방등록 강북</code> (여러 지역: <code>/담당방등록 강북,강남</code>)',
                { parse_mode: 'HTML' }
            );
            return;
        }

        // members 테이블에 없는 지역명은 오타일 가능성이 높으므로 등록하지 않음
        const known = (await neonPool.query(`SELECT DISTINCT "지역" FROM members WHERE "지역" IS NOT NULL;`)).rows.map(
            (r) => String(r['지역'])
        );
        const unknown = regions.filter((r) => !known.some((k) => regionMatches(r, k)));
        if (unknown.length > 0) {
            await ctx.reply(
                `❌ 등록된 지역에서 찾을 수 없습니다: <b>${escapeHtml(unknown.join(', '))}</b>\n\n` +
                    `• 사용 가능한 지역: ${escapeHtml(known.sort().join(', ') || '없음')}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const chatId = String(ctx.chat.id);
        for (const region of regions) {
            await neonPool.query(
                `INSERT INTO region_chats (chat_id, region, registered_by) VALUES ($1, $2, $3)
                 ON CONFLICT (chat_id, region) DO NOTHING;`,
                [chatId, region, String(ctx.from?.id)]
            );
        }
        // 담당방은 상담방이 아니므로 상담방 목록·점검에서 제외
        await neonPool.query(`DELETE FROM counseling_chats WHERE chat_id = $1;`, [chatId]);

        const all = (await neonPool.query(`SELECT region FROM region_chats WHERE chat_id = $1 ORDER BY region`, [chatId]))
            .rows.map((r) => r.region);
        await ctx.reply(
            `📍 <b>지역 담당방으로 등록되었습니다.</b>\n\n` +
                `• 담당 지역: <b>${escapeHtml(all.join(', '))}</b>\n\n` +
                `이 지역 인도자·교사의 상담방에 대해 아래 알림이 이 방으로 옵니다.\n` +
                `• 🚨 보고서 제출 지연 (만남일 2일 경과)\n` +
                `• 🛑 만남 중단 발생\n` +
                `• ☀️ 매일 오전 10시 지역 요약 (오늘 만남 · 보고서 미제출)\n` +
                `• 🌙 매일 밤 10시 마감 요약 (오늘 신규 만남 · 오늘 보고서 미제출 · 내일 만남)\n\n` +
                `<i>해제: <code>/담당방해제</code> (특정 지역만: <code>/담당방해제 강북</code>)</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[담당방 등록 에러]:', err);
        await replyError(ctx, '담당방 등록', err);
    }
});

// 담당방 해제 (/담당방해제 또는 /담당방해제 강북)
bot.hears(/^[\/!]담당방\s*해제(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 관리자만 담당방을 해제할 수 있습니다.');
            return;
        }
        const chatId = String(ctx.chat.id);
        const regions = (ctx.match[1] || '')
            .split(/[,，/\s]+/)
            .map((r) => r.trim())
            .filter(Boolean);

        const res = regions.length
            ? await neonPool.query(`DELETE FROM region_chats WHERE chat_id = $1 AND region = ANY($2::text[]);`, [
                  chatId,
                  regions,
              ])
            : await neonPool.query(`DELETE FROM region_chats WHERE chat_id = $1;`, [chatId]);

        if (!res.rowCount) {
            await ctx.reply('ℹ️ 이 방은 해당 지역 담당방으로 등록되어 있지 않습니다.');
            return;
        }
        const left = (await neonPool.query(`SELECT region FROM region_chats WHERE chat_id = $1 ORDER BY region`, [chatId]))
            .rows.map((r) => r.region);
        await ctx.reply(
            left.length
                ? `✅ 해제했습니다. 남은 담당 지역: <b>${escapeHtml(left.join(', '))}</b>`
                : '✅ 지역 담당방 등록이 해제되었습니다. 더 이상 지역 알림이 오지 않습니다.',
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[담당방 해제 에러]:', err);
        await replyError(ctx, '담당방 해제', err);
    }
});

// 관리자: 등록된 담당방 목록 (관리자 담당방)
bot.hears(/^(?:[\/!]?관리자\s+)(담당방|담당방\s*목록|지역\s*담당방)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }
        const regionChats = await getRegionChats();
        if (regionChats.length === 0) {
            await ctx.reply(
                'ℹ️ 등록된 지역 담당방이 없습니다.\n담당방에 봇을 초대한 뒤 그 방에서 <code>/담당방등록 지역명</code>을 입력하세요.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        let msg = `📍 <b>[지역 담당방 목록] (${regionChats.length}건)</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
        for (const rc of regionChats) {
            let title = rc.chat_id;
            try {
                const info = await bot.telegram.getChat(rc.chat_id);
                if ('title' in info && info.title) title = info.title;
            } catch {
                title = `${rc.chat_id} (⚠️ 봇이 방에 없음)`;
            }
            msg += `• <b>${escapeHtml(rc.region)}</b> → ${escapeHtml(title)}\n`;
        }
        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[담당방 목록 에러]:', err);
        await replyError(ctx, '담당방 목록 조회', err);
    }
});

// 관리자: 담당방 공지 (/담당방공지 내용 → 전체, /담당방공지 [강북,강남] 내용 → 해당 지역만)
// 미리보기 후 [보내기]를 눌러야 발송. 대기 중인 공지는 메모리에만 두므로 서버 재시작 시 다시 작성
const pendingNotices = new Map<string, { text: string; targets: string[]; label: string; adminId: string }>();

bot.hears(/^[\/!]담당방\s*공지(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 관리자만 담당방 공지를 보낼 수 있습니다.');
            return;
        }

        let body = ctx.match[1]?.trim() || '';
        let wanted: string[] = [];
        const bracket = body.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
        if (bracket) {
            wanted = bracket[1].split(/[,，/\s]+/).map((r) => r.trim()).filter(Boolean);
            body = bracket[2].trim();
        }
        if (!body) {
            await ctx.reply(
                '⚠️ 공지 내용을 입력해주세요.\n\n' +
                    '• 전체 담당방: <code>/담당방공지 내용</code>\n' +
                    '• 특정 지역만: <code>/담당방공지 [강북,강남] 내용</code>\n' +
                    '<i>(여러 줄로 작성할 수 있습니다)</i>',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const regionChats = await getRegionChats();
        const selected = wanted.length
            ? regionChats.filter((rc) => wanted.some((w) => regionMatches(w, rc.region)))
            : regionChats;
        const targets = [...new Set(selected.map((rc) => rc.chat_id))];
        if (targets.length === 0) {
            await ctx.reply(
                wanted.length
                    ? `❌ <b>${escapeHtml(wanted.join(', '))}</b> 지역으로 등록된 담당방이 없습니다. (<code>관리자 담당방</code>으로 확인)`
                    : 'ℹ️ 등록된 지역 담당방이 없습니다.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const label = wanted.length ? [...new Set(selected.map((rc) => rc.region))].join(', ') : '전체';
        const id = Math.random().toString(36).slice(2, 10);
        pendingNotices.set(id, { text: body, targets, label, adminId: String(ctx.from?.id) });

        await ctx.reply(
            `📢 <b>[담당방 공지 미리보기]</b>\n` +
                `• 대상: <b>${escapeHtml(label)}</b> (담당방 ${targets.length}곳)\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `${escapeHtml(body)}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `<i>아래 [보내기]를 눌러야 발송됩니다.</i>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📨 보내기', callback_data: `notice:send:${id}` },
                            { text: '취소', callback_data: `notice:cancel:${id}` },
                        ],
                    ],
                },
            }
        );
    } catch (err: unknown) {
        console.error('[담당방 공지 에러]:', err);
        await replyError(ctx, '담당방 공지 준비', err);
    }
});

bot.action(/^notice:(send|cancel):(\w+)$/, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.answerCbQuery('⛔ 관리자만 처리할 수 있습니다.');
            return;
        }
        const [, action, id] = ctx.match;
        const notice = pendingNotices.get(id);
        pendingNotices.delete(id); // 두 번 눌러도 한 번만 발송

        if (!notice) {
            await ctx.answerCbQuery('이미 처리되었거나 만료된 공지입니다.');
            await ctx.editMessageReplyMarkup(undefined).catch(() => {});
            return;
        }
        if (action === 'cancel') {
            await ctx.answerCbQuery('취소했습니다.');
            await ctx.editMessageText('↩️ 담당방 공지가 취소되었습니다.');
            return;
        }

        await ctx.answerCbQuery('발송 중입니다...');
        const message = `📢 <b>[공지]</b>\n\n${escapeHtml(notice.text)}`;
        const failed: string[] = [];
        for (const target of notice.targets) {
            try {
                await bot.telegram.sendMessage(target, message, { parse_mode: 'HTML' });
            } catch (err: unknown) {
                console.error(`[담당방 공지 발송 실패] ${target}:`, getErrorMessage(err));
                failed.push(target);
            }
        }

        const sent = notice.targets.length - failed.length;
        await ctx.editMessageText(
            `✅ <b>담당방 공지 발송 완료</b> (대상: ${escapeHtml(notice.label)})\n` +
                `• 성공: ${sent}곳` +
                (failed.length ? `\n• 실패: ${failed.length}곳 (봇이 방에 없을 수 있음: <code>관리자 담당방</code>으로 확인)` : '') +
                `\n━━━━━━━━━━━━━━━━━━\n${escapeHtml(notice.text)}`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[담당방 공지 발송 에러]:', err);
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

/* =====================================================
 * 🆕 신규 만남 발생 (상담 이하 = 인터뷰 매칭 / 상담 1회차 = 교사 매칭)
 * ===================================================== */
type MeetingCategory = '인터뷰매칭' | '지인매칭' | '교사매칭';
const MEETING_CATEGORY_LABEL: Record<MeetingCategory, string> = {
    인터뷰매칭: '🎙️ 상담 이하 (인터뷰 매칭)',
    지인매칭: '🤝 지인 만남',
    교사매칭: '👨‍🏫 상담 1회차 (교사 매칭)',
};

type MeetingEvent = ChatRecord & { category: MeetingCategory; source: string; occurred_at: string };

// 같은 방·대상자·경로는 한 번만 기록 (첫 만남 유형 버튼을 다시 누르면 유형만 바뀌고 발생일은 유지)
async function recordMeetingEvent(chatId: number | string, category: MeetingCategory, source: '최초등록' | '인터뷰후속' | '지인후속' | '행사후속') {
    try {
        const record = await getChatRecord(chatId);
        if (!record?.matched_member_id) return;
        await neonPool.query(
            `INSERT INTO meeting_events (chat_id, student_id, category, source) VALUES ($1, $2, $3, $4)
             ON CONFLICT (chat_id, student_id, source) DO UPDATE SET category = EXCLUDED.category;`,
            [String(chatId), String(record.matched_member_id), category, source]
        );
    } catch (err: unknown) {
        console.error('[신규 만남 기록 실패]:', getErrorMessage(err));
    }
}

// 기간 내 발생 건 (인도자·교사는 현재 정보로 표시)
async function getMeetingEvents(from: dayjs.Dayjs, to: dayjs.Dayjs): Promise<MeetingEvent[]> {
    const res = await neonPool.query(
        `SELECT
            e.category, e.source, e.occurred_at,
            c.room_title,
            s."이름" AS matched_student_name,
            m."이름" AS guide_name, m."지역" AS guide_region, m."구역" AS guide_district,
            t."이름" AS teacher_name, t."지역" AS teacher_region, t."구역" AS teacher_district
         FROM meeting_events e
         LEFT JOIN counseling_chats c ON c.chat_id = e.chat_id
         LEFT JOIN students s ON s.id::text = e.student_id
         LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
         LEFT JOIN members t ON s."교사_고유번호" = t."고유번호"
         WHERE e.occurred_at >= $1 AND e.occurred_at < $2
         ORDER BY e.occurred_at;`,
        [from.toISOString(), to.toISOString()]
    );
    return res.rows;
}

function meetingEventLine(e: MeetingEvent, withDate = true): string {
    const guideWhere = [e.guide_region, e.guide_district].filter(Boolean).join(' ');
    return (
        `• ${withDate ? `${dayjs(e.occurred_at).tz('Asia/Seoul').format('MM/DD')} ` : ''}` +
        // 실명이 있으면 실명만 (방 제목은 이름을 가려 둔 경우가 많음), 없으면 방 제목
        (e.matched_student_name
            ? `<b>${escapeHtml(e.matched_student_name)}</b>`
            : `${escapeHtml(e.room_title || '이름 없음')} <i>(미매칭)</i>`) +
        ` · 인도자 ${escapeHtml(e.guide_name || '-')}${guideWhere ? `(${escapeHtml(guideWhere)})` : ''}` +
        (e.category === '교사매칭' ? ` · 교사 ${teacherText(e)}` : '') +
        ({ 인터뷰후속: ' · <i>인터뷰 후속</i>', 지인후속: ' · <i>지인 후속</i>', 행사후속: ' · <i>행사 후속</i>' }[e.source] ?? '') +
        `\n`
    );
}

// 카테고리별로 묶어서 표시
function formatMeetingEvents(events: MeetingEvent[], withDate = true): string {
    let msg = '';
    for (const category of Object.keys(MEETING_CATEGORY_LABEL) as MeetingCategory[]) {
        const list = events.filter((e) => e.category === category);
        msg += `${MEETING_CATEGORY_LABEL[category]}: <b>${list.length}건</b>\n`;
        msg += list.map((e) => meetingEventLine(e, withDate)).join('');
        msg += `\n`;
    }
    return msg;
}

// 관리자: 신규 만남 발생 조회 (관리자 신규 [오늘|어제|이번주|지난주|n월], 기본 이번주)
bot.hears(/^(?:[\/!]?관리자\s+)신규(?:\s*만남)?(?:\s+(오늘|어제|이번\s*주|지난\s*주|\d{1,2}\s*월))?$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const thisMonday = today.subtract((today.day() + 6) % 7, 'day');
        const period = (ctx.match[1] || '이번주').replace(/\s/g, '');
        let from: dayjs.Dayjs;
        let to: dayjs.Dayjs;
        let label: string;

        const monthMatch = period.match(/^(\d{1,2})월$/);
        if (period === '오늘') {
            [from, to, label] = [today, today.add(1, 'day'), `오늘 ${today.format('MM/DD')}`];
        } else if (period === '어제') {
            from = today.subtract(1, 'day');
            [to, label] = [today, `어제 ${from.format('MM/DD')}`];
        } else if (period === '지난주') {
            from = thisMonday.subtract(7, 'day');
            [to, label] = [thisMonday, `지난주 ${from.format('MM/DD')} ~ ${thisMonday.subtract(1, 'day').format('MM/DD')}`];
        } else if (monthMatch) {
            const month = Number(monthMatch[1]);
            if (month < 1 || month > 12) {
                await ctx.reply('⚠️ 월은 1~12 사이로 입력해주세요.');
                return;
            }
            // 아직 오지 않은 달이면 작년으로 해석
            const year = month > today.month() + 1 ? today.year() - 1 : today.year();
            from = dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, 'Asia/Seoul');
            [to, label] = [from.add(1, 'month'), `${year}년 ${month}월`];
        } else {
            [from, to, label] = [thisMonday, today.add(1, 'day'), `이번주 ${thisMonday.format('MM/DD')} ~ ${today.format('MM/DD')}`];
        }

        const events = await getMeetingEvents(from, to);
        const header =
            `🆕 <b>[신규 만남 발생] ${escapeHtml(label)}</b> (총 ${events.length}건)\n` +
            `<i>기간: <code>관리자 신규 오늘</code> · <code>어제</code> · <code>이번주</code> · <code>지난주</code> · <code>10월</code></i>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;
        await replyLong(ctx, header + formatMeetingEvents(events));
    } catch (err: unknown) {
        console.error('[신규 만남 조회 에러]:', err);
        await replyError(ctx, '신규 만남 조회', err);
    }
});

// 인터뷰 후 교사 만남 미배정: 결과 보고서로 후속 [신청]까지 했는데, 인터뷰일로부터 3일이 지나도록
// 교사 만남 기록이 없고 앞으로 잡힌 교사 만남일도 없는 방 → 인터뷰일로부터 지난 일수 (해당 없으면 null)
const WAITING_TEACHER_DAYS = 3;
function waitingTeacherDays(c: ChatRecord, today: dayjs.Dayjs, todayStr: string): number | null {
    if (c.meeting_date === '중단' || !c.interview_report_submitted || c.follow_up_applied !== '신청') return null;
    if (!isYmd(c.interview_date) || (c.teacher_meeting_count ?? 0) > 0) return null;
    if (isYmd(c.meeting_date) && c.meeting_date >= todayStr) return null; // 교사 만남일이 잡혀 있음
    const days = today.diff(dayjs(c.interview_date).startOf('day'), 'day');
    return days >= WAITING_TEACHER_DAYS ? days : null;
}

// 요약에 넣을 '확인 필요' 항목 (진행 멈춤 안내와 같은 기준) — 보고서 미제출은 요약의 미제출 항목과 겹쳐서 제외
const SUMMARY_SKIP_NUDGES = new Set(['no_post', 'report_late']);

// 크론에서 호출: 지역 담당방마다 하루 요약 (오전 10시 'morning' / 밤 10시 'night', 각각 하루 한 번)
// - 오전: 오늘 만남 · 보고서 미제출 · 교사 만남 미배정 · 확인 필요
// - 밤: 오늘 만남 중 보고서 미제출 · 이전 만남 미제출 · 교사 만남 미배정 · 확인 필요 · 내일 만남
// - 이름은 방 제목(가린 이름) 대신 매칭된 대상자 실명으로 표시
//   (보고서가 제출되면 만남일이 다음 만남일로 바뀌므로, 밤에 만남일이 오늘인 방 = 아직 보고서가 안 올라온 방)
async function sendRegionDailySummaries(mode: 'morning' | 'night') {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const todayStr = today.format('YYYY-MM-DD');
    const tomorrowStr = today.add(1, 'day').format('YYYY-MM-DD');
    const metaKey = mode === 'morning' ? 'region_summary_sent' : 'region_night_summary_sent';
    const already = await neonPool.query(`SELECT value FROM bot_meta WHERE key = $1`, [metaKey]);
    if (already.rows[0]?.value === todayStr) return; // 같은 날 크론이 여러 번 호출돼도 한 번만

    const regionChats = await getRegionChats();
    if (regionChats.length === 0) return;
    const chats = await getAllChats();
    const todayEvents = mode === 'night' ? await getMeetingEvents(today, today.add(1, 'day')) : [];

    const regionsByChat = new Map<string, string[]>();
    for (const rc of regionChats) regionsByChat.set(rc.chat_id, [...(regionsByChat.get(rc.chat_id) || []), rc.region]);

    const line = (c: ChatRecord) =>
        `• ${c.matched_student_name ? `<b>${escapeHtml(c.matched_student_name)}</b>` : `${escapeHtml(c.room_title || '대화방')} <i>(미매칭)</i>`}` +
        ` · 인도자 ${escapeHtml(c.guide_name || '-')} · 교사 ${escapeHtml(c.teacher_name || '-')}`;
    const MAX_LINES = 20;
    const listText = (lines: string[]) =>
        lines.slice(0, MAX_LINES).join('') + (lines.length > MAX_LINES ? `…외 ${lines.length - MAX_LINES}건\n` : '');
    const meetingLine = (c: ChatRecord) =>
        `${line(c)}${c.meeting_type ? ` [${c.meeting_type}]` : ''}${c.meeting_time ? ` ${escapeHtml(c.meeting_time)}` : ''}\n`;
    const dayLabel = (d: dayjs.Dayjs) => `${d.format('MM/DD')} (${'일월화수목금토'[d.day()]})`;

    for (const [target, regions] of regionsByChat) {
        const mine = chats.filter((c) =>
            regions.some((r) => regionMatches(r, c.guide_region) || regionMatches(r, c.teacher_region))
        );
        const todayMeetings = mine.filter((c) => c.meeting_date === todayStr);
        const overdue = mine
            .filter((c) => isPastMeetingDate(c, todayStr) && !c.report_submitted && needsReport(c))
            .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));

        let overdueText = '';
        for (const c of overdue) {
            overdueText += `${line(c)} · ${c.meeting_type === '인터뷰' ? '인터뷰일' : '만남일'} ${dayjs(c.meeting_date).format('MM/DD')} (${today.diff(
                dayjs(c.meeting_date),
                'day'
            )}일 경과)\n`;
        }

        // 인터뷰 후 교사 만남 미배정
        const waiting = mine
            .map((c) => ({ c, days: waitingTeacherDays(c, today, todayStr) }))
            .filter((w): w is { c: ChatRecord; days: number } => w.days !== null)
            .sort((a, b) => b.days - a.days);
        const waitingText =
            waiting.length === 0
                ? ''
                : `\n🧑‍🏫 <b>인터뷰 후 교사 만남 미배정 (${WAITING_TEACHER_DAYS}일 이상): ${waiting.length}건</b>\n` +
                  listText(waiting.map(({ c, days }) => `${line(c)} · 인터뷰 ${dayjs(c.interview_date).format('MM/DD')} (${days}일째)\n`));

        // 확인 필요 (진행 멈춤 안내 기준, 항목별)
        const needs = new Map<string, string[]>();
        for (const c of mine) {
            const nudge = getRoomNudge(c, today, todayStr);
            if (!nudge || SUMMARY_SKIP_NUDGES.has(nudge.key)) continue;
            needs.set(nudge.label, [...(needs.get(nudge.label) || []), `${line(c)}\n`]);
        }
        const needsCount = [...needs.values()].reduce((n, l) => n + l.length, 0);
        const needsText =
            needsCount === 0
                ? ''
                : `\n⏸ <b>확인 필요: ${needsCount}건</b>\n` +
                  [...needs.entries()].map(([label, lines]) => `<u>${escapeHtml(label)} ${lines.length}건</u>\n` + listText(lines)).join('');

        const regionName = escapeHtml(regions.join(', '));
        let msg: string;
        if (mode === 'morning') {
            if (todayMeetings.length === 0 && overdue.length === 0 && waiting.length === 0 && needsCount === 0) continue;
            msg = `☀️ <b>[${regionName} 지역 오늘의 요약] ${dayLabel(today)}</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
            msg += `🗓 <b>오늘 만남: ${todayMeetings.length}건</b>\n` + todayMeetings.map(meetingLine).join('');
            msg += `\n⚠️ <b>보고서 미제출: ${overdue.length}건</b>\n` + overdueText;
            msg += waitingText + needsText;
        } else {
            const todayUnreported = todayMeetings.filter((c) => !c.report_submitted && needsReport(c));
            const tomorrowMeetings = mine.filter((c) => c.meeting_date === tomorrowStr);
            const newEvents = todayEvents.filter((e) =>
                regions.some((r) => regionMatches(r, e.guide_region) || regionMatches(r, e.teacher_region))
            );
            if (
                todayUnreported.length === 0 &&
                overdue.length === 0 &&
                tomorrowMeetings.length === 0 &&
                newEvents.length === 0 &&
                waiting.length === 0 &&
                needsCount === 0
            )
                continue;
            msg = `🌙 <b>[${regionName} 지역 오늘 마감 요약] ${dayLabel(today)}</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
            msg += `🆕 <b>오늘 신규 만남 발생: ${newEvents.length}건</b>\n`;
            if (newEvents.length) msg += formatMeetingEvents(newEvents, false);
            else msg += `\n`;
            msg +=
                `📋 <b>오늘 만남 중 보고서 미제출: ${todayUnreported.length}건</b>\n` +
                todayUnreported.map(meetingLine).join('');
            msg += `\n⚠️ <b>이전 만남 보고서 미제출: ${overdue.length}건</b>\n` + overdueText;
            msg += waitingText + needsText;
            msg +=
                `\n🗓 <b>내일 만남: ${tomorrowMeetings.length}건</b>\n` + tomorrowMeetings.map(meetingLine).join('');
        }

        for (const part of splitLongMessage(msg)) {
            await bot.telegram
                .sendMessage(target, part, { parse_mode: 'HTML' })
                .catch((err) => console.error(`[지역 요약 발송 실패] ${target}:`, getErrorMessage(err)));
        }
    }

    await neonPool.query(
        `INSERT INTO bot_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [metaKey, todayStr]
    );
}

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

// 봇이 방에서 나갈 때 방 기록을 보관 (실수로 내보냈다가 다시 초대하면 매칭·회차 보정값 등을 그대로 복원)
async function archiveChat(chatId: string) {
    await neonPool.query(
        `INSERT INTO counseling_chats_left (chat_id, data, left_at)
         SELECT c.chat_id, to_jsonb(c), NOW() FROM counseling_chats c WHERE c.chat_id = $1
         ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data, left_at = NOW();`,
        [chatId]
    );
}

// 보관해 둔 방 기록 복원 — 복원했으면 true
async function restoreArchivedChat(chatId: string): Promise<boolean> {
    const res = await neonPool.query(
        `INSERT INTO counseling_chats
         SELECT (jsonb_populate_record(NULL::counseling_chats, l.data)).*
         FROM counseling_chats_left l WHERE l.chat_id = $1
         ON CONFLICT (chat_id) DO NOTHING
         RETURNING chat_id;`,
        [chatId]
    );
    await neonPool.query(`DELETE FROM counseling_chats_left WHERE chat_id = $1;`, [chatId]);
    return (res.rowCount ?? 0) > 0;
}

// 봇이 방에 추가되거나 퇴장당했을 때
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id;

    if (status === 'member' || status === 'administrator') {
        const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
        try {
            const inviter = ctx.myChatMember.from;
            if (ctx.chat.type === 'private') {
                // 개인 대화 시작 — 미인증 사용자는 /start 메시지에서 인증 안내
                if (!(await isVerifiedUser(inviter.id))) return;
            } else if (!(await isAuthorizedChat(chatId))) {
                if (!(await isVerifiedUser(inviter.id))) {
                    await ctx.reply(
                        '🔒 <b>인증된 사용자만 이 봇을 방에 초대할 수 있습니다.</b>\n\n' +
                            `봇 개인 대화(@${escapeHtml(ctx.botInfo.username)})에서 /start 로 인증을 요청하고, ` +
                            '관리자 승인 후 다시 초대해주세요.',
                        { parse_mode: 'HTML' }
                    );
                    await ctx.leaveChat();
                    console.log(`[미인증 초대 차단] Chat: ${chatId}, 초대자: ${inviter.id}`);
                    return;
                }
                await authorizeChat(chatId, inviter.id);
            }

            const restored = ctx.chat.type !== 'private' && (await restoreArchivedChat(String(chatId)));
            await ensureChatRecord(chatId, title);

            if (restored) {
                const record = await getChatRecord(chatId);
                if (record?.matched_member_id) {
                    await ctx.reply(
                        '♻️ <b>다시 초대되어 이전 기록을 복원했습니다.</b>\n\n' +
                            `• 대상자: <b>${escapeHtml(record.matched_student_name || '대상자')}</b>\n` +
                            `• 다음 만남일: ${escapeHtml(record.meeting_date || '미정')}\n` +
                            '<i>(현재 상태는 /상태확인 으로 볼 수 있습니다)</i>',
                        { parse_mode: 'HTML' }
                    );
                    return;
                }
            }

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
            await archiveChat(String(chatId));
            await neonPool.query(`DELETE FROM counseling_chats WHERE chat_id = $1;`, [String(chatId)]);
            await neonPool.query(`DELETE FROM authorized_chats WHERE chat_id = $1;`, [String(chatId)]);
            await neonPool.query(`DELETE FROM region_chats WHERE chat_id = $1;`, [String(chatId)]);
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
            '   <i>(결과 보고서에서 [신청] 시 교사 만남으로 자동 전환, [행사참석] 시 행사 참석으로 따로 기록 → 이후 <code>/교사전환</code>)</i>\n' +
            '• <b>인터뷰 전 연락두절·거절</b>: <code>/만남중단</code> → <b>인터뷰 전 중단</b>으로 구분 기록\n' +
            '\n' +
            '<b>3. 교사 만남 및 일정 관리</b>\n' +
            '• <b>만남일 설정</b>: <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>\n' +
            '• <b>만남 중단 처리</b>: <code>/만남중단 [상세 사유]</code> → 사유 버튼 선택\n' +
            '• <b>피드백 제출</b>: 메시지 내 <code>#피드백</code> 태그 포함\n' +
            '• <b>만남 보고서 양식</b>: <code>/만남보고서양식</code> 또는 <code>/교사만남양식</code>\n' +
            '• <b>교사 만남 누적 회차</b>: <code>/교사만남회차</code> (보정: <code>/교사만남회차 총횟수</code>, 마지막 1회 취소: <code>/회차취소</code>)\n' +
            '• <b>섭등 후 회차</b>: <code>/섭등회차</code> (섭등일 만남 = 1회차, 보정: <code>/섭등회차 총횟수</code>)\n' +
            '   <i>(섭등 후 3회차부터 복등 전이면 보고서 반영 때 복등 안내, 3회차 때 지역 담당방에도 알림)</i>\n' +
            '• <b>만남 보고서 제출</b>: 양식 내 <code>다음만남일: MM-DD</code> 포함\n' +
            '   <i>(사진 설명글로 올려도 인식됩니다. 이미 보낸 메시지를 편집하면 반영되지 않으니 다시 올려 주세요)</i>\n\n' +
            '<b>4. 지인 만남 (일정만 관리)</b>\n' +
            '• <b>지정</b>: <code>/최초등록</code> 후 [🤝 지인 만남] 선택 → <code>/만남일 MM-DD</code>로 일정 등록\n' +
            '• <b>교사 만남으로 전환</b>: <code>/교사전환</code>\n\n' +
            '<b>5. 방 진행 단계 (특수 구분)</b>\n' +
            '• <b>단계 설정</b>: <code>/섭등목표 MM-DD</code>, <code>/예정목표 MM-DD</code>, <code>/가능목표 MM-DD</code>, <code>/확정목표 MM-DD</code> (날짜만 입력)\n' +
            '• <b>단계 해제</b>: <code>/구분해제</code> (일반 상태로 복귀)\n\n' +
            '⏸ <b>진행이 멈춘 방 안내</b>: 최초등록·유형 선택·사전/사후 보고서·만남일·다음 일정이 비어 있거나 행정 탈락이면 오전 10시에 방으로 안내\n' +
            '   <i>(방마다 하루 하나, 상황별 최대 3번 → 그래도 그대로면 지역 담당방에 요약)</i>\n\n' +
            '📅 <b>날짜 입력 형식</b>: <code>10-08</code>, <code>10/8</code>, <code>10.8(목)</code>, <code>10월 8일</code>, <code>2026.10.8</code>, <code>내일</code>\n' +
            '   시간도 함께 적으면 저장됩니다: <code>/만남일 10.8(목) 오후 7시</code>, <code>10/8 19:30</code>\n' +
            '   <i>(요일이 실제와 다르거나 지난 날짜면 안내해 드립니다)</i>\n\n' +
            '👑 <b>관리자 전용 명령어</b>\n' +
            '• <b>인터뷰 예정건 모아보기</b>: <code>관리자 인터뷰</code>\n' +
            '• <b>교사 만남 진행건 모아보기</b>: <code>관리자 교사</code>\n' +
            '• <b>지인 만남 진행건 모아보기</b>: <code>관리자 지인</code> (행사 참석: <code>관리자 행사</code>)\n' +
            '• <b>만남 명단 조회</b>: <code>관리자 오늘만남</code>, <code>관리자 내일만남</code>, <code>관리자 일자만남 MM-DD</code>\n' +
            '• <b>보고서 미제출 명단</b>: <code>관리자 미제출</code> (일괄 독촉: <code>관리자 미제출 알림</code>)\n' +
            '• <b>미등록 및 미정 방 조회</b>: <code>관리자 미등록</code>\n' +
            '• <b>만남일 경과 미갱신 방</b>: <code>관리자 미갱신</code> (타부서 교사 제외, 포함: <code>관리자 미갱신 타부서포함</code>)\n' +
            '   일괄 독촉: <code>관리자 미갱신 알림</code>, <code>관리자 미갱신 타부서포함 알림</code>\n' +
            '• <b>찾등 이상 봇 미초대 명단</b>: <code>관리자 미초대</code>\n' +
            '• <b>만남 중단 방 목록</b>: <code>관리자 중단</code>\n' +
            '• <b>특수 구분 현황 (3가지 종합)</b>: <code>관리자 구분</code>\n' +
            '• <b>구분별 단독 조회</b>: <code>관리자 n월 섭등목표</code>, <code>관리자 n월 예정목표</code>, <code>관리자 n월 가능목표</code>, <code>관리자 n월 확정목표</code>\n' +
            '• <b>일반방 조회 (특수 3종 및 중단 제외)</b>: <code>관리자 n월 일반</code>\n' +
            '   <i>(n월 = 대상자 목표월, 생략 시 전체)</i>\n' +
            '• <b>전체 종합 관리 현황</b>: <code>관리자 점검</code>\n' +
            '• <b>주간 요약</b>: <code>관리자 주간요약</code> (매주 월요일 오전 관리자에게 자동 발송)\n' +
            '• <b>봇 사용 인증 현황</b>: <code>관리자 인증목록</code> (해제: <code>관리자 인증해제 ID</code>, 승인: <code>관리자 인증승인 ID</code>)\n' +
            '• <b>지역 담당방 등록</b>: 담당방에서 <code>/담당방등록 강북</code> (해제: <code>/담당방해제</code>, 목록: <code>관리자 담당방</code>)\n' +
            '   <i>(보고서 지연·만남 중단·매일 오전 10시/밤 10시 지역 요약이 담당방으로 자동 발송)</i>\n' +
            '• <b>신규 만남 발생</b>: <code>관리자 신규</code> (기간: <code>오늘</code>, <code>어제</code>, <code>이번주</code>, <code>지난주</code>, <code>10월</code>)\n' +
            '   <i>(상담 이하 = 인터뷰 매칭 / 지인 만남 / 상담 1회차 = 교사 매칭, 밤 10시 지역 요약에도 포함)</i>\n' +
            '• <b>담당방 공지</b>: <code>/담당방공지 내용</code> (특정 지역만: <code>/담당방공지 [강북,강남] 내용</code>)\n' +
            '• <b>봇 상태 점검</b>: <code>관리자 봇상태</code> (설정·DB·웹훅 오류 확인)\n' +
            '• <b>채팅방 ID 확인</b>: <code>/방ID</code>\n' +
            '• <b>상담방 찾기</b>: <code>관리자 찾기 이름</code> (대상자·인도자·교사 이름, 방 이름, 방 ID)',
        { parse_mode: 'HTML' }
    );
});

// 관리자: 채팅방·내 텔레그램 ID 확인 (/방ID, /내ID, /chatid)
bot.hears(CHAT_ID_COMMAND, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('⛔ 접근 권한이 없습니다.');
        return;
    }
    const chat = ctx.chat;
    const from = ctx.from;
    const typeLabel: Record<string, string> = { private: '개인 대화', group: '그룹', supergroup: '슈퍼그룹', channel: '채널' };
    const title = 'title' in chat ? chat.title : '';
    let msg =
        `🆔 <b>[채팅방 ID]</b>\n\n` +
        (title ? `• <b>방 이름</b>: ${escapeHtml(title)}\n` : '') +
        `• <b>방 종류</b>: ${typeLabel[chat.type] || chat.type}\n` +
        `• <b>채팅방 ID</b>: <code>${chat.id}</code>\n`;
    if (from) msg += `• <b>내 텔레그램 ID</b>: <code>${from.id}</code>\n`;
    if (chat.type !== 'private') {
        const [registered, regions] = await Promise.all([
            getChatRecord(chat.id).catch(() => undefined),
            neonPool
                .query(`SELECT region FROM region_chats WHERE chat_id = $1 ORDER BY region`, [String(chat.id)])
                .then((r) => r.rows.map((row) => row.region as string))
                .catch(() => [] as string[]),
        ]);
        if (regions.length) msg += `• <b>지역 담당방</b>: ${escapeHtml(regions.join(', '))}\n`;
        else if (registered?.matched_student_name) msg += `• <b>매칭 대상자</b>: ${escapeHtml(registered.matched_student_name)}\n`;
        else msg += `• <b>매칭 대상자</b>: 미매칭\n`;
    }
    msg += `\n<i>(ID를 길게 눌러 복사할 수 있습니다)</i>`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
});

// 관리자: 상담방 찾기 (관리자 찾기 이름) — 대상자·인도자·교사 이름, 방 이름, 방 ID로 검색
bot.hears(/^(?:[\/!]?관리자\s+)(?:찾기|검색|방\s*찾기)\s+(.+)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.');
            return;
        }
        const keyword = ctx.match[1].replace(/\s/g, '');
        if (keyword.length < 2 && !/^-?\d+$/.test(keyword)) {
            await ctx.reply('⚠️ 두 글자 이상 입력해주세요. 예: <code>관리자 찾기 홍길동</code>', { parse_mode: 'HTML' });
            return;
        }
        const norm = (v?: string | null) => (v || '').replace(/\s/g, '');
        const found = (await getAllChats()).filter((c) =>
            [c.room_title, c.matched_student_name, c.guide_name, c.teacher_name, c.chat_id].some((v) => norm(v).includes(keyword))
        );
        if (found.length === 0) {
            await ctx.reply(`🔍 <b>${escapeHtml(keyword)}</b>(으)로 찾은 상담방이 없습니다.`, { parse_mode: 'HTML' });
            return;
        }

        const shown = found.slice(0, 15);
        const typeText = (c: ChatRecord) => (c.meeting_type ? `${c.meeting_type} 만남` : '⚠️ 유형 미선택');
        const whenText = (c: ChatRecord) =>
            !c.meeting_date
                ? '미등록'
                : c.meeting_date === '중단'
                ? `🛑 중단${c.stop_category ? ` (${escapeHtml(c.stop_category)})` : ''}`
                : c.meeting_date === '미정'
                ? '미정'
                : formatMeetingWhen(formatYmdWithDay(c.meeting_date), c.meeting_time);
        let msg = `🔍 <b>[상담방 찾기: ${escapeHtml(keyword)}]</b> ${found.length}건${found.length > shown.length ? ` (앞 ${shown.length}건만 표시)` : ''}\n\n`;
        shown.forEach((c, i) => {
            msg +=
                `<b>${i + 1}.</b> ` +
                regionRoomInfo(c) +
                `• 유형: ${typeText(c)} · 다음 만남: <b>${whenText(c)}</b>` +
                (c.meeting_type === '교사' ? ` · ${c.teacher_meeting_count ?? 0}회차` : '') +
                `\n• 방 ID: <code>${escapeHtml(c.chat_id)}</code>\n\n`;
        });
        await replyLong(ctx, msg.trimEnd());
    } catch (err: unknown) {
        console.error('[관리자 찾기 에러]:', err);
        await replyError(ctx, '상담방 찾기', err);
    }
});

// 관리자: 봇 상태 점검 (관리자 봇상태) — 설정값은 '있음/없음'만 표시하고 값 자체는 보여주지 않음
bot.hears(/^(?:[\/!]?관리자\s+)(봇\s*상태|상태\s*점검|설정\s*점검)$/i, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('⛔ 접근 권한이 없습니다.');
        return;
    }
    const yesNo = (v?: string) => (v ? '✅ 설정됨' : '❌ 없음');
    let msg = `🩺 <b>[봇 상태 점검]</b>\n\n`;

    msg += `<b>⚙️ 설정</b>\n`;
    msg += `• 관리자: ${ADMIN_IDS.length}명\n`;
    msg += `• BOT_NOTIFY_SECRET (웹 최초등록 알림): ${yesNo(process.env.BOT_NOTIFY_SECRET)}\n`;
    msg += `• CRON_SECRET (알림 주소 보호): ${yesNo(process.env.CRON_SECRET)}\n`;
    msg += `• WEBHOOK_SECRET: ${process.env.WEBHOOK_SECRET ? '✅ 직접 설정' : '✅ 자동 (봇 토큰에서 생성)'}\n`;
    msg += `• WEEKLY_REPORT_CHAT_ID (주간 요약 받는 곳): ${
        process.env.WEEKLY_REPORT_CHAT_ID ? '✅ 설정됨' : 'ℹ️ 없음 (관리자에게 발송)'
    }\n\n`;

    msg += `<b>🗄 DB</b>\n`;
    try {
        const r = await neonPool.query(`
            SELECT
                (SELECT COUNT(*) FROM counseling_chats) AS chats,
                (SELECT COUNT(*) FROM counseling_chats WHERE matched_member_id IS NOT NULL) AS matched,
                (SELECT COUNT(*) FROM authorized_chats) AS authorized,
                (SELECT COUNT(DISTINCT chat_id) FROM region_chats) AS region_chats,
                (SELECT COUNT(*) FROM verified_users WHERE status = 'approved') AS approved,
                (SELECT COUNT(*) FROM verified_users WHERE status = 'pending') AS pending
        `);
        const c = r.rows[0];
        msg += `• 연결: ✅ 정상\n`;
        msg += `• 상담방: ${c.chats}개 (매칭 ${c.matched}개) · 인증된 방 ${c.authorized}개 · 지역 담당방 ${c.region_chats}개\n`;
        msg += `• 인증 사용자: ${c.approved}명${Number(c.pending) ? ` (⏳ 승인 대기 ${c.pending}명)` : ''}\n`;
        // 진행 중인 방의 인도자·교사 지역 중 담당방이 없는 곳 (그 지역 알림은 관리자에게 대신 감)
        const regionChats = await getRegionChats();
        const missing = new Set<string>();
        for (const chat of await getAllChats()) {
            if (!chat.matched_member_id || chat.meeting_date === '중단') continue;
            for (const region of [chat.guide_region, chat.teacher_region]) {
                if (region && !regionChats.some((rc) => regionMatches(rc.region, region))) missing.add(region);
            }
        }
        msg += `• 담당방 없는 지역: ${
            missing.size ? `⚠️ ${escapeHtml([...missing].join(', '))} <i>(알림은 관리자에게 대신 전달)</i>` : '없음'
        }\n\n`;
    } catch (err: unknown) {
        msg += `• 연결: ❌ 오류 — ${escapeHtml(getErrorMessage(err))}\n\n`;
    }

    msg += `<b>📡 텔레그램 웹훅</b>\n`;
    try {
        const info = await ctx.telegram.getWebhookInfo();
        msg += `• 주소: ${info.url ? escapeHtml(info.url) : '❌ 미등록'}\n`;
        msg += `• 처리 대기 중인 메시지: ${info.pending_update_count}건\n`;
        if (info.last_error_date) {
            const when = dayjs.unix(info.last_error_date).tz('Asia/Seoul').format('M/D HH:mm');
            msg += `• 최근 오류: ${when} — ${escapeHtml(info.last_error_message || '')}\n`;
        } else {
            msg += `• 최근 오류: 없음\n`;
        }
    } catch (err: unknown) {
        msg += `• 조회 실패: ${escapeHtml(getErrorMessage(err))}\n`;
    }

    msg += `\n<i>봇 시작: ${BOT_STARTED_AT.tz('Asia/Seoul').format('M/D HH:mm')}</i>`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
});

// 인터뷰 만남이 멈춰 있는 단계 — 오전 10시에 해당 방으로 안내 (단계마다 하루 한 번, 최대 STAGE_REMINDER_MAX번)
//   no_pre  : 인터뷰 만남으로 골랐는데 사전 보고서가 없음 (고른 다음 날부터)
//   no_date : 사전 보고서는 올렸는데 인터뷰 예정일이 미정
//   no_post : 인터뷰일이 3일 이상 지났는데 사후(결과) 보고서가 없음 (당일·D+1·D+2 알림 다음 단계)
const STAGE_REMINDER_MAX = 3;

function interviewPendingStage(
    c: ChatRecord,
    today: dayjs.Dayjs
): { key: 'no_pre' | 'no_date' | 'no_post'; text: string } | null {
    if (c.meeting_type !== '인터뷰' || c.interview_report_submitted || c.meeting_date === '중단') return null;
    const who = c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : '';

    if (!c.interviewer_name) {
        if (c.type_selected_at && !dayjs(c.type_selected_at).isBefore(today)) return null;
        return {
            key: 'no_pre',
            text:
                `📝 <b>[인터뷰 사전 보고서 미등록 안내]</b>${who}\n` +
                `인터뷰 만남으로 지정되었지만 <b>[인터뷰 사전 보고서]</b>가 아직 올라오지 않았습니다.\n` +
                `사전 보고서를 올리면 인터뷰어·타이퍼·예정일이 등록되고 일정 알림이 시작됩니다.\n\n` +
                `💡 양식: <code>/인터뷰사전양식</code>\n` +
                `💡 인터뷰 전에 연락두절·거절되었다면 <code>/만남중단</code> (인터뷰 전 중단으로 기록)`,
        };
    }
    if (!c.meeting_date || c.meeting_date === '미정') {
        return {
            key: 'no_date',
            text:
                `📅 <b>[인터뷰 예정일 미정 안내]</b>${who}\n` +
                `사전 보고서는 등록되었지만 <b>인터뷰 예정일</b>이 아직 미정입니다.\n` +
                `날짜가 정해지면 <code>/인터뷰일 MM-DD</code>로 등록해 주세요.\n` +
                `💡 인터뷰 전에 연락두절·거절되었다면 <code>/만남중단</code> (인터뷰 전 중단으로 기록)`,
        };
    }
    const mDate = dayjs(c.meeting_date).startOf('day');
    const overdue = mDate.isValid() ? today.diff(mDate, 'day') : 0;
    if (overdue >= 3) {
        return {
            key: 'no_post',
            text:
                `📋 <b>[인터뷰 사후 보고서 미제출 안내]</b>${who}\n` +
                `인터뷰일(${mDate.format('MM/DD')})로부터 <b>${overdue}일</b>이 지났지만 <b>사후(결과) 보고서</b>가 아직 없습니다.\n` +
                `인터뷰를 마쳤다면 결과 보고서를 올려 주세요. 일정이 바뀌었다면 <code>/인터뷰일 MM-DD</code>로 다시 등록해 주세요.\n\n` +
                `💡 양식: <code>/인터뷰사후양식</code>`,
        };
    }
    return null;
}

/* =====================================================
 * ⏸ 진행이 멈춘 방 안내 (오전 10시)
 * - 방마다 하루에 하나만: 아래 순서에서 가장 앞 단계의 안내 하나만 보냄
 * - 단계마다 최대 STAGE_REMINDER_MAX번, 마지막 안내 때 지역 담당방(없으면 관리자)에 한 번 알림
 * - 중단된 방은 안내하지 않고, 탈락 대상자 방은 확인 전까지 다른 알림도 멈춤
 * ===================================================== */
type RoomNudge = { key: string; label: string; text: string; keyboard?: { inline_keyboard: any[][] } };

// 행정에서 탈락 처리된 대상자인데 방에서 아직 확인(중단 또는 계속 진행)하지 않음
function isDroppedActive(c: ChatRecord): boolean {
    if (!c.matched_member_id || c.meeting_date === '중단' || c.drop_ack_at) return false;
    return !!c.student_dropped_at || String(c.student_stage ?? '').includes('탈락');
}

function isYmd(v?: string | null): v is string {
    return /^\d{4}-\d{2}-\d{2}$/.test(v || '');
}

// 탈락 확인 버튼: 중단 사유 버튼(취소 제외) + 계속 진행
function droppedKeyboard() {
    const rows = buildStopCategoryKeyboard('stop').inline_keyboard.filter((row) => row[0]?.callback_data !== 'stop:cancel');
    return { inline_keyboard: [...rows, [{ text: '▶️ 계속 진행 (탈락 아님)', callback_data: 'dropkeep' }]] };
}

function getRoomNudge(c: ChatRecord, today: dayjs.Dayjs, todayStr: string): RoomNudge | null {
    if (c.meeting_date === '중단') return null;
    const who = c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : '';
    const before = (t?: string | null) => !t || dayjs(t).isBefore(today); // 기록이 없으면(예전 방) 지난 것으로 봄

    // A. 탈락 대상자
    if (isDroppedActive(c)) {
        return {
            key: 'dropped',
            label: '탈락 대상자 진행 중',
            text:
                `⚠️ <b>[탈락 처리된 대상자 확인]</b>${who}\n` +
                `행정에서 이 대상자가 <b>탈락</b>으로 처리되어 있습니다.\n` +
                `만남을 중단하려면 사유를, 탈락이 아니라면 [계속 진행]을 눌러주세요.\n` +
                `<i>(확인 전까지 이 방의 일정·보고서 알림은 멈춥니다)</i>\n` +
                `• ${STOP_DETAIL_LABEL}행정 탈락 처리`,
            keyboard: droppedKeyboard(),
        };
    }
    // B. 봇은 초대됐는데 최초등록 안 함
    if (!c.matched_member_id) {
        if (!before(c.created_at)) return null;
        return {
            key: 'no_match',
            label: '최초등록 안 함',
            text:
                `📌 <b>[최초등록 안내]</b>\n` +
                `봇이 초대되었지만 아직 <b>대상자 최초등록</b>이 되지 않았습니다.\n` +
                `등록해야 일정·보고서 알림이 시작됩니다.\n\n` +
                `<code>/최초등록 섭외자/지역/팀/인도자</code>\n` +
                `<i>(예: <code>/최초등록 홍길동/강북/1/강현정</code>)</i>`,
        };
    }
    // 유형 미선택
    if (!c.meeting_type && !c.meeting_date) {
        if (!before(c.matched_at)) return null;
        return {
            key: 'no_type',
            label: '첫 만남 유형 미선택',
            text:
                `⏰ <b>[첫 만남 유형 선택 안내]</b>${who}\n` +
                `대상자 매칭은 되었지만 <b>첫 만남 유형</b>이 아직 선택되지 않았습니다.\n` +
                `유형을 골라야 일정 알림이 시작됩니다. 👇`,
            keyboard: MEETING_TYPE_KEYBOARD,
        };
    }
    // 인터뷰 단계 (사전 보고서 없음 / 예정일 미정 / 사후 보고서 없음)
    const interview = interviewPendingStage(c, today);
    if (interview) {
        const labels = { no_pre: '인터뷰 사전 보고서 미등록', no_date: '인터뷰 예정일 미정', no_post: '인터뷰 사후 보고서 미제출' };
        return { key: interview.key, label: labels[interview.key], text: interview.text };
    }
    if (c.meeting_type === '인터뷰') return null;

    // C. 교사·지인을 골랐는데 만남일 없음
    if (!c.meeting_date) {
        if (!before(c.type_selected_at)) return null;
        return {
            key: 'no_schedule',
            label: '만남일 미등록',
            text:
                `🗓 <b>[만남일 등록 안내]</b>${who}\n` +
                `${c.meeting_type ? `<b>${escapeHtml(c.meeting_type)} 만남</b>으로 지정되었지만 ` : ''}만남일이 아직 등록되지 않았습니다.\n` +
                `<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 등록해 주세요.`,
        };
    }
    if (isYmd(c.meeting_date) && c.meeting_date < todayStr) {
        const date = dayjs(c.meeting_date).format('MM/DD');
        const days = today.diff(dayjs(c.meeting_date).startOf('day'), 'day');
        // E. 보고서는 냈는데(또는 보고서가 필요 없는 지인 만남) 다음 만남일이 없음
        if (!needsReport(c) || c.report_submitted) {
            return {
                key: 'no_next',
                label: '다음 만남일 미등록',
                text:
                    `🗓 <b>[다음 만남일 등록 안내]</b>${who}\n` +
                    `지난 ${c.meeting_type === '행사' ? '행사일' : '만남일'}(${date}) 이후 <b>다음 일정</b>이 등록되지 않았습니다.\n` +
                    `<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 등록해 주세요.` +
                    (c.meeting_type === '행사' ? `\n💡 행사 후 상담(교사 만남)으로 이어지면 <code>/교사전환</code>` : ''),
            };
        }
        // G. 보고서 미제출 D+3 이후 (당일·D+1·D+2 알림 다음 단계)
        if (days >= 3) {
            return {
                key: 'report_late',
                label: '만남 보고서 장기 미제출',
                text:
                    `📋 <b>[만남 보고서 미제출 안내]</b>${who}\n` +
                    `만남일(${date})로부터 <b>${days}일</b>이 지났지만 만남 보고서가 아직 없습니다.\n` +
                    `만남을 하지 못했다면 <code>/만남일 MM-DD</code>로 일정을 다시 등록해 주세요.\n\n` +
                    `💡 양식: <code>/만남보고서양식</code>`,
            };
        }
        return null;
    }
    // F. '미정'으로 14일 넘게 지남
    if (c.meeting_date === '미정' && c.updated_at && today.diff(dayjs(c.updated_at), 'day') >= 14) {
        return {
            key: 'long_undecided',
            label: '만남일 장기 미정',
            text:
                `⏳ <b>[만남일 미정 안내]</b>${who}\n` +
                `다음 만남일이 <b>${today.diff(dayjs(c.updated_at), 'day')}일째 미정</b>입니다.\n` +
                `일정이 잡혔다면 <code>/만남일 MM-DD</code>로, 만남을 이어가지 않는다면 <code>/만남중단</code>으로 알려주세요.`,
        };
    }
    return null;
}

type NudgeEscalation = { chat: ChatRecord; label: string };

// 마지막 안내까지 보낸 방들을 담당방(없으면 관리자)마다 한 통으로 묶어 발송
async function sendNudgeEscalations(items: NudgeEscalation[], regionChats: RegionChat[]) {
    const byTarget = new Map<string, string[]>();
    const add = (target: string, line: string) => byTarget.set(target, [...(byTarget.get(target) || []), line]);
    for (const { chat, label } of items) {
        const line = `<b>[${escapeHtml(label)}]</b>\n` + regionRoomInfo(chat);
        const targets = regionChatIdsFor(chat, regionChats);
        if (targets.length) targets.forEach((t) => add(t, line));
        else ADMIN_IDS.forEach((id) => add(id, line + `<i>(담당방 없음 → 관리자에게 전달)</i>\n`));
    }
    for (const [target, lines] of byTarget) {
        const msg =
            `⏸ <b>[진행 멈춤 방 ${lines.length}곳]</b>\n` +
            `<i>방에 ${STAGE_REMINDER_MAX}번 안내했지만 아직 그대로입니다. 확인해 주세요.</i>\n\n` +
            lines.join('\n');
        for (const part of splitLongMessage(msg)) {
            await bot.telegram
                .sendMessage(target, part, { parse_mode: 'HTML' })
                .catch((err) => console.error(`[진행 멈춤 요약 발송 실패] ${target}:`, getErrorMessage(err)));
        }
    }
}

async function sendRoomNudge(c: ChatRecord, today: dayjs.Dayjs, todayStr: string, escalations: NudgeEscalation[]) {
    const nudge = getRoomNudge(c, today, todayStr);
    // 지금 걸린 안내를 방마다 저장 (안내를 보내지 않는 날·횟수를 다 채운 방도). 웹 상담 현황이 이 값을 그대로 보여준다
    await neonPool
        .query(`UPDATE counseling_chats SET nudge_key = $2, nudge_label = $3, nudge_checked_on = $4 WHERE chat_id = $1`, [
            c.chat_id,
            nudge?.key ?? null,
            nudge?.label ?? null,
            todayStr,
        ])
        .catch((err) => console.error(`[진행 멈춤 상태 저장 실패] Chat: ${c.chat_id}`, getErrorMessage(err)));
    if (!nudge || c.stage_reminder_date === todayStr) return;
    // 단계가 바뀌면 횟수를 새로 셈
    const sent = c.stage_reminder_key === nudge.key ? c.stage_reminder_count ?? 0 : 0;
    if (sent >= STAGE_REMINDER_MAX) return;
    const isLast = sent + 1 >= STAGE_REMINDER_MAX;
    try {
        await bot.telegram.sendMessage(c.chat_id, nudge.text + (isLast ? `\n<i>(마지막 안내입니다)</i>` : ''), {
            parse_mode: 'HTML',
            ...(nudge.keyboard ? { reply_markup: nudge.keyboard } : {}),
        });
        // updated_at은 건드리지 않음 (일정·상태 변경 시각으로 쓰이므로)
        await neonPool.query(
            `UPDATE counseling_chats SET stage_reminder_key = $2, stage_reminder_date = $3, stage_reminder_count = $4 WHERE chat_id = $1`,
            [c.chat_id, nudge.key, todayStr, sent + 1]
        );
        if (isLast) escalations.push({ chat: c, label: nudge.label });
    } catch (err: unknown) {
        console.error(`[진행 멈춤 안내 실패] Chat: ${c.chat_id}`, getErrorMessage(err));
        await handleRoomSendFailure(c.chat_id, err);
    }
}

// 방으로 보내기 실패 처리 — 슈퍼그룹 전환이면 기록을 새 방 ID로 옮기고, 봇이 없거나 방이 사라졌으면 보관 처리
async function handleRoomSendFailure(chatId: string | number, err: unknown) {
    const e = err as { description?: string; message?: string; response?: { parameters?: { migrate_to_chat_id?: number } } };
    const newId = e?.response?.parameters?.migrate_to_chat_id;
    try {
        if (newId) {
            await mergeMigratedChat(chatId, newId);
            return;
        }
        const desc = `${e?.description || ''} ${e?.message || ''}`;
        if (!/chat not found|bot was kicked|bot is not a member|group chat was deleted|bot was blocked|user is deactivated/i.test(desc)) return;
        const record = await getChatRecord(chatId);
        await archiveChat(String(chatId));
        await neonPool.query(`DELETE FROM counseling_chats WHERE chat_id = $1;`, [String(chatId)]);
        await neonPool.query(`DELETE FROM authorized_chats WHERE chat_id = $1;`, [String(chatId)]);
        console.log(`[봇 없는 방 정리] Chat: ${chatId} (${desc.trim()})`);
        await alertAdmins(
            `${record?.room_title || '대화방'} (${chatId})`,
            '봇이 없는 방이라 기록을 보관 처리했습니다 (다시 초대하면 복원)',
            desc.trim()
        );
    } catch (cleanupErr: unknown) {
        console.error(`[방 전송 실패 처리 에러] Chat: ${chatId}`, getErrorMessage(cleanupErr));
    }
}

// 같은 대상자가 이미 매칭된 다른 방 (회차·알림이 두 번 셀 수 있어 경고용)
async function otherRoomsOfStudent(studentId: number | string, chatId: number | string): Promise<string[]> {
    const res = await neonPool.query(
        `SELECT COALESCE(room_title, chat_id) AS title FROM counseling_chats
         WHERE matched_member_id::text = $1 AND chat_id <> $2 ORDER BY title`,
        [String(studentId), String(chatId)]
    );
    return res.rows.map((r) => r.title);
}

function duplicateWarning(rooms: string[]): string {
    return rooms.length
        ? `\n\n⚠️ <b>이 대상자는 다른 방에도 매칭되어 있습니다:</b> ${escapeHtml(rooms.join(', '))}\n` +
              `<i>회차·알림이 두 번 셀 수 있으니, 잘못된 방이면 그 방에서 <code>/매칭해제</code> 해주세요.</i>`
        : '';
}

// 매칭 완료 안내 + 첫 만남 유형 버튼 (텔레그램 /최초등록, 웹 최초등록 공통)
const MEETING_TYPE_KEYBOARD = {
    inline_keyboard: [
        [
            { text: '🎙️ 인터뷰 만남', callback_data: 'type_interview' },
            { text: '👨‍🏫 교사 만남', callback_data: 'type_teacher' },
        ],
        [{ text: '🤝 지인 만남', callback_data: 'type_acquaintance' }],
    ],
};

function matchedPromptText(
    m: { student_name: string; student_id: number | string; guide_name?: string | null; region?: string | null; district?: string | null },
    viaWeb = false
): string {
    return (
        `🎉 <b>대상자 매칭 완료!</b>${viaWeb ? ' <i>(웹에서 등록)</i>' : ''}\n\n` +
        `• <b>섭외자(대상자)</b>: <b>${escapeHtml(m.student_name)}</b> (ID: ${m.student_id})\n` +
        `• <b>인도자</b>: ${escapeHtml(m.guide_name || '미등록')} (${escapeHtml(m.region || '-')} / 구역: ${escapeHtml(
            m.district || '-'
        )})\n\n` +
        `👇 <b>첫 만남의 유형을 선택해주세요:</b>`
    );
}

// 웹에서 최초등록(방 ↔ 대상자 매칭)한 뒤 호출 — 상담방에 매칭 안내·유형 버튼, 인도자·교사 지역 담당방에 알림
async function notifyWebRegistration(chatId: string): Promise<{ ok: boolean; error?: string }> {
    const record = await getChatRecord(chatId);
    if (!record) return { ok: false, error: '상담방을 찾을 수 없습니다.' };
    if (!record.matched_member_id) return { ok: false, error: '매칭된 대상자가 없습니다.' };
    // 유형 미선택 리마인드 기준 시각 (웹은 matched_at을 따로 기록하지 않으므로 여기서 기록)
    await neonPool.query(
        `UPDATE counseling_chats SET matched_at = NOW(), stage_reminder_count = 0, drop_ack_at = NULL WHERE chat_id = $1`,
        [chatId]
    );

    await bot.telegram.sendMessage(
        chatId,
        matchedPromptText(
            {
                student_name: record.matched_student_name || '대상자',
                student_id: record.matched_member_id,
                guide_name: record.guide_name,
                region: record.guide_region,
                district: record.guide_district,
            },
            true
        ) + duplicateWarning(await otherRoomsOfStudent(record.matched_member_id, chatId)),
        { parse_mode: 'HTML', reply_markup: MEETING_TYPE_KEYBOARD }
    );

    await notifyRegionChats(record, `🆕 <b>[최초등록 - 웹]</b>\n` + regionRoomInfo(record));
    return { ok: true };
}

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
        await updateChat(ctx.chat.id, {
            matched_member_id: match.student_id,
            matched_at: new Date().toISOString(),
            stage_reminder_count: 0,
            drop_ack_at: null,
        });

        const dupRooms = await otherRoomsOfStudent(match.student_id, ctx.chat.id);
        await ctx.reply(matchedPromptText(match) + duplicateWarning(dupRooms), {
            parse_mode: 'HTML',
            reply_markup: MEETING_TYPE_KEYBOARD,
        });

        // 인도자·교사 지역 담당방에도 알림 (웹 최초등록과 동일)
        const record = await getChatRecord(ctx.chat.id);
        if (record) await notifyRegionChats(record, `🆕 <b>[최초등록]</b>\n` + regionRoomInfo(record));
    } catch (err: unknown) {
        console.error('[최초등록 JOIN 매칭 에러]:', err);
        await replyError(ctx, 'DB 매칭 조회', err);
    }
});

// 첫 만남 유형을 정했을 때 방에 보내는 안내 (유형 버튼, 웹에서 고른 경우 공통)
const TYPE_SELECTED_MESSAGE: Record<'인터뷰' | '교사' | '지인', string> = {
    인터뷰:
        `🎙️ <b>첫 만남이 [인터뷰 만남]으로 지정되었습니다.</b>\n\n` +
        `채팅방에 <b>[인터뷰 사전 보고서]</b>를 올려주시면 인터뷰어/타이퍼/예정일이 자동 등록됩니다.\n\n` +
        `💡 양식이 필요하시면 <code>/인터뷰사전양식</code>을 입력하세요.`,
    교사:
        `👨‍🏫 <b>첫 만남이 [교사 만남]으로 지정되었습니다.</b>\n\n` +
        `이어서 만남 일정을 지정해주세요:\n` +
        `• <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>`,
    지인:
        `🤝 <b>첫 만남이 [지인 만남]으로 지정되었습니다.</b>\n\n` +
        `지인 만남은 <b>일정만 관리</b>합니다 (보고서 제출·미제출 알림 없음).\n` +
        `• 일정 등록: <code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>\n` +
        `• 교사 만남으로 넘어가면: <code>/교사전환</code>`,
};

// 웹(관리 화면)에서 상담방을 고쳤을 때 그 방에 보내는 알림. actions로 상담 봇이 같은 일을 했을 때의 안내를 덧붙인다
// actions: type:인터뷰|type:교사|type:지인 (첫 만남 유형), pre_report (인터뷰 사전 보고서), stop (중단), resume (중단 해제)
function webEditMessage(record: ChatRecord, changes: string[], actions: Set<string>): string {
    let msg =
        `✏️ <b>[관리 화면에서 수정되었습니다]</b>` +
        (record.matched_student_name ? ` (👤 ${escapeHtml(record.matched_student_name)})` : '') +
        `\n` +
        changes.map((c) => `• ${escapeHtml(c)}`).join('\n');
    for (const type of ['인터뷰', '교사', '지인'] as const) {
        if (actions.has(`type:${type}`)) msg += `\n\n${TYPE_SELECTED_MESSAGE[type]}`;
    }
    if (actions.has('pre_report')) {
        const date = record.interview_date || '미정';
        msg +=
            `\n\n🎙️ <b>[인터뷰 사전 보고서]</b>\n` +
            `• <b>인터뷰어</b>: ${escapeHtml(record.interviewer_info || record.interviewer_name || '미지정')}\n` +
            `• <b>타이퍼</b>: ${escapeHtml(record.typer_info || record.typer_name || '미지정')}\n` +
            `• <b>인터뷰 예정일</b>: <b>${
                date === '미정' ? '미정' : formatMeetingWhen(formatYmdWithDay(date), record.meeting_time)
            }</b>\n` +
            `• <b>D-1 알림 (10:00)</b>: 인터뷰 안내 알림\n` +
            `• <b>당일 알림 (22:00)</b>: 결과 보고서 등록 알림`;
    }
    if (actions.has('stop')) msg += `\n\n💡 만남이 재개되면 <code>/만남일 MM-DD</code>를 입력하여 새 일정을 등록해주세요.`;
    if (actions.has('resume') && (!record.meeting_date || record.meeting_date === '미정')) {
        msg += `\n\n💡 다음 만남 일정을 <code>/만남일 MM-DD</code>로 등록해주세요.`;
    }
    return msg;
}

// 버튼 콜백: 만남 유형 선택
bot.action('type_interview', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateChat(ctx.chat!.id, { meeting_type: '인터뷰', type_selected_at: new Date().toISOString() });
        await recordMeetingEvent(ctx.chat!.id, '인터뷰매칭', '최초등록');

        await ctx.reply(TYPE_SELECTED_MESSAGE['인터뷰'], { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[type_interview 에러]:', err);
    }
});

bot.action('type_teacher', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateChat(ctx.chat!.id, { meeting_type: '교사', type_selected_at: new Date().toISOString() });
        await recordMeetingEvent(ctx.chat!.id, '교사매칭', '최초등록');

        await ctx.reply(TYPE_SELECTED_MESSAGE['교사'], { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[type_teacher 에러]:', err);
    }
});

bot.action('type_acquaintance', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateChat(ctx.chat!.id, { meeting_type: '지인', type_selected_at: new Date().toISOString() });
        await recordMeetingEvent(ctx.chat!.id, '지인매칭', '최초등록');

        await ctx.reply(TYPE_SELECTED_MESSAGE['지인'], { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[type_acquaintance 에러]:', err);
    }
});

// 지인 만남 → 교사 만남 전환 (/교사전환)
bot.hears(/^[\/!]교사\s*전환(?:@\w+)?$/i, async (ctx) => {
    try {
        const record = await getChatRecord(ctx.chat.id);
        if (record?.meeting_type !== '지인' && record?.meeting_type !== '행사') {
            await ctx.reply(
                record?.meeting_type === '교사'
                    ? 'ℹ️ 이미 교사 만남으로 진행 중입니다.'
                    : '⚠️ 지인 만남·행사 참석으로 진행 중인 방에서만 사용할 수 있습니다.\n<i>(인터뷰 만남은 결과 보고서의 후속 [신청]으로 전환됩니다)</i>',
                { parse_mode: 'HTML' }
            );
            return;
        }

        // 지인 만남·행사 참석 동안 쌓인 보고서·알림 상태는 교사 만남 기준으로 새로 시작
        await updateChat(ctx.chat.id, {
            meeting_type: '교사',
            feedback_submitted: 0,
            report_submitted: 0,
            d_minus_1_notified: 0,
            d_day_22_notified: 0,
            overdue_1_notified: 0,
            overdue_2_notified: 0,
        });
        await recordMeetingEvent(ctx.chat.id, '교사매칭', record.meeting_type === '행사' ? '행사후속' : '지인후속');

        const hasDate = record.meeting_date && !['미정', '중단'].includes(record.meeting_date);
        await ctx.reply(
            `👨‍🏫 <b>[교사 만남]으로 전환되었습니다.</b>\n\n` +
                (hasDate
                    ? `• 다음 만남일: <b>${formatMeetingWhen(
                          formatYmdWithDay(record.meeting_date),
                          record.meeting_time
                      )}</b>\n바뀌었다면 <code>/만남일 MM-DD</code>로 다시 등록해주세요.\n\n`
                    : `교사 만남 일정을 등록해주세요: <code>/만남일 MM-DD</code>\n\n`) +
                `앞으로 교사 만남 주기(D-1 피드백, 당일 만남보고서)에 맞춰 자동 관리됩니다.`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/교사전환 에러]:', err);
        await replyError(ctx, '교사 전환', err);
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
        `• 다음만남일: 10-15 (행사참석이면 행사일)\n` +
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
            `• 후속신청: <b>신청</b> ➔ 다음 교사 만남(상담) 일정으로 자동 인계됩니다.\n` +
            `• 후속신청: <b>행사참석</b> ➔ 상담이 아닌 행사 참석으로 따로 기록됩니다 (다음만남일 = 행사일).\n` +
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
        await replyError(ctx, '인터뷰어 수정', err);
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
            await replyError(ctx, '타이퍼 해제', err);
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
        await replyError(ctx, '타이퍼 수정', err);
    }
});

// 인터뷰 예정일 개별 수정 (/인터뷰일 [MM-DD])
bot.hears(/^[\/!](인터뷰일|인터뷰일자|인터뷰일정)(?:@\w+)?(?:(?:\s+|(?=\d))([\s\S]+))?$/i, async (ctx) => {
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
            await ctx.reply(
                `⚠️ 올바른 날짜 형식이 아닙니다. (예: 10-12, 10/12, 10.12(월), 10월 12일, 2026-10-12)\n` +
                    `❌ 인식하지 못한 입력: ${rawInput}`
            );
            return;
        }

        const time = parseFlexibleTime(stripDatePart(rawInput));
        await upsertMeetingDate(ctx.chat.id, title, formatted, time);
        await updateChat(ctx.chat.id, { meeting_type: '인터뷰', interview_date: formatted });

        await ctx.reply(
            `🎙️ <b>인터뷰 예정일이 [${formatMeetingWhen(formatYmdWithDay(formatted), time)}]로 변경되었습니다!</b>` +
                getWeekdayWarning(rawInput, formatted) +
                getPastDateWarning(formatted),
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/인터뷰일 수정 에러]:', getErrorMessage(err));
        await replyError(ctx, '인터뷰 일정 수정', err);
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
        await replyError(ctx, '매칭 해제', err);
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
        await replyError(ctx, '행정 확인', err);
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
        await replyError(ctx, '목표월 수정', err);
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
        typeText =
            `• <b>만남 유형</b>: 👨‍🏫 <b>교사 만남 진행 중</b>\n` +
            `   - <b>누적 만남</b>: <b>${record.teacher_meeting_count ?? 0}회</b>${seopRoundText(
                await getSeopRound(record)
            )} (기록 보기: <code>/교사만남회차</code>)\n`;
    } else if (record.meeting_type === '지인') {
        typeText =
            '• <b>만남 유형</b>: 🤝 <b>지인 만남 진행 중</b> (일정만 관리)\n' +
            '   - 교사 만남으로 넘어가면 <code>/교사전환</code>\n';
    } else if (record.meeting_type === '행사') {
        typeText =
            '• <b>만남 유형</b>: 🎪 <b>행사 참석</b> (인터뷰 후속, 일정만 관리)\n' +
            '   - 상담(교사 만남)으로 이어지면 <code>/교사전환</code>\n';
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
            `• <b>다음 만남일</b>: ${formatMeetingWhen(mDate.format('YYYY년 MM월 DD일'), record.meeting_time)}\n` +
            (needsReport(record)
                ? `• <b>피드백 작성</b>: ${feedbackStatus}\n` + `• <b>보고서 제출</b>: ${reportStatus}`
                : ''),
        { parse_mode: 'HTML' }
    );
    } catch (err: unknown) {
        console.error('[/상태확인 에러]:', getErrorMessage(err));
        await replyError(ctx, '상태 확인', err);
    }
});

// 만남 중단 설정 (/만남중단 [상세 사유]) → 사유 분류 버튼 선택 시 중단 처리
const STOP_DETAIL_LABEL = '상세 사유: ';

bot.hears(/^[\/!]만남중단(?:@\w+)?(?:\s+(.+))?$/i, async (ctx) => {
    const detail = ctx.match[1]?.trim() || '';
    const title = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
    try {
        await ensureChatRecord(ctx.chat.id, title);
        const phase = getStopPhase(await getChatRecord(ctx.chat.id));
        await ctx.reply(
            `🛑 <b>만남 중단 사유를 선택해주세요.</b>\n` +
                `• 중단 시점: <b>${phase}</b>${phase === '인터뷰 전' ? ' <i>(인터뷰 전 연락두절·거절 등으로 기록됩니다)</i>' : ''}\n` +
                (detail ? `• ${STOP_DETAIL_LABEL}${escapeHtml(detail)}\n` : '') +
                `\n<i>버튼을 누르면 중단 처리됩니다. 상세 사유는 <code>/만남중단 상세내용</code>으로 함께 남길 수 있습니다.</i>`,
            { parse_mode: 'HTML', reply_markup: buildStopCategoryKeyboard('stop') }
        );
    } catch (err: unknown) {
        console.error('[/만남중단 에러]:', getErrorMessage(err));
        await replyError(ctx, '만남 중단 처리', err);
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
        const before = await getChatRecord(ctx.chat.id);
        const phase = before?.meeting_date === '중단' && before.stop_phase ? before.stop_phase : getStopPhase(before);

        await updateChat(ctx.chat.id, {
            meeting_date: '중단',
            stop_reason: reason,
            stop_category: label,
            stop_phase: phase,
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
                `• <b>중단 시점</b>: <b>${escapeHtml(phase)}</b>\n` +
                `• <b>중단 사유</b>: <b>${escapeHtml(label)}</b>\n` +
                (detail ? `• <b>상세 사유</b>: ${escapeHtml(detail)}\n` : '') +
                `\n💡 만남이 재개되면 <code>/만남일 MM-DD</code>를 입력하여 새 일정을 등록해주세요.`,
            { parse_mode: 'HTML' }
        );

        const record = await getChatRecord(ctx.chat.id);
        if (record) {
            await notifyRegionChats(
                record,
                `🛑 <b>[만남 중단 발생 - ${escapeHtml(phase)}]</b>\n` +
                    regionRoomInfo(record) +
                    `• 중단 사유: <b>${escapeHtml(label)}</b>${detail ? ` - ${escapeHtml(detail)}` : ''}`
            );
        }
    } catch (err: unknown) {
        console.error('[만남 중단 사유 선택 에러]:', getErrorMessage(err));
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

// 버튼 콜백: 탈락 대상자 확인 → 계속 진행 (탈락 아님) — 이후 일반 알림 재개
bot.action('dropkeep', async (ctx) => {
    try {
        if (!ctx.chat) return;
        await updateChat(ctx.chat.id, { drop_ack_at: new Date().toISOString() });
        await ctx.answerCbQuery('계속 진행으로 확인했습니다.');
        await ctx.editMessageText(
            `▶️ <b>계속 진행으로 확인했습니다.</b>\n일정·보고서 알림을 다시 보냅니다.\n` +
                `<i>(행정의 탈락 처리가 잘못된 경우 행정 쪽 수정도 요청해 주세요)</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[탈락 확인 계속 진행 에러]:', getErrorMessage(err));
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

        if (record) {
            await notifyRegionChats(
                record,
                `🛑 <b>[만남 중단 발생 - 인터뷰 후속 미신청]</b>\n` +
                    regionRoomInfo(record) +
                    `• 미신청 사유: <b>${escapeHtml(label)}</b>${detail ? ` - ${escapeHtml(detail)}` : ''}`
            );
        }
    } catch (err: unknown) {
        console.error('[미신청 사유 선택 에러]:', getErrorMessage(err));
        await ctx.answerCbQuery('처리 중 오류가 발생했습니다.').catch(() => {});
    }
});

// 만남일 수동 설정 (/만남일 MM-DD, 만남일 미정 등)
bot.hears(/^[\/!]만남일(?:@\w+)?(?:(?:\s+|(?=\d))([\s\S]+))?$/i, async (ctx) => {
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
            await ctx.reply(
                `⚠️ 올바른 날짜 형식이 아닙니다. (예: 09-24, 9/24, 9.24(수), 9월 24일, 2026-09-24, 또는 미정)\n` +
                    `❌ 인식하지 못한 입력: ${rawInput}`
            );
            return;
        }

        const time = parseFlexibleTime(stripDatePart(rawInput));
        await upsertMeetingDate(ctx.chat.id, title, formatted, time);

        await ctx.reply(
            `🗓 만남일이 <b>${formatMeetingWhen(formatYmdWithDay(formatted), time)}</b>로 등록되었습니다.\n\n` +
                `• <b>만남 전날 (10:00)</b>: 피드백(#피드백) 등록 요청 알림\n` +
                `• <b>만남 당일 (22:00)</b>: 만남 보고서 등록 알림\n` +
                `• <b>미제출 시</b>: 1일/2일 경과 경고 알림` +
                getWeekdayWarning(rawInput, formatted) +
                getPastDateWarning(formatted),
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/만남일 설정 에러]:', getErrorMessage(err));
        await replyError(ctx, '만남일 설정', err);
    }
});

// 방 구분 설정 (/섭등목표, /예정목표, /가능목표, /확정목표 MM-DD) — 날짜만 허용
bot.hears(new RegExp(`^[\\/!](${STAGE_COMMAND_ALT})(?:@\\w+)?(?:(?:\\s+|(?=\\d))([\\s\\S]+))?$`, 'i'), async (ctx) => {
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
        replyMsg += getWeekdayWarning(rawDate, stageDate) + getPastDateWarning(stageDate);

        await ctx.reply(replyMsg, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[방 구분 설정 에러]:', getErrorMessage(err));
        await replyError(ctx, '구분 설정', err);
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
        await replyError(ctx, '구분 해제', err);
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
                dateDisplay = `${formatMeetingWhen(mDate.format('YYYY-MM-DD'), chat.meeting_time)} (${dDayStr})`;
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

        const seopRounds = await getSeopRounds(teacherChats);
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
                dateDisplay = `${formatMeetingWhen(mDate.format('YYYY-MM-DD'), chat.meeting_time)} (${dDayStr})`;
            }

            return (
                `<b>${idx}. ${studentName}</b>${stageBadge} [${escapeHtml(chat.room_title || '대화방')}]\n` +
                `   • 다음만남일: <b>${dateDisplay}</b>\n` +
                `   • 누적 만남: <b>${chat.teacher_meeting_count ?? 0}회</b>${seopRoundText(
                    seopRounds.get(String(chat.chat_id)) ?? null
                )}\n` +
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

// 관리자 지인 만남 진행건 모아보기 (일정만 관리)
bot.hears(/^(?:[\/!]?관리자\s+)(지인|지인만남|지인목록|지인건|행사|행사참석|행사목록|행사건)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ <b>접근 권한이 없습니다.</b> 관리자만 사용할 수 있습니다.', { parse_mode: 'HTML' });
            return;
        }

        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const kind = ctx.match[1].startsWith('행사') ? '행사' : '지인';
        const [kindIcon, kindName] = kind === '행사' ? ['🎪', '행사 참석'] : ['🤝', '지인 만남'];
        const chats = (await getAllChats())
            .filter((c) => c.meeting_type === kind && c.meeting_date !== '중단')
            .sort((a, b) => {
                if (!a.meeting_date || a.meeting_date === '미정') return 1;
                if (!b.meeting_date || b.meeting_date === '미정') return -1;
                return dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf();
            });

        if (chats.length === 0) {
            await ctx.reply(`✨ <b>현재 진행 중인 ${kindName}이 없습니다.</b>`, { parse_mode: 'HTML' });
            return;
        }

        const header =
            `${kindIcon} <b>[${kindName} 진행건 목록] (총 ${chats.length}건)</b>\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, chats, (chat, idx) => {
            const studentName = chat.matched_student_name ? `👤 <b>${escapeHtml(chat.matched_student_name)}</b>` : '미매칭';
            let dateDisplay = '미등록';
            if (chat.meeting_date === '미정') {
                dateDisplay = '⚠️ 일정 미정';
            } else if (chat.meeting_date) {
                const mDate = dayjs(chat.meeting_date).startOf('day');
                const diff = mDate.diff(today, 'day');
                const dDayStr = diff === 0 ? '오늘' : diff > 0 ? `D-${diff}` : `${Math.abs(diff)}일 경과`;
                dateDisplay = `${formatMeetingWhen(mDate.format('YYYY-MM-DD'), chat.meeting_time)} (${dDayStr})`;
            }
            return (
                `<b>${idx}. ${studentName}</b> [${escapeHtml(chat.room_title || '대화방')}]\n` +
                `   • ${kind === '행사' ? '행사일' : '다음만남일'}: <b>${dateDisplay}</b>\n` +
                `   • 담당인도자: ${escapeHtml(chat.guide_name || '-')} (${escapeHtml(chat.guide_region || '')} ${escapeHtml(
                    chat.guide_district || ''
                )})\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[관리자 지인 조회 에러]:', err);
    }
});

// 날짜별 만남 조회 (관리자 오늘만남, 관리자 내일만남, 관리자 일자만남 MM-DD)
bot.hears(
    /^(?:[\/!]?관리자(?:\s+(?!\d{1,2}\s*월\s*(?:섭등목표|예정목표|가능목표|확정목표|섭등예정|예정가능일|가능가능일|일반|일반방|미분류)$)(?!(?:미초대|봇미초대|초대누락|미제출|미등록|미정|미갱신|최초미등록|점검|현황|중단|구분|단계|특수|섭등목표|예정목표|가능목표|확정목표|섭등예정|예정가능일|가능가능일|일반|일반방|미분류|인터뷰|인터뷰예정|인터뷰목록|인터뷰건|교사|교사만남|교사목록|교사건|지인|지인만남|지인목록|지인건|주간))(.+))?|[\/!](?:만남명단|만남일정)(?:@\w+)?(?:\s+(.+))?)$/i,
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
                    : chat.meeting_type === '지인'
                    ? ' [🤝 지인]'
                    : chat.meeting_type === '행사'
                    ? ' [🎪 행사]'
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
                    (chat.meeting_time ? `   • 시간: <b>${escapeHtml(chat.meeting_time)}</b>\n` : '') +
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
                    chat.report_submitted ||
                    !needsReport(chat)
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

            await replyLong(ctx, message);
        } catch (err: unknown) {
            console.error('[미등록/미정 조회 에러]:', err);
            await replyError(ctx, '조회', err);
        }
    }
);

// 만남일 경과 후 미갱신 방 명단 (관리자 미갱신)
// 관리자 미갱신: 기본은 타부서 교사 제외 / '관리자 미갱신 타부서포함'이면 포함 — 교사 지역 내림차순
bot.hears(/^(?:[\/!]?관리자\s+)(미갱신\s*명단|미갱신|일정\s*미갱신)(\s*타부서\s*포함)?$/i, async (ctx) => {
    try {
        const userId = String(ctx.from?.id);
        if (!isAdmin(userId)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }

        const includeOtherDept = Boolean(ctx.match[2]);
        const today = dayjs().tz('Asia/Seoul').startOf('day');
        const allChats = await getAllChats();

        const overdueAll = allChats.filter((chat) => {
                if (
                    !chat.meeting_date ||
                    chat.meeting_date.trim() === '' ||
                    chat.meeting_date === '미정' ||
                    chat.meeting_date === '중단'
                )
                    return false;
                const mDate = dayjs(chat.meeting_date).startOf('day');
                return mDate.isBefore(today);
            });
        const otherDeptCount = overdueAll.filter(isOtherDeptTeacher).length;

        // 교사 지역 내림차순 (지역 없음은 맨 뒤), 같은 지역은 오래된 만남일 먼저
        const expiredChats = overdueAll
            .filter((chat) => includeOtherDept || !isOtherDeptTeacher(chat))
            .sort((a, b) => {
                const ra = a.teacher_region || '';
                const rb = b.teacher_region || '';
                if (ra !== rb) {
                    if (!ra) return 1;
                    if (!rb) return -1;
                    return rb.localeCompare(ra, 'ko');
                }
                return dayjs(a.meeting_date).valueOf() - dayjs(b.meeting_date).valueOf();
            });

        if (expiredChats.length === 0) {
            await ctx.reply(
                '🎉 <b>일정이 만료되어 갱신되지 않은 대화방이 없습니다!</b>' +
                    (!includeOtherDept && otherDeptCount
                        ? `\n(타부서 교사 ${otherDeptCount}건 제외됨 · <code>관리자 미갱신 타부서포함</code>)`
                        : ''),
                { parse_mode: 'HTML' }
            );
            return;
        }

        const header =
            `⌛ <b>[만남일 경과 후 미갱신 대화방${includeOtherDept ? ' · 타부서 포함' : ''}] (총 ${
                expiredChats.length
            }건, 교사 지역 내림차순)</b>\n` +
            `<i>(이전 만남일이 지났으나 다음 일정이 설정되지 않음)</i>\n` +
            (includeOtherDept
                ? ''
                : otherDeptCount
                ? `💡 타부서 교사 ${otherDeptCount}건 제외됨 · 포함하려면 <code>관리자 미갱신 타부서포함</code>\n`
                : '') +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, expiredChats, (chat, idx) => {
            const mDate = dayjs(chat.meeting_date).startOf('day');
            const diffDays = today.diff(mDate, 'day');
            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            const typeBadge = chat.meeting_type ? ` [${chat.meeting_type}]` : '';

            return (
                `<b>${idx}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}${typeBadge}\n` +
                `   • 교사: ${isOtherDeptTeacher(chat) && !chat.teacher_name ? '타부서 교사' : teacherText(chat)}\n` +
                `   • 지난 만남일: ${mDate.format('YYYY-MM-DD')} (${diffDays}일 경과)\n` +
                `   • 마지막 대화: ${formatLastMessage(chat.last_message_at)}\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[미갱신 명단 조회 에러]:', err);
    }
});

// 찾등 이상(찾·합·섭)인데 봇이 초대(매칭)된 방이 없는 대상자 (관리자 미초대)
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
            WHERE LEFT(TRIM(COALESCE(s."단계"::text, '')), 1) IN ('찾', '합', '섭')
              AND NOT EXISTS (
                  SELECT 1 FROM counseling_chats c
                  WHERE c.matched_member_id::text = s.id::text
              )
            ORDER BY
                CASE LEFT(TRIM(s."단계"::text), 1) WHEN '섭' THEN 0 WHEN '합' THEN 1 ELSE 2 END,
                m."지역", m."구역", m."이름", s."이름";
        `);

        if (res.rows.length === 0) {
            await ctx.reply('✨ <b>찾등 이상 대상자 중 봇이 초대되지 않은 건이 없습니다.</b>', { parse_mode: 'HTML' });
            return;
        }

        const stageCount = (prefix: string) =>
            res.rows.filter((s) => String(s['단계'] ?? '').trim().startsWith(prefix)).length;
        const header =
            `📭 <b>[찾등 이상 · 봇 미초대 명단] (총 ${res.rows.length}건)</b>\n` +
            `• 섭 ${stageCount('섭')}건 · 합 ${stageCount('합')}건 · 찾 ${stageCount('찾')}건\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `<i>(봇이 있어도 /최초등록 매칭이 안 된 방은 미초대로 집계됩니다)</i>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, res.rows, (s: Record<string, any>, idx) => {
            const guideInfo = s.guide_name
                ? `${escapeHtml(s.guide_name)} (${escapeHtml(s.guide_region || '')} ${escapeHtml(s.guide_district || '')})`
                : '미등록';
            // 현재 단계의 등록일 표시 (찾 → 찾_등록일, 합 → 합_등록일, 섭 → 섭_등록일)
            const stagePrefix = String(s['단계'] ?? '').trim().charAt(0);
            const regDate = getStageRegDate(s, stagePrefix);
            return (
                `<b>${idx}. ${escapeHtml(s['이름'] || '이름 없음')}</b> [${escapeHtml(s['단계'] || '-')}]\n` +
                `   • 인도자: ${guideInfo}\n` +
                `   • 교사: ${teacherText(s)}\n` +
                `   • ${escapeHtml(stagePrefix)}_등록일: ${regDate ? escapeHtml(regDate) : '미등록'}\n\n`
            );
        });
    } catch (err: unknown) {
        console.error('[미초대 명단 조회 에러]:', err);
        await replyError(ctx, '미초대 명단 조회', err);
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

        // 중단 시점별로 묶어서 (기록 도입 전 중단은 '시점 미기록')
        const phaseOf = (c: ChatRecord) =>
            c.stop_phase || (String(c.stop_reason || '').startsWith('인터뷰 후속 미신청') ? '인터뷰 후' : '시점 미기록');
        const phaseOrder = ['인터뷰 전', '인터뷰 후', '유형 선택 전', '교사 만남 중', '지인 만남 중', '행사 참석 단계', '시점 미기록'];
        stoppedChats.sort((a, b) => phaseOrder.indexOf(phaseOf(a)) - phaseOrder.indexOf(phaseOf(b)));
        const phaseCounts = phaseOrder
            .map((p) => [p, stoppedChats.filter((c) => phaseOf(c) === p).length] as const)
            .filter(([, n]) => n > 0)
            .map(([p, n]) => `${p} ${n}`)
            .join(' · ');

        const header =
            `🛑 <b>[만남 중단 대화방 목록] (총 ${stoppedChats.length}건)</b>\n` +
            `중단 시점: ${phaseCounts}\n` +
            `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;

        await sendChunkedList(ctx, header, stoppedChats, (chat, idx) => {
            const memberBadge = chat.matched_student_name ? ` (👤 ${escapeHtml(chat.matched_student_name)})` : '';
            return (
                `<b>${idx}. ${escapeHtml(chat.room_title || '대화방')}</b>${memberBadge}\n` +
                `   • 중단 시점: <b>${escapeHtml(phaseOf(chat))}</b>\n` +
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

        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[관리자 구분 조회 에러]:', err);
        await replyError(ctx, '조회', err);
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
            if (!needsReport(c)) return false;
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
        const acquaintanceCount = allChats.filter((c) => c.meeting_type === '지인' && c.meeting_date !== '중단').length;
        const eventCount = allChats.filter((c) => c.meeting_type === '행사' && c.meeting_date !== '중단').length;

        let msg = `📊 <b>[상담/복음방 전체 관리 현황]</b>\n`;
        msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
        msg += `총 등록된 대화방: <b>${allChats.length}개</b>\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n\n`;

        msg += `🎙️ <b>[진행 분류별 현황]</b>\n`;
        msg += `• 인터뷰 만남 진행: <b>${interviewCount}개 방</b> (조회: <code>관리자 인터뷰</code>)\n`;
        msg += `• 교사 만남 진행: <b>${teacherCount}개 방</b> (조회: <code>관리자 교사</code>)\n`;
        msg += `• 지인 만남 진행: <b>${acquaintanceCount}개 방</b> (조회: <code>관리자 지인</code>)\n`;
        msg += `• 행사 참석 (인터뷰 후속): <b>${eventCount}개 방</b> (조회: <code>관리자 행사</code>)\n\n`;

        msg += `🏷 <b>[진행 단계별 현황]</b>\n`;
        for (const stage of PROGRESS_STAGES) {
            msg += `• ${stage}: <b>${allChats.filter((c) => c.progress_stage === stage).length}개</b>\n`;
        }
        msg += `• 일반(중단 제외): <b>${normalCount}개</b> (조회: <code>관리자 일반</code>)\n\n`;

        msg += `🗓 <b>[일정 및 보고서 상태]</b>\n`;
        msg += `• ❓ <b>첫 만남일 미등록</b>: ${unassigned.length}개 방\n`;
        msg += `• ⏳ <b>만남일정 미정</b>: ${undecided.length}개 방 (조회: <code>관리자 미등록</code>)\n`;
        const stoppedBeforeInterview = stopped.filter((c) => c.stop_phase === '인터뷰 전').length;
        msg += `• 🛑 <b>만남 중단 상태</b>: ${stopped.length}개 방${
            stoppedBeforeInterview ? ` (인터뷰 전 중단 ${stoppedBeforeInterview})` : ''
        } (조회: <code>관리자 중단</code>)\n`;
        msg += `• 🚨 <b>보고서 미제출</b>: ${overdue.length}개 방 (조회: <code>관리자 미제출</code>)\n`;
        msg += `• ⌛ <b>만남일 경과 미갱신</b>: ${expired.length}개 방 (조회: <code>관리자 미갱신</code>)\n`;

        // 주의가 필요한 방
        const dropped = allChats.filter(isDroppedActive);
        const byStudent = new Map<string, ChatRecord[]>();
        for (const c of allChats) {
            if (!c.matched_member_id) continue;
            const key = String(c.matched_member_id);
            byStudent.set(key, [...(byStudent.get(key) || []), c]);
        }
        const duplicates = [...byStudent.values()].filter((list) => list.length > 1);
        if (dropped.length || duplicates.length) {
            msg += `\n⚠️ <b>[확인 필요]</b>\n`;
            if (dropped.length) {
                msg += `• <b>탈락 대상자인데 진행 중</b>: ${dropped.length}개 방 <i>(방에서 확인 전까지 알림 정지)</i>\n`;
                msg += dropped.slice(0, 10).map((c) => `   - ${escapeHtml(c.room_title)}`).join('\n') + '\n';
            }
            if (duplicates.length) {
                msg += `• <b>한 대상자가 여러 방에 매칭</b>: ${duplicates.length}명\n`;
                msg +=
                    duplicates
                        .slice(0, 10)
                        .map(
                            (list) =>
                                `   - ${escapeHtml(list[0].matched_student_name || '대상자')}: ${list
                                    .map((c) => escapeHtml(c.room_title))
                                    .join(' / ')}`
                        )
                        .join('\n') + '\n';
            }
        }

        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[종합 점검 에러]:', err);
    }
});

/* =====================================================
 * 📢 관리자 일괄 독촉 (관리자 미제출 알림 / 관리자 미갱신 알림 [타부서포함])
 * ===================================================== */
type BulkKind = 'overdue' | 'expired' | 'expiredall';

function isPastMeetingDate(c: ChatRecord, todayStr: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(c.meeting_date || '') && c.meeting_date < todayStr;
}

// 독촉 대상: 미제출 = 지난 만남(오늘 제외)의 보고서 미제출 / 미갱신 = 지난 만남일 이후 다음 일정 미등록
async function getBulkTargets(kind: BulkKind): Promise<ChatRecord[]> {
    const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    const chats = (await getAllChats()).filter((c) => !isDroppedActive(c));
    if (kind === 'overdue') return chats.filter((c) => isPastMeetingDate(c, todayStr) && !c.report_submitted && needsReport(c));
    return chats.filter(
        (c) => isPastMeetingDate(c, todayStr) && (kind === 'expiredall' || !isOtherDeptTeacher(c))
    );
}

function buildBulkMessage(kind: BulkKind, c: ChatRecord): string {
    const date = dayjs(c.meeting_date).format('MM/DD');
    if (kind === 'overdue') {
        const isInterview = c.meeting_type === '인터뷰';
        return (
            `📋 <b>[보고서 제출 요청]</b>\n` +
            `${date} ${isInterview ? '인터뷰' : '만남'}의 <b>${
                isInterview ? '인터뷰 사후 보고서' : '만남 보고서'
            }</b>가 아직 제출되지 않았습니다.\n` +
            `확인 후 작성해 주세요!\n\n` +
            `💡 양식: <code>${isInterview ? '/인터뷰사후양식' : '/만남보고서양식'}</code>`
        );
    }
    return (
        `🗓 <b>[다음 만남일 등록 요청]</b>\n` +
        `지난 만남일(${date}) 이후 다음 일정이 등록되지 않았습니다.\n` +
        `<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 등록해 주세요.`
    );
}

const BULK_LABEL: Record<BulkKind, string> = {
    overdue: '보고서 미제출',
    expired: '만남일 미갱신 (타부서 제외)',
    expiredall: '만남일 미갱신 (타부서 포함)',
};

bot.hears(/^(?:[\/!]?관리자\s+)(미제출|미갱신)\s*(타부서\s*포함)?\s*(?:알림|독촉|일괄\s*알림)$/i, async (ctx) => {
    try {
        if (!isAdmin(String(ctx.from?.id))) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }
        const kind: BulkKind = ctx.match[1] === '미제출' ? 'overdue' : ctx.match[2] ? 'expiredall' : 'expired';
        const targets = await getBulkTargets(kind);
        if (targets.length === 0) {
            await ctx.reply(`🎉 <b>[${BULK_LABEL[kind]}] 독촉할 대화방이 없습니다.</b>`, { parse_mode: 'HTML' });
            return;
        }

        const preview = targets
            .slice(0, 30)
            .map(
                (c, i) =>
                    `${i + 1}. ${escapeHtml(c.room_title || '대화방')}${
                        c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : ''
                    } · ${dayjs(c.meeting_date).format('MM/DD')}`
            )
            .join('\n');

        await replyLong(
            ctx,
            `📢 <b>[${BULK_LABEL[kind]}] 일괄 알림 확인</b>\n` +
                `아래 <b>${targets.length}개 방</b>에 알림을 보냅니다.\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                preview +
                (targets.length > 30 ? `\n… 외 ${targets.length - 30}개 방` : '') +
                `\n━━━━━━━━━━━━━━━━━━\n<b>보낼 메시지 예시</b>\n${buildBulkMessage(kind, targets[0])}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: `📢 ${targets.length}개 방에 보내기`, callback_data: `bulk:${kind}` },
                            { text: '❌ 취소', callback_data: 'bulk:cancel' },
                        ],
                    ],
                },
            }
        );
    } catch (err: unknown) {
        console.error('[일괄 알림 준비 에러]:', err);
        await replyError(ctx, '일괄 알림 준비', err);
    }
});

bot.action(/^bulk:(overdue|expired|expiredall|cancel)$/, async (ctx) => {
    try {
        if (!isAdmin(String(ctx.from?.id))) {
            await ctx.answerCbQuery('관리자만 사용할 수 있습니다.');
            return;
        }
        const action = ctx.match[1];
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        if (action === 'cancel') {
            await ctx.answerCbQuery('취소되었습니다.');
            await ctx.reply('❌ 일괄 알림을 취소했습니다.');
            return;
        }
        await ctx.answerCbQuery('발송을 시작합니다.');

        // 버튼을 누른 시점 기준으로 대상을 다시 계산 (그 사이 제출된 방 제외)
        const kind = action as BulkKind;
        const targets = await getBulkTargets(kind);
        let sent = 0;
        const failed: string[] = [];
        for (const c of targets) {
            try {
                await bot.telegram.sendMessage(c.chat_id, buildBulkMessage(kind, c), { parse_mode: 'HTML' });
                sent++;
            } catch (err: unknown) {
                failed.push(`${c.room_title || c.chat_id} (${getErrorMessage(err)})`);
            }
            await new Promise((r) => setTimeout(r, 100)); // 텔레그램 전송 속도 제한 대응
        }

        await replyLong(
            ctx,
            `✅ <b>[${BULK_LABEL[kind]}] 일괄 알림 완료</b>\n• 성공: ${sent}개 방` +
                (failed.length
                    ? `\n• 실패: ${failed.length}개 방 (봇이 내보내졌거나 방이 삭제된 경우)\n` +
                      failed.map((f) => `   - ${escapeHtml(f)}`).join('\n')
                    : '')
        );
    } catch (err: unknown) {
        console.error('[일괄 알림 발송 에러]:', err);
        await replyError(ctx, '일괄 알림 발송', err);
    }
});

/* =====================================================
 * 📊 주간 요약 (관리자 주간요약 / 매주 월요일 오전 크론 때 관리자에게 자동 발송)
 * ===================================================== */
async function buildWeeklySummary(): Promise<string> {
    const today = dayjs().tz('Asia/Seoul').startOf('day');
    const todayStr = today.format('YYYY-MM-DD');
    // 이번 주 월요일 ~ 일요일
    const monday = today.subtract((today.day() + 6) % 7, 'day');
    const weekDays = Array.from({ length: 7 }, (_, i) => monday.add(i, 'day').format('YYYY-MM-DD'));
    const weekEnd = weekDays[6];
    const weekAgo = today.subtract(7, 'day');

    const chats = await getAllChats();
    const active = chats.filter((c) => c.meeting_date !== '중단');

    const meetingsThisWeek = active.filter((c) => weekDays.includes(c.meeting_date));
    const stageThisWeek = active.filter((c) => {
        const d = getStageDate(c.progress_note)?.format('YYYY-MM-DD');
        return c.progress_stage && d && d >= weekDays[0] && d <= weekEnd;
    });
    const overdue = chats.filter((c) => isPastMeetingDate(c, todayStr) && !c.report_submitted && needsReport(c));
    const expired = chats.filter((c) => isPastMeetingDate(c, todayStr) && !isOtherDeptTeacher(c));
    const undecided = chats.filter((c) => c.meeting_date === '미정');
    const unassigned = chats.filter((c) => !c.meeting_date || c.meeting_date.trim() === '');
    const newlyStopped = chats.filter(
        (c) => c.meeting_date === '중단' && c.updated_at && dayjs(c.updated_at).isAfter(weekAgo)
    );

    let msg = `📊 <b>[주간 요약] ${dayjs(weekDays[0]).format('MM/DD')} ~ ${dayjs(weekEnd).format('MM/DD')}</b>\n`;
    msg += `기준시각: ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm')}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    // 월요일 오전에 발송되므로 '이번 주'가 아닌 최근 7일 기준
    const recentEvents = await getMeetingEvents(today.subtract(7, 'day'), today.add(1, 'day'));
    msg += `🆕 <b>최근 7일 신규 만남 발생: ${recentEvents.length}건</b> (<code>관리자 신규 지난주</code>)\n`;
    for (const category of Object.keys(MEETING_CATEGORY_LABEL) as MeetingCategory[]) {
        msg += `• ${MEETING_CATEGORY_LABEL[category]}: ${recentEvents.filter((e) => e.category === category).length}건\n`;
    }
    msg += `\n`;

    msg += `🗓 <b>이번 주 만남 예정: ${meetingsThisWeek.length}건</b>\n`;
    for (const day of weekDays) {
        const n = meetingsThisWeek.filter((c) => c.meeting_date === day).length;
        if (n) msg += `• ${dayjs(day).format('MM/DD')} (${'일월화수목금토'[dayjs(day).day()]}): ${n}건\n`;
    }
    const countType = (type: string) => meetingsThisWeek.filter((c) => c.meeting_type === type).length;
    msg += `  (인터뷰 ${countType('인터뷰')} · 교사 ${countType('교사')} · 지인 ${countType('지인')} · 행사 ${countType('행사')})\n\n`;

    msg += `🏷 <b>이번 주 진행 구분 목표일: ${stageThisWeek.length}건</b>\n`;
    for (const c of sortByStageDateDesc(stageThisWeek).reverse()) {
        msg += `• ${escapeHtml(c.progress_stage || '')} ${formatStageDate(c.progress_note)} · ${escapeHtml(
            c.room_title || '대화방'
        )}${c.matched_student_name ? ` (👤 ${escapeHtml(c.matched_student_name)})` : ''}\n`;
    }
    msg += `\n`;

    msg += `⚠️ <b>확인 필요</b>\n`;
    msg += `• 보고서 미제출: <b>${overdue.length}</b>건 (<code>관리자 미제출</code> · 독촉: <code>관리자 미제출 알림</code>)\n`;
    msg += `• 만남일 경과 미갱신: <b>${expired.length}</b>건 (<code>관리자 미갱신</code> · 독촉: <code>관리자 미갱신 알림</code>)\n`;
    msg += `• 일정 미정: <b>${undecided.length}</b>건 · 첫 만남일 미등록: <b>${unassigned.length}</b>건 (<code>관리자 미등록</code>)\n`;
    msg += `• 최근 7일 중단: <b>${newlyStopped.length}</b>건 (<code>관리자 중단</code>)\n`;
    return msg;
}

bot.hears(/^(?:[\/!]?관리자\s+)(주간\s*요약|주간\s*리포트|주간)$/i, async (ctx) => {
    try {
        if (!isAdmin(String(ctx.from?.id))) {
            await ctx.reply('⛔ 접근 권한이 없습니다.', { parse_mode: 'HTML' });
            return;
        }
        await replyLong(ctx, await buildWeeklySummary());
    } catch (err: unknown) {
        console.error('[주간 요약 에러]:', err);
        await replyError(ctx, '주간 요약 생성', err);
    }
});

// 월요일 오전 크론에서 호출: 관리자(ADMIN_IDS 개인 대화 또는 WEEKLY_REPORT_CHAT_ID)에게 주 1회 발송
async function sendWeeklySummaryIfMonday() {
    const today = dayjs().tz('Asia/Seoul');
    if (today.day() !== 1) return;
    const weekKey = today.format('YYYY-MM-DD');
    const already = await neonPool.query(`SELECT value FROM bot_meta WHERE key = 'weekly_summary_sent'`);
    if (already.rows[0]?.value === weekKey) return; // 같은 날 크론이 여러 번 호출돼도 한 번만

    const targets = (process.env.WEEKLY_REPORT_CHAT_ID || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const recipients = targets.length ? targets : ADMIN_IDS;
    if (recipients.length === 0) return;

    const summary = await buildWeeklySummary();
    for (const chatId of recipients) {
        for (const part of splitLongMessage(summary)) {
            await bot.telegram
                .sendMessage(chatId, part, { parse_mode: 'HTML' })
                .catch((err) => console.error(`[주간 요약 발송 실패] ${chatId}:`, getErrorMessage(err)));
        }
    }
    await neonPool.query(
        `INSERT INTO bot_meta (key, value) VALUES ('weekly_summary_sent', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [weekKey]
    );
}

// 교사 만남 누적 (인터뷰·지인 만남은 집계하지 않음) — 보고서를 고쳐 여러 번 올려도 만남 1회로 판단
// 1) 대상자·만남일당 1회
// 2) 다음 만남일(미래)이 이미 잡혀 있는데 올라온 보고서 = 직전 보고서의 수정본 → 회차 유지
// 3) 만남일이 미정·미등록이면 보고서를 올린 날 기준 하루 1회
async function recordTeacherMeeting(
    ctx: any,
    chatId: number | string
): Promise<{ round: number; added: boolean; seop: SeopRound | null } | null> {
    try {
        const record = await getChatRecord(chatId);
        if (!record?.matched_member_id || record.meeting_type === '인터뷰' || !needsReport(record)) return null;

        const id = String(chatId);
        const studentId = String(record.matched_member_id);
        const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
        const registered = record.meeting_date || '';
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(registered);

        if (isDate && registered > todayStr) {
            const prev = await neonPool.query(
                `SELECT 1 FROM teacher_meetings WHERE chat_id = $1 AND student_id = $2 LIMIT 1`,
                [id, studentId]
            );
            if (prev.rows.length > 0)
                return { round: record.teacher_meeting_count ?? 0, added: false, seop: await getSeopRound(record) };
        }
        const meetingDate = isDate && registered <= todayStr ? registered : todayStr;

        const messageId = ctx.message?.message_id ?? `${Date.now()}`;
        const res = await neonPool.query(
            `INSERT INTO teacher_meetings (chat_id, student_id, message_id, meeting_date) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING;`,
            [id, studentId, String(messageId), meetingDate]
        );
        const updated = await getChatRecord(chatId);
        return { round: updated?.teacher_meeting_count ?? 0, added: !!res.rowCount, seop: await getSeopRound(updated) };
    } catch (err: unknown) {
        console.error('[교사 만남 누적 실패]:', getErrorMessage(err));
        return null;
    }
}

// 섭등 후 회차: 섭등한 날의 만남을 1회차로 보고, 섭등일 이후 교사 만남마다 +1
//   = 1 + 이전 진행분 보정 + (섭등일 다음 날부터 기록된 교사 만남 수)
//   (섭등일 당일 보고서가 있어도 없어도 섭등일은 1회로만 셈)
type SeopRound = { seopDate: string; round: number };

async function getSeopRounds(
    chats: Pick<ChatRecord, 'chat_id' | 'matched_member_id' | 'seop_meeting_base'>[]
): Promise<Map<string, SeopRound>> {
    const result = new Map<string, SeopRound>();
    const studentIds = [...new Set(chats.filter((c) => c.matched_member_id).map((c) => String(c.matched_member_id)))];
    if (studentIds.length === 0) return result;

    const students = (await neonPool.query(`SELECT * FROM students WHERE id::text = ANY($1::text[])`, [studentIds])).rows;
    const seopDateById = new Map<string, string>();
    for (const st of students) {
        const ymd = getStageRegYmd(st, '섭');
        if (ymd) seopDateById.set(String(st.id), ymd);
    }
    if (seopDateById.size === 0) return result;

    const logs = (
        await neonPool.query(
            `SELECT chat_id, student_id, meeting_date FROM teacher_meetings WHERE student_id = ANY($1::text[])`,
            [[...seopDateById.keys()]]
        )
    ).rows;

    for (const c of chats) {
        const studentId = String(c.matched_member_id ?? '');
        const seopDate = seopDateById.get(studentId);
        if (!seopDate) continue;
        const after = logs.filter(
            (l) => l.chat_id === String(c.chat_id) && l.student_id === studentId && l.meeting_date > seopDate
        ).length;
        result.set(String(c.chat_id), { seopDate, round: 1 + Number(c.seop_meeting_base || 0) + after });
    }
    return result;
}

async function getSeopRound(chat: ChatRecord | undefined): Promise<SeopRound | null> {
    if (!chat) return null;
    return (await getSeopRounds([chat])).get(String(chat.chat_id)) ?? null;
}

function seopRoundText(seop: SeopRound | null): string {
    return seop ? ` · 섭등 후 <b>${seop.round}회차</b>` : '';
}

// 복등 안내: 섭등 후 3회차부터 복등(복_완료일)이 아직 없으면 안내
const BOK_REMIND_ROUND = 3;

// 복등 안내 대상인지 — 복등 이후 단계(복·예정·센확 완료일)가 이미 있거나 탈락이면 제외
async function needsBokReminder(studentId: number | string): Promise<boolean> {
    const st = (await neonPool.query(`SELECT * FROM students WHERE id::text = $1`, [String(studentId)])).rows[0];
    if (!st || String(st['단계'] ?? '').includes('탈락') || st['탈락']) return false;
    return !['복', '예정', '센확'].some((prefix) => getStageRegYmd(st, prefix));
}

// 만남 보고서로 섭등 후 회차가 새로 쌓였을 때 호출 — 상담방에 복등 안내, 딱 3회차가 된 때는 지역 담당방에도 알림
async function sendBokReminder(chatId: number | string, seop: SeopRound) {
    try {
        const record = await getChatRecord(chatId);
        if (!record?.matched_member_id || !(await needsBokReminder(record.matched_member_id))) return;

        await bot.telegram.sendMessage(
            chatId,
            `📣 <b>[복등 안내]</b>` +
                (record.matched_student_name ? ` (👤 ${escapeHtml(record.matched_student_name)})` : '') +
                `\n섭등 후 <b>${seop.round}회차</b> 만남입니다.\n` +
                `아직 <b>복등</b>이 되지 않았습니다. 복등을 진행해 주세요!`,
            { parse_mode: 'HTML' }
        );
        if (seop.round === BOK_REMIND_ROUND) {
            await notifyRegionChats(
                record,
                `📣 <b>[복등 대상 - 섭등 후 ${seop.round}회차]</b>\n` +
                    regionRoomInfo(record) +
                    `• 섭등일: ${escapeHtml(seop.seopDate)} · 복등 미등록`
            );
        }
    } catch (err: unknown) {
        console.error(`[복등 안내 실패] Chat: ${chatId}`, getErrorMessage(err));
    }
}

// 섭등 후 회차 보정 (/섭등회차 n → 섭등일 포함 현재까지 총 n회로 보정)
bot.hears(/^[\/!]섭등\s*(?:후\s*)?회차(?:@\w+)?(?:\s+(\d{1,3})\s*회?)?$/i, async (ctx) => {
    try {
        const record = await getChatRecord(ctx.chat.id);
        const seop = await getSeopRound(record);
        if (!record || !seop) {
            await ctx.reply(
                '⚠️ 섭등일을 찾을 수 없습니다. 행정(students)에 <b>섭 등록일</b>이 입력되어 있는지 확인해주세요. (<code>/행정확인</code>)',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const wanted = ctx.match[1];
        const currentBase = Number(record.seop_meeting_base || 0);
        const fromLogs = seop.round - currentBase; // 1(섭등일) + 봇 기록
        if (wanted === undefined) {
            await ctx.reply(
                `🌱 <b>섭등 후 교사 만남</b>\n` +
                    `• 섭등일: <b>${formatYmdWithDay(seop.seopDate)}</b>\n` +
                    `• 섭등 후 <b>${seop.round}회차</b>` +
                    (currentBase ? ` (이전 진행분 보정 ${currentBase}회 포함)` : '') +
                    `\n\n<i>섭등한 날의 만남이 1회차이고, 이후 만남 보고서마다 +1 됩니다.\n` +
                    `빠진 회차가 있으면 <code>/섭등회차 총횟수</code>로 보정하세요.</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const total = Number(wanted);
        if (total < fromLogs) {
            await ctx.reply(
                `⚠️ 섭등일과 봇 기록으로 이미 <b>${fromLogs}회</b>입니다. ${fromLogs} 이상으로 입력해주세요.`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        await updateChat(ctx.chat.id, { seop_meeting_base: total - fromLogs });
        await ctx.reply(
            `✅ <b>섭등 후 ${total}회차</b>로 보정했습니다. 다음 만남 보고서부터 ${total + 1}회차로 이어집니다.`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/섭등회차 에러]:', err);
        await replyError(ctx, '섭등 후 회차 처리', err);
    }
});

// 마지막 누적 1회 취소 (/회차취소) — 잘못 누적된 경우
bot.hears(/^[\/!](?:교사\s*만남\s*)?회차\s*취소(?:@\w+)?$/i, async (ctx) => {
    try {
        const record = await getChatRecord(ctx.chat.id);
        if (!record?.matched_member_id) {
            await ctx.reply('⚠️ 매칭된 대상자가 없습니다.');
            return;
        }
        const res = await neonPool.query(
            `DELETE FROM teacher_meetings WHERE id = (
                SELECT id FROM teacher_meetings WHERE chat_id = $1 AND student_id = $2
                ORDER BY meeting_date DESC, id DESC LIMIT 1
             ) RETURNING meeting_date;`,
            [String(ctx.chat.id), String(record.matched_member_id)]
        );
        if (!res.rowCount) {
            await ctx.reply('ℹ️ 취소할 교사 만남 기록이 없습니다. (이전 진행분 보정은 <code>/교사만남회차 총횟수</code>)', {
                parse_mode: 'HTML',
            });
            return;
        }
        const after = (await getChatRecord(ctx.chat.id))?.teacher_meeting_count ?? 0;
        await ctx.reply(
            `↩️ <b>${formatYmdWithDay(res.rows[0].meeting_date)}</b> 만남 기록을 취소했습니다.\n` +
                `• 현재 누적: <b>${after}회</b>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/회차취소 에러]:', err);
        await replyError(ctx, '회차 취소', err);
    }
});

// 교사 만남 회차 확인·보정 (/교사만남회차 → 기록 보기, /교사만남회차 n → 현재까지 총 n회로 보정)
bot.hears(/^[\/!](?:교사\s*만남\s*회차|만남\s*회차|회차)(?:@\w+)?(?:\s+(\d{1,3})\s*회?)?$/i, async (ctx) => {
    try {
        const record = await getChatRecord(ctx.chat.id);
        if (!record?.matched_member_id) {
            await ctx.reply('⚠️ 먼저 <code>/최초등록</code>으로 대상자를 매칭해주세요.', { parse_mode: 'HTML' });
            return;
        }
        const studentId = String(record.matched_member_id);
        const logs = (
            await neonPool.query(
                `SELECT meeting_date FROM teacher_meetings WHERE chat_id = $1 AND student_id = $2 ORDER BY meeting_date, id;`,
                [String(ctx.chat.id), studentId]
            )
        ).rows;

        const wanted = ctx.match[1];
        if (wanted !== undefined) {
            const total = Number(wanted);
            if (total < logs.length) {
                await ctx.reply(
                    `⚠️ 봇에 기록된 교사 만남이 이미 <b>${logs.length}회</b>입니다. ${logs.length} 이상으로 입력해주세요.`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
            await updateChat(ctx.chat.id, { teacher_meeting_base: total - logs.length });
            await ctx.reply(
                `✅ <b>교사 만남 누적 ${total}회</b>로 보정했습니다.\n` +
                    `<i>(봇 기록 ${logs.length}회 + 이전 진행분 ${total - logs.length}회 · 다음 만남 보고서부터 ${total + 1}회차로 이어집니다)</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const base = Number(record.teacher_meeting_base || 0);
        const seop = await getSeopRound(record);
        let msg =
            `👨‍🏫 <b>[교사 만남 누적] ${escapeHtml(record.matched_student_name || '')}</b>\n` +
            `• 총 <b>${base + logs.length}회</b>` +
            (base ? ` (이전 진행분 ${base}회 + 봇 기록 ${logs.length}회)` : '') +
            `\n` +
            (seop
                ? `• 섭등일 <b>${formatYmdWithDay(seop.seopDate)}</b> · 섭등 후 <b>${seop.round}회차</b> (<code>/섭등회차</code>)\n`
                : '') +
            `\n`;
        // 섭등 후 회차 = 1(섭등일) + 보정분 + 섭등일 다음 날부터의 기록 순번
        let seopIdx = seop ? 1 + Number(record.seop_meeting_base || 0) : 0;
        logs.forEach((l, i) => {
            const afterSeop = seop && l.meeting_date > seop.seopDate;
            msg +=
                `${base + i + 1}회차 · ${l.meeting_date ? formatYmdWithDay(l.meeting_date) : '-'}` +
                (afterSeop ? ` · 섭등 후 ${++seopIdx}회차` : seop && l.meeting_date === seop.seopDate ? ' · 🌱 섭등일' : '') +
                `\n`;
        });
        msg +=
            `\n<i>만남 보고서가 반영되면 만남일당 1회씩 누적됩니다 (고쳐서 다시 올린 보고서는 수정본으로 처리).\n` +
            `잘못 누적되면 <code>/회차취소</code>, 봇 도입 전 회차는 <code>/교사만남회차 총횟수</code>로 보정하세요.</i>`;
        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[/교사만남회차 에러]:', err);
        await replyError(ctx, '교사 만남 회차 조회', err);
    }
});

// 10. 일반 텍스트 수신 (사전 보고서, 결과 보고서, 만남 보고서 및 #피드백 감지)
// source: 'text' 일반 메시지 / 'caption' 사진·파일 설명글
async function handleIncomingText(ctx: any, rawText: string, source: 'text' | 'caption') {
    const text = rawText.trim();
    const chatId = ctx.chat.id;
    const roomTitle = 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';

    try {

    // 지역 담당방의 대화는 상담방 보고서로 처리하지 않음
    if (await isRegionChat(chatId)) return;

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
            const interviewTime = formattedDate === '미정' ? '' : parseFlexibleTime(stripDatePart(dateRaw));

            await upsertMeetingDate(chatId, roomTitle, formattedDate, interviewTime);

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
            resMsg += `• <b>인터뷰 예정일</b>: <b>${
                formattedDate === '미정' ? '미정' : formatMeetingWhen(formatYmdWithDay(formattedDate), interviewTime)
            }</b>\n`;
            if (formattedDate === '미정' && dateRaw && !dateRaw.includes('미정')) {
                resMsg += `⚠️ 날짜(<code>${escapeHtml(dateRaw)}</code>)를 인식하지 못해 [미정]으로 등록했습니다. <code>/인터뷰일 MM-DD</code>로 다시 등록해주세요.\n`;
            } else if (formattedDate !== '미정') {
                resMsg += getWeekdayWarning(dateRaw, formattedDate).trimStart() + getPastDateWarning(formattedDate);
            }
            resMsg += `\n`;
            resMsg += `• <b>D-1 알림 (10:00)</b>: 인터뷰 안내 알림\n`;
            resMsg += `• <b>당일 알림 (22:00)</b>: 결과 보고서 등록 알림\n\n`;
            resMsg += `💡 개별 수정: <code>/인터뷰어</code>, <code>/타이퍼</code>, <code>/인터뷰일</code>`;

            await ctx.reply(resMsg, { parse_mode: 'HTML' });
            return;
        } catch (err: unknown) {
            console.error('[사전 보고서 처리 에러]:', err);
            await replyError(ctx, '사전 보고서 처리', err);
            return;
        }
    }

    // B. [인터뷰 결과 보고서] 감지
    // '인터뷰 결과'만 있는 경우는 후속신청 항목도 있어야 인정 (만남 보고서 본문의 '인터뷰 결과 공유' 등 오인 방지)
    const isInterviewReport =
        /인터뷰\s*결과\s*보고서|인터뷰\s*보고서/.test(text) || (text.includes('인터뷰 결과') && /후속\s*신청/.test(text));

    if (isInterviewReport) {
        const followUpMatch = text.match(/후속[ \t]*신청[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
        const followUpRaw = followUpMatch ? followUpMatch[1].trim() : '';

        // X·O 표기는 단독으로 쓴 경우만 인정 (예전엔 'next' 같은 글자 속 x도 미신청으로 오인)
        const isNotApplied = /미신청|안함|거절|취소|보류|불가/.test(followUpRaw) || /^[Xx✕×❌](?![A-Za-z])/.test(followUpRaw);
        const isApplied =
            (/신청|완료|진행/.test(followUpRaw) || /^(?:[Oo○⭕]|ok)(?![A-Za-z])/i.test(followUpRaw)) && !isNotApplied;

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
                stop_phase: '인터뷰 후',
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

        // 후속이 상담이 아니라 행사 참석인 경우 — 일정만 관리하는 [행사 참석]으로 전환 (교사 매칭으로 세지 않음)
        const isEvent = /행사/.test(followUpRaw) && !isNotApplied;
        if (isEvent) {
            const eventMatch = text.match(/(?:^|\n)[^가-힣\n]*행사\s*(?:참석\s*)?(?:일|일정|날짜|일시)?\s*[:：]\s*([^\n\r]+)/);
            const rawEventDate = eventMatch?.[1]?.trim() || extractNextMeetingRaw(text) || '';
            const eventDate = rawEventDate && !rawEventDate.includes('미정') ? parseFlexibleDate(rawEventDate) : null;
            const eventStr = eventDate || '미정';
            const eventTime = eventDate ? parseFlexibleTime(stripDatePart(rawEventDate)) : '';

            await upsertMeetingDate(chatId, roomTitle, eventStr, eventTime);
            await updateChat(chatId, {
                meeting_type: '행사',
                follow_up_applied: '행사',
                follow_up_reason: '',
                interview_report_submitted: 1,
                report_submitted: 0,
            });

            await ctx.reply(
                `🎪 <b>인터뷰 결과 보고서가 반영되었습니다.</b>\n\n` +
                    `• <b>후속</b>: <b>행사 참석</b> (상담이 아닌 행사로 기록)\n` +
                    `• <b>행사일</b>: <b>${eventStr === '미정' ? '미정' : formatMeetingWhen(formatYmdWithDay(eventStr), eventTime)}</b>\n` +
                    (eventStr === '미정' && rawEventDate && !rawEventDate.includes('미정')
                        ? `⚠️ 날짜(<code>${escapeHtml(rawEventDate)}</code>)를 인식하지 못해 [미정]으로 등록했습니다. <code>/만남일 MM-DD</code>로 다시 등록해주세요.\n`
                        : '') +
                    `\n행사 참석은 <b>일정만 관리</b>합니다 (보고서 제출·미제출 알림 없음).\n` +
                    `• 일정 변경: <code>/만남일 MM-DD</code>\n` +
                    `• 행사 후 상담(교사 만남)으로 이어지면: <code>/교사전환</code>`,
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

            const nextTime = nextMeetingStr === '미정' ? '' : parseFlexibleTime(stripDatePart(rawNextDate || ''));
            await upsertMeetingDate(chatId, roomTitle, nextMeetingStr, nextTime);
            await updateChat(chatId, {
                meeting_type: '교사',
                follow_up_applied: '신청',
                follow_up_reason: '',
                interview_report_submitted: 1,
                report_submitted: 0,
            });
            await recordMeetingEvent(chatId, '교사매칭', '인터뷰후속');

            await ctx.reply(
                `🎉 <b>인터뷰 결과 보고서가 정상 반영되었습니다!</b>\n\n` +
                    `• <b>후속 신청</b>: <b>신청 완료 ✅</b>\n` +
                    `• <b>만남 단계</b>: <b>👨‍🏫 교사 만남</b>으로 자동 전환되었습니다.\n` +
                    `• <b>다음 만남 예정일</b>: <b>${
                        nextMeetingStr === '미정' ? '미정' : formatMeetingWhen(formatYmdWithDay(nextMeetingStr), nextTime)
                    }</b>\n` +
                    (nextMeetingStr === '미정' && rawNextDate && !isUndecided
                        ? `⚠️ 날짜(<code>${escapeHtml(rawNextDate)}</code>)를 인식하지 못해 [미정]으로 등록했습니다. <code>/만남일 MM-DD</code>로 다시 등록해주세요.\n`
                        : '') +
                    `\n` +
                    `앞으로 교사 만남 주기(D-1 피드백, 당일 만남보고서)에 맞춰 자동 관리됩니다.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        await ctx.reply(
            '⚠️ <b>[후속신청 여부 확인 필요]</b>\n\n' +
                '인터뷰 결과 보고서에서 <b>후속신청</b>(신청 / 행사참석 / 미신청)을 판별하지 못했습니다.\n' +
                '양식에 <code>• 후속신청: 신청</code>, <code>• 후속신청: 행사참석</code> 또는 <code>• 후속신청: 미신청</code>을 명시해주세요.',
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

        // 만남일이 다음 일정으로 바뀌기 전에 이번 만남을 누적
        const meeting = await recordTeacherMeeting(ctx, chatId);
        // 보고서 반영 안내를 먼저 보낸 뒤 복등 안내 (새로 누적된 만남이 섭등 후 3회차 이상일 때)
        const afterReport = async () => {
            if (meeting?.added && meeting.seop && meeting.seop.round >= BOK_REMIND_ROUND) {
                await sendBokReminder(chatId, meeting.seop);
            }
        };
        const roundText = !meeting
            ? ''
            : meeting.added
            ? `\n👨‍🏫 <b>교사 만남 ${meeting.round}회차</b>${seopRoundText(meeting.seop)}로 누적되었습니다.`
            : `\n✏️ 직전 보고서의 수정본으로 반영했습니다. (교사 만남 <b>${meeting.round}회차</b>${seopRoundText(
                  meeting.seop
              )} 유지)`;

        const rawNextDate = extractNextMeetingRaw(text);

        if (rawNextDate && rawNextDate.includes('미정')) {
            await upsertMeetingDate(chatId, roomTitle, '미정');
            await updateChat(chatId, { report_submitted: 1 });

            await ctx.reply(
                '✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n\n' +
                    '📌 <b>다음 만남일이 [미정]으로 기록되었습니다.</b>\n' +
                    '추후 만남 일정이 다시 잡히면 <code>/만남일 MM-DD</code>로 알려주세요!' +
                    roundText,
                { parse_mode: 'HTML' }
            );
            await afterReport();
            return;
        }

        const nextDate = rawNextDate ? parseFlexibleDate(rawNextDate) : null;

        if (!nextDate) {
            await updateChat(chatId, { report_submitted: 1 });
            await ctx.reply(
                '⚠️ 만남 보고서는 확인되었으나 <b>다음만남일</b> 날짜를 인식하지 못했습니다.\n' +
                    (rawNextDate ? `❌ 인식하지 못한 입력: ${escapeHtml(rawNextDate)}\n` : '') +
                    '<code>/만남일 MM-DD</code> 또는 <code>/만남일 미정</code>으로 일정을 등록해주세요.' +
                    roundText,
                { parse_mode: 'HTML' }
            );
            await afterReport();
            return;
        }

        const nextTime = parseFlexibleTime(stripDatePart(rawNextDate || ''));
        await upsertMeetingDate(chatId, roomTitle, nextDate, nextTime);
        await ctx.reply(
            `✅ <b>만남 보고서가 정상 반영되었습니다.</b>\n다음 만남일이 <b>${formatMeetingWhen(
                formatYmdWithDay(nextDate),
                nextTime
            )}</b>로 자동 갱신되었습니다.` +
                getWeekdayWarning(rawNextDate || '', nextDate) +
                getPastDateWarning(nextDate) +
                roundText,
            { parse_mode: 'HTML' }
        );
        await afterReport();
        return;
    }

    // D. 피드백 감지
    if (/#피드백내용|#피드백/.test(text)) {
        await updateChat(chatId, { feedback_submitted: 1 });
        await ctx.reply('📝 <b>피드백 내용이 확인되었습니다.</b> 감사합니다.', { parse_mode: 'HTML' });
    }
    } catch (err: unknown) {
        console.error(`[텍스트 메시지 처리 에러] (${source}):`, getErrorMessage(err));
        await replyError(ctx, '메시지 처리', err);
    }
}

bot.on('text', (ctx) => handleIncomingText(ctx, ctx.message.text, 'text'));

// 사진·파일에 설명글로 붙인 보고서 / #피드백도 인식
bot.on(['photo', 'document', 'video'], async (ctx) => {
    const caption: string | undefined = (ctx.message as any)?.caption;
    if (!caption) return;
    await handleIncomingText(ctx, caption, 'caption');
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
    const regionChats = await getRegionChats();

    const escalations: NudgeEscalation[] = [];

    for (const chat of chats) {
        const todayStr = today.format('YYYY-MM-DD');
        // 진행이 멈춘 방 안내 (방마다 하루 하나)
        await sendRoomNudge(chat, today, todayStr, escalations);
        // 탈락 대상자 방은 확인(중단·계속 진행) 전까지 다른 알림을 보내지 않음
        if (isDroppedActive(chat)) continue;

        // 진행 구분 날짜(섭등목표 / 예정목표 / 가능목표 / 확정목표) 당일 안내 — 같은 날짜로는 한 번만
        const stageDate = getStageDate(chat.progress_note);
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
                await handleRoomSendFailure(chat.chat_id, err);
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
                            `내일(${formatMeetingWhen(mDate.format('MM/DD'), chat.meeting_time)})은 인터뷰 만남 예정일입니다.\n` +
                            `• 담당 인터뷰어: ${escapeHtml(chat.interviewer_info || '미등록')}\n` +
                            `• 타이퍼: ${escapeHtml(chat.typer_info || '미지정')}\n\n` +
                            `인터뷰 전 사전 준비사항과 대상자 상태를 점검해 주세요!`,
                        { parse_mode: 'HTML' }
                    );
                } else if (chat.meeting_type === '행사') {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `🔔 <b>[D-1 행사 참석 안내]</b>\n` +
                            `내일(${formatMeetingWhen(mDate.format('MM/DD'), chat.meeting_time)})은 행사 참석 예정일입니다.\n` +
                            `대상자 참석 여부를 확인해 주세요. 행사 후 상담으로 이어지면 <code>/교사전환</code>, 다음 일정은 <code>/만남일 MM-DD</code>`,
                        { parse_mode: 'HTML' }
                    );
                } else if (chat.meeting_type === '지인') {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `🔔 <b>[D-1 지인 만남 안내]</b>\n` +
                            `내일(${formatMeetingWhen(mDate.format('MM/DD'), chat.meeting_time)})은 지인 만남 예정일입니다.\n` +
                            `만남 후 다음 일정이 정해지면 <code>/만남일 MM-DD</code>로 등록해 주세요.`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.telegram.sendMessage(
                        chat.chat_id,
                        `🔔 <b>[D-1 만남 안내]</b>\n` +
                            `내일(${formatMeetingWhen(mDate.format('MM/DD'), chat.meeting_time)})은 만남 예정일입니다.\n` +
                            `만남 전 <b>피드백 내용</b>을 <code>#피드백</code> 태그를 포함하여 작성해 주세요!`,
                        { parse_mode: 'HTML' }
                    );
                }
                await updateChat(chat.chat_id, { d_minus_1_notified: 1 });
            } catch (err: unknown) {
                console.error(`[오전 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
                await handleRoomSendFailure(chat.chat_id, err);
            }
        }

        // D+1 미제출 알림
        if (diffDays === 1 && !chat.report_submitted && needsReport(chat) && !chat.overdue_1_notified) {
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
                await handleRoomSendFailure(chat.chat_id, err);
            }
        }

        // D+2 경고 알림
        if (diffDays >= 2 && !chat.report_submitted && needsReport(chat) && !chat.overdue_2_notified) {
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

                const isInterview = chat.meeting_type === '인터뷰';
                await notifyRegionChats(
                    chat,
                    `🚨 <b>[보고서 제출 지연]</b>\n` +
                        regionRoomInfo(chat) +
                        `• ${isInterview ? '인터뷰일' : '만남일'}: <b>${mDate.format('MM/DD')}</b> (${diffDays}일 경과)\n\n` +
                        `${isInterview ? '인터뷰 사후 보고서' : '만남 보고서'}가 아직 제출되지 않았습니다.`,
                    regionChats
                );
            } catch (err: unknown) {
                console.error(`[D+2 경고 알림 실패] Chat: ${chat.chat_id}`, getErrorMessage(err));
                await handleRoomSendFailure(chat.chat_id, err);
            }
        }
    }

    if (escalations.length) await sendNudgeEscalations(escalations, regionChats);
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
        if (!needsReport(chat) || isDroppedActive(chat)) continue;

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
                await handleRoomSendFailure(chat.chat_id, err);
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
const webhookHandler = bot.webhookCallback('/webhook', { secretToken: WEBHOOK_SECRET });

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/webhook') {
        return webhookHandler(req, res);
    }

    // 웹 최초등록 알림 (POST /notify/registered, 헤더 x-notify-secret, 본문 { chat_id })
    // BOT_NOTIFY_SECRET이 없으면 이 기능은 꺼짐 — 웹 서버에도 같은 값을 넣어야 함
    if (req.method === 'POST' && url.pathname === '/notify/registered') {
        const json = (status: number, body: object) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        const notifySecret = process.env.BOT_NOTIFY_SECRET;
        const given = String(req.headers['x-notify-secret'] || '');
        if (
            !notifySecret ||
            given.length !== notifySecret.length ||
            !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(notifySecret))
        ) {
            return json(403, { ok: false, error: 'Forbidden' });
        }
        try {
            let raw = '';
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 10_000) return json(413, { ok: false, error: 'Too large' });
            }
            const chatId = String(JSON.parse(raw || '{}').chat_id ?? '').trim();
            if (!/^-?\d+$/.test(chatId)) return json(400, { ok: false, error: 'chat_id가 필요합니다.' });
            const result = await notifyWebRegistration(chatId);
            return json(result.ok ? 200 : 404, result);
        } catch (err: unknown) {
            console.error('[웹 최초등록 알림 에러]:', getErrorMessage(err));
            return json(500, { ok: false, error: getErrorMessage(err) });
        }
    }

    // 웹에서 보내는 알림 (헤더 x-notify-secret = BOT_NOTIFY_SECRET, 본문 JSON)
    // - /notify/region-message { chat_id, text }: 지역 담당방(region_chats)에 글 그대로 (장기 미진행·주간 요약·웹 수정 알림 등)
    // - /notify/web-edit { chat_id, changes, actions }: 웹에서 고친 상담방에 상담 봇 문구로 알림
    if (req.method === 'POST' && (url.pathname === '/notify/region-message' || url.pathname === '/notify/web-edit')) {
        const json = (status: number, body: object) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        const notifySecret = process.env.BOT_NOTIFY_SECRET;
        const given = String(req.headers['x-notify-secret'] || '');
        if (
            !notifySecret ||
            given.length !== notifySecret.length ||
            !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(notifySecret))
        ) {
            return json(403, { ok: false, error: 'Forbidden' });
        }
        try {
            let raw = '';
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 20_000) return json(413, { ok: false, error: 'Too large' });
            }
            const body = JSON.parse(raw || '{}');
            const chatId = String(body.chat_id ?? '').trim();
            if (!/^-?\d+$/.test(chatId)) return json(400, { ok: false, error: 'chat_id가 필요합니다.' });

            if (url.pathname === '/notify/region-message') {
                const text = String(body.text ?? '');
                if (!text.trim() || text.length > 4000) return json(400, { ok: false, error: '내용은 1~4000자여야 합니다.' });
                if (!(await isRegionChat(chatId))) {
                    return json(404, { ok: false, error: '상담 봇의 지역 담당방이 아닙니다. (/담당방등록 필요)' });
                }
                await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
                return json(200, { ok: true });
            }

            // /notify/web-edit: 인증된 상담방에만
            const record = await getChatRecord(chatId);
            if (!record || !(await isAuthorizedChat(chatId))) {
                return json(404, { ok: false, error: '상담 봇이 관리하는 상담방이 아닙니다.' });
            }
            const changes = (Array.isArray(body.changes) ? body.changes : []).map(String).slice(0, 20);
            const actions = new Set<string>((Array.isArray(body.actions) ? body.actions : []).map(String));
            if (changes.length === 0) return json(400, { ok: false, error: '바뀐 내용이 없습니다.' });
            await bot.telegram.sendMessage(chatId, webEditMessage(record, changes, actions), { parse_mode: 'HTML' });
            return json(200, { ok: true });
        } catch (err: unknown) {
            console.error('[웹 알림 에러]:', getErrorMessage(err));
            return json(500, { ok: false, error: getErrorMessage(err) });
        }
    }

    // DB 오류 등으로 알림이 실패해도 서버가 죽지 않고 500으로 응답 (크론 쪽에서 실패 확인 가능)
    const cronJobs: Record<string, [() => Promise<void>, string]> = {
        '/cron-10am': [
            async () => {
                await triggerMorningReminder();
                await sendWeeklySummaryIfMonday();
                await sendRegionDailySummaries('morning');
            },
            'Morning reminder executed',
        ],
        '/cron-10pm': [
            async () => {
                await triggerNightReminder();
                await sendRegionDailySummaries('night');
            },
            'Night reminder executed',
        ],
    };
    const cron = cronJobs[url.pathname];
    if (cron) {
        // CRON_SECRET이 설정되어 있으면 ?key=비밀값 이 맞아야 실행 (주소만 알아도 누구나 실행하는 것 방지)
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret && url.searchParams.get('key') !== cronSecret) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Forbidden');
        }
        try {
            await cron[0]();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(cron[1]);
        } catch (err: unknown) {
            console.error(`[${url.pathname} 실행 에러]:`, getErrorMessage(err));
            await alertAdmins(url.pathname, '정기 알림 실행 실패', err);
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Reminder failed');
        }
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
        // 수정된 메시지(edited_message)는 받지 않음 — 지정하지 않으면 이전 설정이 유지됨
        await bot.telegram.setWebhook(webhookUrl, {
            allowed_updates: ['message', 'callback_query', 'my_chat_member'],
            secret_token: WEBHOOK_SECRET,
        });
        console.log(`Telegram Webhook 등록 완료: ${webhookUrl}`);
    } catch (e: unknown) {
        console.error('Webhook 등록 에러:', getErrorMessage(e));
    }
});
