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
