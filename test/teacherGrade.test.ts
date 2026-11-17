import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeOf, pickNextTeacher } from '../src/teacherGrade.ts';

test('상: 4개 이상 + ①②③ 필수', () => {
    assert.equal(gradeOf(['a1', 'a2', 'a3', 'a5']).grade, '상');
    assert.equal(gradeOf(['a1', 'a2', 'a3', 'a5']).next, null);
    // ③이 빠지면 4개여도 상이 아니다 → 중 조건도 없으면 하
    assert.deepEqual(gradeOf(['a1', 'a2', 'a4', 'a5']), { grade: '하', next: '중까지: 중① 필수 공과 2개+, 중② 영상담 가능, 그 밖에 1개 더' });
});

test('중: 3개 이상 + ①② 필수, 상까지 남은 것', () => {
    assert.deepEqual(gradeOf(['b1', 'b2', 'b5', 'a2']), { grade: '중', next: '상까지: 상① 개인복 센등 2회, 상③ 관계 우위·신뢰, 그 밖에 1개 더' });
    assert.equal(gradeOf(['b1', 'b5', 'b3']).grade, '하');
});

test('다음 교사: 완료·다른 사람이 방금 연 교사는 건너뛰고, 끝에서 처음으로', () => {
    const now = Date.parse('2026-11-17T10:00:00Z');
    const t = (id: number, extra: Partial<{ done_at: Date | null; updated_by: string | null; updated_at: Date | null }> = {}) => ({
        id,
        done_at: null,
        updated_by: null,
        updated_at: null,
        ...extra,
    });
    const list = [
        t(1),
        t(2, { done_at: new Date(now) }),
        t(3, { updated_by: '남 (2)', updated_at: new Date(now - 60_000) }),
        t(4, { updated_by: '남 (2)', updated_at: new Date(now - 20 * 60_000) }),
        t(5, { updated_by: '나 (1)', updated_at: new Date(now - 60_000) }),
    ];
    assert.equal(pickNextTeacher(list, 1, '나 (1)', now)?.id, 4); // 2 완료, 3 남이 방금 엶
    assert.equal(pickNextTeacher(list, 4, '나 (1)', now)?.id, 5); // 내가 연 건 괜찮다
    assert.equal(pickNextTeacher(list, 5, '나 (1)', now)?.id, 1); // 끝 → 처음
    assert.equal(pickNextTeacher(list, 0, '나 (1)', now)?.id, 1); // 목록에서 이어서
    assert.equal(pickNextTeacher([t(1, { done_at: new Date(now) })], 1, '나 (1)', now), null);
});
