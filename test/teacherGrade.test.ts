import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeOf } from '../src/teacherGrade.ts';

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
