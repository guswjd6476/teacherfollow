import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignKey, campaignsInChakCheck, chakAskText, nextMonthOf } from '../src/chakCheck.ts';

const nov = { year: 2026, month: 11, weekCount: 8, week1Start: '2026-10-05' };

test('5주차부터 개강 끝까지만', () => {
    assert.equal(campaignsInChakCheck([nov], '2026-11-01').length, 0); // 4주차 마지막 날
    const [c] = campaignsInChakCheck([nov], '2026-11-02');
    assert.equal(c.week, 5);
    assert.equal(c.week5Start, '2026-11-02');
    assert.equal(campaignsInChakCheck([nov], '2026-11-29').length, 1); // 8주차 마지막 날
    assert.equal(campaignsInChakCheck([nov], '2026-11-30').length, 0); // 개강 끝
});

test('다음 달·키·묻는 글', () => {
    assert.equal(nextMonthOf(11), 12);
    assert.equal(nextMonthOf(12), 1);
    assert.equal(campaignKey(2026, 1), '202601');
    const t = chakAskText({ name: '<홍>', month: 11, week5Start: '2026-11-02' });
    assert.match(t, /11월 개강 5주차 찾기 확인/);
    assert.match(t, /5주차\(11\/2~\)/);
    assert.match(t, /목표월을 <b>12월<\/b>로/);
    assert.match(t, /&lt;홍&gt;/);
});
