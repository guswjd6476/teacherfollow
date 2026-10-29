import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractNextMeetingRaw,
    findMissingReportFields,
    parseFlexibleDate,
    parseFlexibleTime,
    stripDatePart,
    weekDateOptions,
} from '../src/parse.ts';

const REPORT = `[만남 보고서]
▶️ 진행내용: 1과 복습, 질문 답변
▶️ 상담반응 및 특이사항: 집중도 좋음
▪️ 다음만남일: 2026.11.3(화) 오후 7시`;

test('날짜: 연도 포함 형식', () => {
    assert.equal(parseFlexibleDate('2026.11.3'), '2026-11-03');
    assert.equal(parseFlexibleDate('2026년 11월 3일'), '2026-11-03');
    assert.equal(parseFlexibleDate('26.11.3'), '2026-11-03');
    assert.equal(parseFlexibleDate('２０２６．１１．３'), '2026-11-03'); // 전각
});

test('날짜: 없는 날짜·빈 값은 null', () => {
    assert.equal(parseFlexibleDate('2026.2.30'), null);
    assert.equal(parseFlexibleDate(''), null);
    assert.equal(parseFlexibleDate('미정'), null);
});

test('날짜: 월·일만 쓰면 형식과 관계없이 같은 날', () => {
    const d = parseFlexibleDate('11.3');
    assert.match(d ?? '', /^\d{4}-11-03$/);
    for (const s of ['11/3', '11-03', '11월 3일', '11.3(화) 19시']) assert.equal(parseFlexibleDate(s), d, s);
});

test('시간: 오전/오후·반·분', () => {
    assert.equal(parseFlexibleTime('오후 7시'), '19:00');
    assert.equal(parseFlexibleTime('19:30'), '19:30');
    assert.equal(parseFlexibleTime('저녁 7시 반'), '19:30');
    assert.equal(parseFlexibleTime('7시'), '7시'); // 오전/오후 추측하지 않음
    assert.equal(parseFlexibleTime(''), '');
});

test('시간: 날짜 숫자를 시간으로 오인하지 않음', () => {
    assert.equal(parseFlexibleTime(stripDatePart('10.8')), '');
    assert.equal(parseFlexibleTime(stripDatePart('10.8 오후 2시 30분')), '14:30');
});

test('보고서: 다음만남일 추출', () => {
    assert.equal(extractNextMeetingRaw(REPORT), '2026.11.3(화) 오후 7시');
    assert.equal(extractNextMeetingRaw('▪️ 다음 만남일:\n11월 5일'), '11월 5일');
    assert.equal(extractNextMeetingRaw('• 다음만남일: 미정'), '미정');
    assert.equal(extractNextMeetingRaw('진행내용만 있음'), null);
});

test('보고서: 필수 항목 확인', () => {
    assert.deepEqual(findMissingReportFields(REPORT), []);
    assert.deepEqual(
        findMissingReportFields('▶️ 진행내용: (내용 작성)\n▶️ 상담반응 및 특이사항:\n▪️ 다음만남일: 미정'),
        ['진행내용', '상담반응 및 특이사항']
    );
});

test('보고서: 텔레그램이 두 조각으로 나눈 보고서를 합치면 인식', () => {
    const long = '가'.repeat(3500);
    const part1 = `[만남 보고서]\n▶️ 진행내용: ${long}`;
    const part2 = `▶️ 상담반응 및 특이사항: 좋음\n▪️ 다음만남일: 미정`;
    assert.deepEqual(findMissingReportFields(part1), ['상담반응 및 특이사항']); // 조각만으로는 실패
    const merged = part1 + '\n' + part2; // bot.ts의 조각 합치기와 같은 방식
    assert.deepEqual(findMissingReportFields(merged), []);
    assert.equal(extractNextMeetingRaw(merged), '미정');
});

test('날짜 버튼: 이번 주는 오늘~일요일, 다음 주는 월~일', () => {
    const thu = weekDateOptions('2026-10-29'); // 목요일
    assert.deepEqual(thu.thisWeek, ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    assert.deepEqual(thu.nextWeek, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    const sun = weekDateOptions('2026-11-01'); // 일요일
    assert.deepEqual(sun.thisWeek, ['2026-11-01']);
    assert.equal(sun.nextWeek[0], '2026-11-02');
    const mon = weekDateOptions('2026-11-02'); // 월요일
    assert.equal(mon.thisWeek.length, 7);
    assert.equal(mon.nextWeek[0], '2026-11-09');
});
