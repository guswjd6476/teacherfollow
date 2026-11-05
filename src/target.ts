// 타겟 (합등·섭등·복등 타겟): 봇 서버와 분리한 순수 함수 (테스트용)
// - 타겟은 목표월별이다: 목표월이 11월이면 '11월 합등 타겟' (student_targets: student_id + kind + target_month)
// - 지금 단계(합·섭·복)와 지금 목표월에 맞는 타겟이 '현재 타겟'이다. 단계가 오르거나 목표월이 바뀌면 다시 묻는다
// - 목표월이 없거나 월이 아니면(장기 등) 타겟을 정하지 않는다

// 목표월 값 → 'n월' (없거나 월이 아니면 null)
export function targetMonthKey(raw: unknown): string | null {
    const m = String(raw ?? '').trim().match(/^(\d{1,2})\s*월?$/);
    const n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 12 ? `${n}월` : null;
}

// 목표월 정렬: 이번 달부터 앞으로 (이번 달 0, 다음 달 1 …)
export const monthOrder = (key: string | null, currentMonth: number) =>
    key ? (Number(key.replace('월', '')) - currentMonth + 12) % 12 : 99;

export const TARGET_KINDS = ['합등', '섭등', '복등'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

// 버튼 data에 쓰는 짧은 코드
export const TARGET_CODES: Record<TargetKind, string> = { 합등: 'hab', 섭등: 'seop', 복등: 'bok' };
export const kindOfCode = (code: string): TargetKind | null =>
    (Object.keys(TARGET_CODES) as TargetKind[]).find((k) => TARGET_CODES[k] === code) ?? null;

// 타겟 기준 (청년회 기준 문구)
export const TARGET_CRITERIA: Record<TargetKind, string> = {
    합등: '합당한 자 중 당월 개강을 바라보는 섭외자 + 육상담을 통해 말씀 따기 포인트가 파악된 자',
    섭등: '말씀따기되어 성경으로 최소 주2회 센터요일에 말씀교육 가능한 자',
    복등: '섭등조건 충족 및 유지 + 성경으로 3회 이상 복음방 진행된 자 (주2회 센터요일에 교육 진행)',
};

// 행정 단계(첫 글자) → 그 단계의 타겟. 합·섭·복이 아니면 null (발·찾·예정·탈락 등)
export function targetKindOfStage(stage: unknown): TargetKind | null {
    const s = String(stage ?? '').trim();
    if (s.includes('탈락')) return null;
    return ({ 합: '합등', 섭: '섭등', 복: '복등' } as Record<string, TargetKind>)[s.charAt(0)] ?? null;
}

const esc = (t?: string | null) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 상담방에 묻는 글 (HTML)
// reason: stage = 그 단계가 막 됨, meeting = 만남 보고서가 올라왔는데 아직 타겟이 아님, month = 목표월이 바뀜, manual = /타겟
export function targetAskText(o: {
    kind: TargetKind;
    name: string | null;
    targetMonth: string; // 'n월'
    reason: 'stage' | 'meeting' | 'month' | 'manual';
    previous?: boolean | null; // 전에 답한 값 (false = 아니라고 했음)
}): string {
    const who = o.name ? ` (👤 ${esc(o.name)})` : '';
    const head =
        o.reason === 'stage'
            ? `${o.kind.slice(0, 1)} 등록이 확인되었습니다.`
            : o.reason === 'meeting'
              ? `아직 <b>${esc(o.targetMonth)} ${o.kind} 타겟</b>으로 정하지 않은 대상자입니다.${o.previous === false ? ' (지난번: 아님)' : ''}`
              : o.reason === 'month'
                ? `목표월이 <b>${esc(o.targetMonth)}</b>로 바뀌었습니다.`
                : `지금 단계의 타겟 여부를 정해 주세요.`;
    return (
        `🎯 <b>[${esc(o.targetMonth)} ${o.kind} 타겟 확인]</b>${who}\n` +
        `${head}\n\n` +
        `<b>${o.kind} 타겟 기준</b>\n${TARGET_CRITERIA[o.kind]}\n\n` +
        `이 대상자를 <b>${esc(o.targetMonth)} ${o.kind} 타겟</b>으로 할까요?`
    );
}

export interface TargetPerson {
    student_id: number | string;
    name: string | null;
    stage: string | null;
    target_month: string | null;
    guide_region: string | null;
    guide_district: string | null;
    guide_name: string | null;
    teacher_region: string | null;
    teacher_district: string | null;
    teacher_name: string | null;
}

// 명단 한 줄: 행정/이름/인도자지역/인도자팀/인도자이름/교사지역/교사팀/교사이름[/덧붙임…] (HTML 이스케이프)
export function targetLine(p: TargetPerson, extras: (string | null | undefined)[] = []): string {
    const cells = [
        p.stage,
        p.name,
        p.guide_region,
        p.guide_district,
        p.guide_name,
        p.teacher_region,
        p.teacher_district,
        p.teacher_name,
    ].map((v) => esc(String(v ?? '').trim()));
    return [...cells, ...extras.filter((x): x is string => !!x).map(esc)].join('/');
}

// 지역(인도자 또는 교사 지역) 안의 현재 타겟 현황 글: 목표월마다 단계별 건수 + 명단 (maxLines 넘으면 '…외 n명')
// currentMonth: 이번 달 (목표월을 이번 달부터 앞으로 순서로)
export function targetSummaryText(
    title: string,
    people: (TargetPerson & { kind: TargetKind })[],
    currentMonth: number,
    maxLines = 40,
): string {
    const months = [...new Set(people.map((p) => p.target_month))].sort(
        (a, b) => monthOrder(a, currentMonth) - monthOrder(b, currentMonth),
    );
    const head = `🎯 <b>${esc(title)}</b> 현재 타겟 ${people.length}명`;
    if (!people.length) return `${head}\n• 없음`;
    let left = maxLines;
    const blocks = months.map((m) => {
        const mine = people
            .filter((p) => p.target_month === m)
            .sort((a, b) => TARGET_KINDS.indexOf(a.kind) - TARGET_KINDS.indexOf(b.kind) || String(a.name).localeCompare(String(b.name)));
        const counts = TARGET_KINDS.map((k) => `${k} ${mine.filter((p) => p.kind === k).length}`).join(' · ');
        const shown = mine.slice(0, Math.max(0, left));
        left -= shown.length;
        const lines = shown.map((p) => `• ${targetLine(p, [`${p.target_month} ${p.kind} 타겟`])}`);
        if (mine.length > shown.length) lines.push(`…외 ${mine.length - shown.length}명`);
        return `<b>[${esc(m)} 타겟 ${mine.length}명]</b> ${counts}\n${lines.join('\n')}`;
    });
    return `${head}\n${blocks.join('\n')}`;
}

// /타겟현황: 합·섭·복 진행 중 전원을 목표월마다 타겟·미정·아님으로 나눈 글 (목표월 없음은 끝, maxLines 넘으면 '…외 n명')
// answer: 지금 목표월·단계 타겟 답 (true 타겟, false 아님, null 미정). target_month가 null이면 목표월 없음
export function targetStatusText(
    title: string,
    people: (TargetPerson & { kind: TargetKind; answer: boolean | null })[],
    currentMonth: number,
    maxLines = 60,
): string {
    const head = `🎯 <b>${esc(title)}</b> 타겟 현황 (합·섭·복 ${people.length}명, 타겟 ${people.filter((p) => p.target_month && p.answer === true).length}명)`;
    if (!people.length) return `${head}\n• 없음`;
    const months = [...new Set(people.map((p) => p.target_month))].sort(
        (a, b) => monthOrder(a, currentMonth) - monthOrder(b, currentMonth),
    );
    const byKind = (a: { kind: TargetKind; name: string | null }, b: { kind: TargetKind; name: string | null }) =>
        TARGET_KINDS.indexOf(a.kind) - TARGET_KINDS.indexOf(b.kind) || String(a.name).localeCompare(String(b.name));
    let left = maxLines;
    const listOf = (rows: typeof people, extra: (p: (typeof people)[number]) => string) => {
        const shown = rows.slice(0, Math.max(0, left));
        left -= shown.length;
        const lines = shown.map((p) => `• ${targetLine(p, [extra(p)])}`);
        if (rows.length > shown.length) lines.push(`…외 ${rows.length - shown.length}명`);
        return lines;
    };
    const kinds = (rows: typeof people) => TARGET_KINDS.map((k) => `${k} ${rows.filter((p) => p.kind === k).length}`).join(' · ');
    const blocks = months.map((m) => {
        const mine = people.filter((p) => p.target_month === m).sort(byKind);
        if (!m) return [`<b>[목표월 없음 ${mine.length}명]</b> 목표월(n월)을 정해야 타겟을 정할 수 있음`, ...listOf(mine, () => '목표월 없음')].join('\n');
        const groups: [string, typeof mine][] = [
            ['✅ 타겟', mine.filter((p) => p.answer === true)],
            ['❔ 미정', mine.filter((p) => p.answer === null || p.answer === undefined)],
            ['➖ 아님', mine.filter((p) => p.answer === false)],
        ];
        const status = (p: (typeof mine)[number]) => (p.answer === true ? '타겟' : p.answer === false ? '아님' : '미정');
        return [
            `<b>[${esc(m)}] 타겟 ${groups[0][1].length} · 미정 ${groups[1][1].length} · 아님 ${groups[2][1].length}</b>`,
            ...groups
                .filter(([, rows]) => rows.length)
                .flatMap(([label, rows]) => [`${label} ${rows.length}명 (${kinds(rows)})`, ...listOf(rows, (p) => `${m} ${p.kind} ${status(p)}`)]),
        ].join('\n');
    });
    return `${head}\n${blocks.join('\n\n')}`;
}
