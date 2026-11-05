import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOfCode, TARGET_CODES, targetAskText, targetKindOfStage, targetLine, targetSummaryText } from '../src/target.ts';

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
    assert.match(t, /섭등 타겟 확인/);
    assert.match(t, /주2회 센터요일/);
    assert.match(t, /11월/);
    assert.match(t, /&lt;홍&gt;/);
});

test('명단 한 줄 형식과 지역 현황', () => {
    assert.equal(targetLine(person, ['합등 타겟', '11월']), '합/홍길동/도봉/1-2/김인도////합등 타겟/11월');
    const text = targetSummaryText('도봉', [
        { ...person, kind: '섭등', stage: '섭' },
        { ...person, kind: '합등' },
    ]);
    assert.match(text, /현재 타겟 2명 \(합등 1 · 섭등 1 · 복등 0\)/);
    assert.ok(text.indexOf('합등 타겟') < text.indexOf('섭등 타겟')); // 단계 순서
});
