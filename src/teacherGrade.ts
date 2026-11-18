// 교사 기준표 (상·중·하) 평가: 항목과 등급 규칙 (DB 코드 없음)
// 상 = 상 항목 4개 이상 + ①②③ 필수, 중 = 중 항목 3개 이상 + ①② 필수, 둘 다 아니면 하

export type Grade = '상' | '중' | '하';

export const GRADE_ITEMS = [
    { code: 'a1', level: '상', no: '①', short: '개인복 센등 2회', text: '최근 6개월 이내, 개인복음방으로 센터 등록 2회' },
    { code: 'a2', level: '상', no: '②', short: '필수 공과 4개+', text: '필수 공과 4개(또는 6개) 이상 기본 숙지 및 스피치 가능' },
    { code: 'a3', level: '상', no: '③', short: '관계 우위·신뢰', text: "관계 우위 선점 및 신뢰 형성 (섭외자가 '선생님'으로 인정하고 고민 상담 요청)" },
    { code: 'a4', level: '상', no: '④', short: '육상담→영턴', text: '육상담이 가능하며, 육상담 후 자연스럽고 확실하게 영턴 가능' },
    { code: 'a5', level: '상', no: '⑤', short: '성경 활용', text: '성경을 펴서 진행 또는 성경 어플 활용 가능' },
    { code: 'a6', level: '상', no: '⑥', short: '센터 기간 정돈', text: '말씀으로 센터 기간 확실하게 정돈 및 따기 가능' },
    { code: 'a7', level: '상', no: '⑦', short: '3개월 복 3건', text: '최근 3개월 이내 복음방 3건 이상 진행' },
    { code: 'b1', level: '중', no: '①', short: '필수 공과 2개+', text: '필수 공과 2개 이상 기본 숙지 및 스피치 가능' },
    { code: 'b2', level: '중', no: '②', short: '영상담 가능', text: "'영혼육' 공과 또는 맞춤형 대화를 통한 영상담 진행 가능" },
    { code: 'b3', level: '중', no: '③', short: '육상담 도구', text: '육상담 도구(성향분석/심리/타로/코칭 등) 1개 이상 마스터 및 현장 활용' },
    { code: 'b4', level: '중', no: '④', short: '그룹복 센등 1회', text: '그룹 복음방으로 센터 등록 1회 이상 (개인복 2회 이하 후 그룹복을 거친 경우 포함)' },
    { code: 'b5', level: '중', no: '⑤', short: '6개월 복 1건', text: '최근 6개월 이내 복음방 1건 이상 진행' },
] as const;
export type ItemCode = (typeof GRADE_ITEMS)[number]['code'];
export const ITEM_CODES: readonly string[] = GRADE_ITEMS.map((i) => i.code);

const RULES = [
    { grade: '상' as const, prefix: 'a', need: 4, required: ['a1', 'a2', 'a3'] },
    { grade: '중' as const, prefix: 'b', need: 3, required: ['b1', 'b2'] },
];

const label = (code: string) => {
    const i = GRADE_ITEMS.find((x) => x.code === code)!;
    return `${i.level}${i.no} ${i.short}`;
};

// 등급과, 한 단계 위로 가려면 무엇이 더 필요한지
export function gradeOf(checked: readonly string[]): { grade: Grade; next: string | null } {
    const has = new Set(checked);
    const lack = (r: (typeof RULES)[number]) => {
        const missing = r.required.filter((c) => !has.has(c));
        const count = ITEM_CODES.filter((c) => c.startsWith(r.prefix) && has.has(c)).length;
        // 필수 항목을 채운 뒤에도 모자라는 개수
        return { missing, more: Math.max(0, r.need - count - missing.length) };
    };
    for (const [i, r] of RULES.entries()) {
        const { missing, more } = lack(r);
        if (missing.length === 0 && more === 0) {
            const up = RULES[i - 1];
            return { grade: r.grade, next: up ? needText(up.grade, lack(up)) : null };
        }
    }
    return { grade: '하', next: needText('중', lack(RULES[1])) };
}

function needText(grade: Grade, { missing, more }: { missing: string[]; more: number }) {
    const parts = [...missing.map(label), ...(more > 0 ? [`그 밖에 ${more}개 더`] : [])];
    return `${grade}까지: ${parts.join(', ')}`;
}

// 다음에 평가할 교사: 목록 순서에서 afterId 다음부터 (끝까지 가면 처음으로), 완료 안 한 교사
// 같은 방의 다른 사람이 방금(10분 안) 연 평가지는 건너뛴다 (둘이 같은 교사를 잡지 않게)
export interface NextCandidate {
    id: number;
    done_at: Date | null;
    updated_by: string | null;
    updated_at: Date | null;
}
export const EVAL_BUSY_MS = 10 * 60_000;
export function pickNextTeacher<T extends NextCandidate>(list: T[], afterId: number, me: string, now: number): T | null {
    const busy = (t: T) => !!t.updated_by && t.updated_by !== me && !!t.updated_at && now - new Date(t.updated_at).getTime() < EVAL_BUSY_MS;
    const at = list.findIndex((t) => t.id === afterId);
    const ordered = at < 0 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
    return ordered.find((t) => !t.done_at && !busy(t)) ?? null;
}

// 명단용 '선택' 칸: 그 등급 항목 중 필수가 아닌 것에서 체크한 번호 (상은 ④~⑦, 중·하는 중 ③~⑤). 예: '3,4'
export function extraItemNumbers(grade: string | null, items: readonly string[] | null): string {
    const rule = grade === '상' ? RULES[0] : RULES[1];
    return (items ?? [])
        .filter((c) => c.startsWith(rule.prefix) && !rule.required.includes(c))
        .map((c) => Number(c.slice(1)))
        .sort((a, b) => a - b)
        .join(',');
}
