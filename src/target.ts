// 타겟 (합등·섭등·복등 타겟): 봇 서버와 분리한 순수 함수 (테스트용)
// - 학생마다 단계별로 '이 단계 타겟이 맞는지'를 따로 둔다 (student_targets: student_id + kind)
// - 지금 단계(합·섭·복)에 맞는 타겟이 '현재 타겟'이다. 단계가 오르면 다음 타겟을 다시 묻는다

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
// reason: stage = 그 단계가 막 됨, meeting = 만남 보고서가 올라왔는데 아직 타겟이 아님, manual = /타겟
export function targetAskText(o: {
    kind: TargetKind;
    name: string | null;
    targetMonth: string | null;
    reason: 'stage' | 'meeting' | 'manual';
    previous?: boolean | null; // 전에 답한 값 (false = 아니라고 했음)
}): string {
    const who = o.name ? ` (👤 ${esc(o.name)})` : '';
    const head =
        o.reason === 'stage'
            ? `${o.kind.slice(0, 1)} 등록이 확인되었습니다.`
            : o.reason === 'meeting'
              ? `아직 <b>${o.kind} 타겟</b>으로 정하지 않은 대상자입니다.${o.previous === false ? ' (지난번: 아님)' : ''}`
              : `지금 단계의 타겟 여부를 정해 주세요.`;
    return (
        `🎯 <b>[${o.kind} 타겟 확인]</b>${who}\n` +
        `${head}\n\n` +
        `<b>${o.kind} 타겟 기준</b>\n${TARGET_CRITERIA[o.kind]}\n\n` +
        `목표월 <b>${esc(o.targetMonth) || '미설정'}</b> · 이 대상자를 <b>${o.kind} 타겟</b>으로 할까요?`
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

// 지역(인도자 또는 교사 지역) 안의 현재 타겟 현황 글: 단계별 건수 + 명단 (maxLines 넘으면 '…외 n명')
export function targetSummaryText(
    title: string,
    people: (TargetPerson & { kind: TargetKind })[],
    maxLines = 40,
): string {
    const counts = TARGET_KINDS.map((k) => `${k} ${people.filter((p) => p.kind === k).length}`).join(' · ');
    const sorted = [...people].sort(
        (a, b) => TARGET_KINDS.indexOf(a.kind) - TARGET_KINDS.indexOf(b.kind) || String(a.name).localeCompare(String(b.name)),
    );
    const lines = sorted.slice(0, maxLines).map((p) => `• ${targetLine(p, [`${p.kind} 타겟`, p.target_month])}`);
    if (sorted.length > maxLines) lines.push(`…외 ${sorted.length - maxLines}명`);
    return `🎯 <b>${esc(title)}</b> 현재 타겟 ${people.length}명 (${counts})\n` + (lines.length ? lines.join('\n') : '• 없음');
}
