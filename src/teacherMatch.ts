// 교사 추천: 지역 담당방의 '교사 구합니다' 양식을 읽고, 교사 프로필(teacher_profiles)과 비교해 점수를 매긴다
// 봇 서버와 분리해 테스트할 수 있도록 따로 둠 (DB 조회는 bot.ts)

export interface TeacherRequest {
    region: string | null;
    name: string | null;
    age: number | null;
    gender: '남' | '여' | null;
    mbti: string | null; // 'ISFJ'
    ennea: number | null; // 주 유형 (9W1 → 9)
    enneaText: string | null; // '9W1'
    slots: string[]; // 만남 가능 시간 ('주말 오후' 등, 교사 프로필 available_times와 같은 값)
}

export interface TeacherCandidate {
    uid: string;
    name: string;
    region: string | null;
    team: string | null;
    gender: string | null;
    birthYear: string | null;
    mbti: string | null;
    enneagram: string | null;
    preferences: { mbti?: string; ennea?: string; reason?: string }[] | null;
    availableTimes: string[] | null;
    major: string | null;
    occupation: string | null;
    load: number; // 지금 맡은 학생 (합~예정)
}

// 웹 '배정 가능한 교사'와 같은 기준: 지금 맡은 학생이 이만큼이면 바쁨
export const BUSY_LOAD = 3;

export const isTeacherRequest = (text: string) =>
    /교사\s*(?:를\s*)?구합니다/.test(text) || (/섭외자\s*정보/.test(text) && /원하는\s*교사/.test(text));

// 양식의 '* 항목: 값' 줄에서 값 (줄 앞 기호·공백은 무시)
const field = (text: string, label: string) =>
    text.match(new RegExp(`^[\\s*•▪️\\-]*${label}\\s*[:：]\\s*(.*)$`, 'm'))?.[1].trim() || null;

const DAYS = ['평일', '주말'];
const TIMES = ['오전', '오후', '저녁'];
const TIME_WORDS: [RegExp, string][] = [
    [/오전|아침/, '오전'],
    [/점심|오후|낮/, '오후'],
    [/저녁|밤/, '저녁'],
];

// '주말 점심 이후 희망' → ['주말 오후', '주말 저녁']. 평일·주말을 안 적으면 둘 다, 시간을 안 적으면 하루 종일
export function parseSlots(raw: string | null): string[] {
    if (!raw) return [];
    const days = DAYS.filter((d) => raw.includes(d) || (d === '주말' && /토|일요일/.test(raw)));
    let times = TIME_WORDS.filter(([re]) => re.test(raw)).map(([, t]) => t);
    // '점심 이후' = 그 시간과 그 뒤
    if (times.length && /이후|부터/.test(raw)) times = TIMES.slice(TIMES.indexOf(times[0]));
    if (!days.length && !times.length) return [];
    return (days.length ? days : DAYS).flatMap((d) => (times.length ? times : TIMES).map((t) => `${d} ${t}`));
}

export function parseTeacherRequest(rawText: string): TeacherRequest {
    const text = rawText.normalize('NFKC');
    const ageGender = field(text, '나이\\s*/\\s*성별');
    const enneaMatch = text.match(/(?<!\d)([1-9])\s*[wW]\s*([1-9])(?!\d)/);
    const enneaOnly = text.match(/[에애]니어\S*\s*[:：]?\s*([1-9])(?!\d)/);
    return {
        region: field(text, '지역'),
        name: field(text, '이름'),
        age: Number(ageGender?.match(/\d{1,2}/)?.[0]) || Number(field(text, '나이')?.match(/\d{1,2}/)?.[0]) || null,
        gender: ((ageGender ?? field(text, '성별'))?.match(/남|여/)?.[0] as '남' | '여' | undefined) ?? null,
        mbti: text.match(/(?<![A-Za-z])([EI][NS][FT][JP])(?![A-Za-z])/i)?.[1].toUpperCase() ?? null,
        ennea: Number(enneaMatch?.[1] ?? enneaOnly?.[1]) || null,
        enneaText: enneaMatch ? `${enneaMatch[1]}W${enneaMatch[2]}` : (enneaOnly?.[1] ?? null),
        slots: parseSlots(field(text, '만남\\s*가능\\s*시간대?')),
    };
}

