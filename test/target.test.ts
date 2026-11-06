import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    kindOfCode,
    monthOrder,
    TARGET_CODES,
    targetAskText,
    targetKindOfStage,
    targetLine,
    targetMonthKey,
    targetScore,
    targetScoreText,
    targetStatusText,
} from '../src/target.ts';

const person = {
    student_id: 1,
    name: '홍길동',
    stage: '합',
    target_month: '11월',
    guide_region: '도봉',
    guide_district: '1-2',
    guide_name: '김인도',
    teacher_region: null,
    teacher_district: null,
    teacher_name: null,
};

test('행정 단계 → 그 단계 타겟 (합·섭·복만, 탈락은 없음)', () => {
    assert.equal(targetKindOfStage('합'), '합등');
    assert.equal(targetKindOfStage('섭'), '섭등');
    assert.equal(targetKindOfStage('복'), '복등');
    assert.equal(targetKindOfStage('찾'), null);
    assert.equal(targetKindOfStage('예정'), null);
    assert.equal(targetKindOfStage('합(탈락)'), null);
});

test('버튼 코드 ↔ 타겟', () => {
    for (const [k, code] of Object.entries(TARGET_CODES)) assert.equal(kindOfCode(code), k);
    assert.equal(kindOfCode('x'), null);
});

test('묻는 글에 기준과 목표월이 들어간다', () => {
    const t = targetAskText({ kind: '섭등', name: '<홍>', targetMonth: '11월', reason: 'stage' });
    assert.match(t, /11월 섭등 타겟 확인/);
    assert.match(t, /주2회 센터요일/);
    assert.match(t, /11월/);
    assert.match(t, /&lt;홍&gt;/);
});

test('목표월 키: n월만, 장기·빈 값은 없음', () => {
    assert.equal(targetMonthKey('11월'), '11월');
    assert.equal(targetMonthKey(' 3 '), '3월');
    assert.equal(targetMonthKey('장기'), null);
    assert.equal(targetMonthKey(null), null);
    assert.equal(targetMonthKey('13월'), null);
    assert.ok(monthOrder('11월', 11) < monthOrder('12월', 11));
    assert.ok(monthOrder('1월', 11) < monthOrder('10월', 11)); // 이번 달부터 앞으로
});

test('명단 한 줄 형식', () => {
    assert.equal(targetLine(person, ['11월 합등 타겟']), '합/홍길동/도봉/1-2/김인도////11월 합등 타겟');
});

test('/타겟현황: 목표월마다 타겟·미정·아님, 목표월 없음은 끝', () => {
    const text = targetStatusText(
        '도봉',
        [
            { ...person, kind: '합등', answer: true },
            { ...person, kind: '합등', answer: null, name: '미정이' },
            { ...person, kind: '섭등', answer: false, stage: '섭', name: '아님이' },
            { ...person, kind: '합등', answer: null, target_month: null, name: '없음이' },
        ],
        11,
    );
    assert.match(text, /합·섭·복 4명, 타겟 1명/);
    assert.match(text, /\[11월\] 타겟 1 · 미정 1 · 아님 1/);
    assert.match(text, /❔ 미정 1명[^\n]*\n• 합\/미정이\/[^\n]*11월 합등 미정/);
    assert.match(text, /➖ 아님 1명/);
    assert.ok(text.indexOf('[11월]') < text.indexOf('[목표월 없음 1명]'));
});

test('타겟 건수·점수: 합등은 인도자 지역 1건, 섭등·복등은 인도자 0.5 + 교사 0.5', () => {
    const inDobong = (v: string | null) => v === '도봉';
    const hab = { ...person, kind: '합등' as const, guide_region: '성북', teacher_region: '도봉' };
    const seop = { ...person, kind: '섭등' as const, stage: '섭', teacher_region: '성북' };
    assert.equal(targetScore(hab, inDobong), 0);
    assert.equal(targetScore(seop, inDobong), 0.5);
    assert.equal(targetScoreText([hab, seop], inDobong), '합등 0건 · 섭등 0.5점 · 복등 0점');
    // 도봉 현황: 교사만 도봉인 합등은 빠진다
    const text = targetStatusText('도봉', [{ ...hab, answer: true }, { ...seop, answer: true }], 11, 60, inDobong);
    assert.match(text, /합·섭·복 1명/);
    assert.match(text, /✅ 타겟 1명 \(합등 0건 · 섭등 0.5점 · 복등 0점\)/);
});
