import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

interface ChatRecord {
    chat_id: string;
    room_title: string;
    matched_member_id?: number | string | null;
    meeting_date?: string;
    stop_reason?: string;
    progress_stage?: string;
    progress_note?: string;
    feedback_submitted?: number;
    report_submitted?: number;
    d_minus_1_notified?: number;
    d_day_22_notified?: number;
    overdue_1_notified?: number;
    overdue_2_notified?: number;
    created_at?: string;
    updated_at?: string;
}

const dbUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
    console.error('❌ 환경 변수에 NEON_DATABASE_URL 또는 DATABASE_URL이 설정되어 있지 않습니다.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
});

async function runMigration() {
    const jsonPath = path.resolve(process.cwd(), 'data', 'counseling_chats.json');

    if (!fs.existsSync(jsonPath)) {
        console.error(`❌ JSON 파일이 존재하지 않습니다: ${jsonPath}`);
        process.exit(1);
    }

    const rawData = fs.readFileSync(jsonPath, 'utf-8');
    let chatMap: Record<string, ChatRecord> = {};

    try {
        chatMap = JSON.parse(rawData);
    } catch (e: unknown) {
        console.error('❌ JSON 파싱 에러:', e instanceof Error ? e.message : String(e));
        process.exit(1);
    }

    const records = Object.values(chatMap);
    console.log(`📦 발견된 대화방 레코드 수: ${records.length}개`);

    if (records.length === 0) {
        console.log('⚠️ 이관할 데이터가 없습니다.');
        await pool.end();
        return;
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. 테이블이 없을 경우 자동 생성
        await client.query(`
            CREATE TABLE IF NOT EXISTS counseling_chats (
                chat_id VARCHAR(64) PRIMARY KEY,
                room_title VARCHAR(255) NOT NULL,
                matched_member_id INT,
                meeting_date VARCHAR(32) DEFAULT '',
                stop_reason TEXT DEFAULT '',
                progress_stage VARCHAR(32) DEFAULT '',
                progress_note TEXT DEFAULT '',
                feedback_submitted SMALLINT DEFAULT 0,
                report_submitted SMALLINT DEFAULT 0,
                d_minus_1_notified SMALLINT DEFAULT 0,
                d_day_22_notified SMALLINT DEFAULT 0,
                overdue_1_notified SMALLINT DEFAULT 0,
                overdue_2_notified SMALLINT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ counseling_chats 테이블 확인 및 생성 완료');

        // 2. 일괄 Upsert 쿼리 정의
        const upsertQuery = `
            INSERT INTO counseling_chats (
                chat_id, room_title, matched_member_id, meeting_date, stop_reason,
                progress_stage, progress_note, feedback_submitted, report_submitted,
                d_minus_1_notified, d_day_22_notified, overdue_1_notified, overdue_2_notified,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9,
                $10, $11, $12, $13,
                $14, $15
            )
            ON CONFLICT (chat_id) DO UPDATE SET
                room_title = EXCLUDED.room_title,
                matched_member_id = COALESCE(EXCLUDED.matched_member_id, counseling_chats.matched_member_id),
                meeting_date = EXCLUDED.meeting_date,
                stop_reason = EXCLUDED.stop_reason,
                progress_stage = EXCLUDED.progress_stage,
                progress_note = EXCLUDED.progress_note,
                feedback_submitted = EXCLUDED.feedback_submitted,
                report_submitted = EXCLUDED.report_submitted,
                d_minus_1_notified = EXCLUDED.d_minus_1_notified,
                d_day_22_notified = EXCLUDED.d_day_22_notified,
                overdue_1_notified = EXCLUDED.overdue_1_notified,
                overdue_2_notified = EXCLUDED.overdue_2_notified,
                updated_at = EXCLUDED.updated_at;
        `;

        let migratedCount = 0;

        for (const record of records) {
            const values = [
                String(record.chat_id),
                record.room_title || '대화방',
                record.matched_member_id ? Number(record.matched_member_id) : null,
                record.meeting_date || '',
                record.stop_reason || '',
                record.progress_stage || '',
                record.progress_note || '',
                record.feedback_submitted ? 1 : 0,
                record.report_submitted ? 1 : 0,
                record.d_minus_1_notified ? 1 : 0,
                record.d_day_22_notified ? 1 : 0,
                record.overdue_1_notified ? 1 : 0,
                record.overdue_2_notified ? 1 : 0,
                record.created_at ? new Date(record.created_at) : new Date(),
                record.updated_at ? new Date(record.updated_at) : new Date(),
            ];

            await client.query(upsertQuery, values);
            migratedCount++;
        }

        await client.query('COMMIT');
        console.log(`🎉 성공: 총 ${migratedCount}개의 대화방 데이터가 Neon DB로 안전하게 이관되었습니다.`);
    } catch (err: unknown) {
        await client.query('ROLLBACK');
        console.error('❌ 마이그레이션 실패 (롤백 처리됨):', err);
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration();