const sameLetters = (a: string, b: string) => [...a].filter((ch, i) => ch === b[i]).length;

export function ageOf(birthYear: string | null, thisYear: number): number | null {
    const y = Number(String(birthYear ?? '').trim());
    return Number.isInteger(y) && y > 1900 && y <= thisYear ? thisYear - y : null;
}

// 점수와 이유. 탈락 교사·성별이 다른 교사는 bot.ts 조회에서 뺀다
export function scoreTeacher(req: TeacherRequest, t: TeacherCandidate, thisYear: number) {
    let score = 0;
    const reasons: string[] = [];

    // 1. 교사가 선호하는 학생 MBTI·에니어그램 (선호를 여러 개 적었으면 가장 잘 맞는 것)
    let best = { pts: 0, text: '' };
    for (const p of t.preferences ?? []) {
        const pm = String(p.mbti ?? '').trim().toUpperCase();
        const pe = Number(String(p.ennea ?? '').match(/[1-9]/)?.[0]) || null;
        let pts = 0;
        const hit: string[] = [];
        if (req.mbti && /^[EI][NS][FT][JP]$/.test(pm)) {
            if (pm === req.mbti) (pts += 3), hit.push(pm);
            else if (sameLetters(pm, req.mbti) === 3) (pts += 1), hit.push(`${pm}(3글자)`);
        }
        if (req.ennea && pe === req.ennea) (pts += 2), hit.push(`${pe}번`);
        if (pts > best.pts) best = { pts, text: `선호 ${hit.join('·')} 일치` };
    }
    if (best.pts) (score += best.pts), reasons.push(best.text);

    // 2. 나이: 교사가 0~5살 많으면 +2, 6~10살 +1, 학생보다 어리면 -1
    const age = ageOf(t.birthYear, thisYear);
    if (age !== null && req.age !== null) {
        const diff = age - req.age;
        score += diff < 0 ? -1 : diff <= 5 ? 2 : diff <= 10 ? 1 : 0;
        reasons.push(diff < 0 ? `교사가 ${-diff}살 어림` : diff === 0 ? '동갑' : `나이 차 ${diff}살`);
    }

    // 3. 만남 가능 시간이 겹치는지
    if (req.slots.length && t.availableTimes?.length) {
        const both = t.availableTimes.filter((s) => req.slots.includes(s));
        score += both.length ? 1 : -1;
        reasons.push(both.length ? `시간 맞음(${both.join(', ')})` : '시간 안 맞음');
    }

    // 4. 바쁜 교사는 뒤로
    if (t.load >= BUSY_LOAD) (score -= 2), reasons.push(`관리 ${t.load}건(바쁨)`);

    return { score, reasons, age };
}

// 같은 지역 교사로 먼저 최대 sameMax명, 나머지 자리는 다른 지역 교사로 (각각 점수 순)
export function recommendTeachers(req: TeacherRequest, teachers: TeacherCandidate[], thisYear: number, limit = 5, sameMax = 3) {
    const ranked = teachers
        .filter((t) => !req.gender || !t.gender || t.gender === req.gender)
        .map((t) => ({ teacher: t, sameRegion: !!req.region && t.region === req.region, ...scoreTeacher(req, t, thisYear) }))
        .sort((a, b) => b.score - a.score || a.teacher.load - b.teacher.load || a.teacher.name.localeCompare(b.teacher.name, 'ko'));
    const same = ranked.filter((r) => r.sameRegion).slice(0, sameMax);
    return [...same, ...ranked.filter((r) => !r.sameRegion).slice(0, limit - same.length)];
}
