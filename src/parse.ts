import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

// 보고서·날짜 인식 함수 (봇 서버와 분리해 테스트할 수 있도록 따로 둠)

// 입력 문자열에서 날짜를 찾아 'YYYY-MM-DD'로 변환 (실패 시 null)
// 지원: 10.8(월), 10/8, 10-08, 10월 8일, 2026.10.8, 26.10.8, 오늘/내일/모레
export function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    // 전각 숫자·기호(１０．８ 등) → 반각
    const text = rawText.normalize('NFKC');
    const today = dayjs().tz('Asia/Seoul').startOf('day');

    const toYmd = (year: number, month: number, day: number): string | null => {
        const str = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return dayjs(str, 'YYYY-MM-DD', true).isValid() ? str : null; // 2/30 같은 없는 날짜는 거부
    };

    // 연도 포함: 2026.10.8 / 2026년 10월 8일 / 26.10.8 (두 자리 연도는 13 이상일 때만 연도로 인정 → 10.8 14시 오인 방지)
    const withYear = text.match(/(?:^|[^\d])(\d{4}|\d{2})\s*[\-\/\.년]\s*(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (withYear && (withYear[1].length === 4 || parseInt(withYear[1], 10) > 12)) {
        const year = withYear[1].length === 4 ? parseInt(withYear[1], 10) : 2000 + parseInt(withYear[1], 10);
        const ymd = toYmd(year, parseInt(withYear[2], 10), parseInt(withYear[3], 10));
        if (ymd) return ymd;
    }

    // 월·일만: 10.8 / 10/8 / 10-08 / 10월 8일 (뒤의 시간·요일은 무시)
    const monthDay = text.match(/(?:^|[^\d])(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (monthDay) {
        const month = parseInt(monthDay[1], 10);
        const day = parseInt(monthDay[2], 10);
        // 연도 생략 시 오늘 기준 ±6개월 안에 들어오는 해로 결정 (12월에 1월 입력 → 내년, 1월에 12월 입력 → 작년)
        for (const year of [today.year(), today.year() + 1, today.year() - 1]) {
            const ymd = toYmd(year, month, day);
            if (!ymd) continue;
            const diff = dayjs(ymd).diff(dayjs(today.format('YYYY-MM-DD')), 'day');
            if (diff >= -183 && diff <= 183) return ymd;
        }
        return toYmd(today.year(), month, day);
    }

    const relative = text.match(/오늘|내일|모레/);
    if (relative) {
        const offset = { 오늘: 0, 내일: 1, 모레: 2 }[relative[0] as '오늘' | '내일' | '모레'];
        return today.add(offset, 'day').format('YYYY-MM-DD');
    }

    return null;
}

// 입력한 요일이 실제 날짜의 요일과 다르면 안내 문구 반환 (예: 10.8(월) 인데 10/8이 목요일)
export function getWeekdayWarning(rawText: string, ymd: string): string {
    const text = rawText.normalize('NFKC');
    const m = text.match(/\(\s*([월화수목금토일])(?:요일)?\s*\)|([월화수목금토일])요일/);
    if (!m) return '';
    const written = m[1] || m[2];
    const actual = '일월화수목금토'[dayjs(ymd).day()];
    return written === actual
        ? ''
        : `\n\n⚠️ 입력한 요일(${written})과 실제 요일이 다릅니다: <b>${ymd} (${actual})</b>\n날짜가 틀렸다면 다시 입력해주세요.`;
}

// 지난 날짜면 안내 문구 반환
export function getPastDateWarning(ymd: string): string {
    const todayStr = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    return ymd < todayStr ? `\n\n⚠️ <b>이미 지난 날짜</b>입니다 (${ymd}). 잘못 입력했다면 다시 입력해주세요.` : '';
}

// 입력에서 시간 추출 (예: 19:00, 19시, 오후 7시, 7시 반, 오후 2시 30분) — 표시용 문자열 반환, 없으면 ''
// 오전/오후 표기가 없고 12시 미만이면 입력 그대로 'N시'로 둔다 (오전/오후 추측하지 않음)
export function parseFlexibleTime(rawText: string): string {
    if (!rawText) return '';
    const text = rawText.normalize('NFKC');
    const m =
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*:\s*(\d{2})(?!\d)/) ||
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(?:(\d{1,2})\s*분|(반))?/);
    if (!m) return '';
    let hour = parseInt(m[2], 10);
    const minute = m[4] === '반' ? 30 : m[3] ? parseInt(m[3], 10) : 0;
    if (hour > 24 || minute > 59) return '';
    const period = m[1];
    if (period && ['오후', '저녁', '밤'].includes(period) && hour < 12) hour += 12;
    if (period === '낮' && hour <= 6) hour += 12;
    if (period && ['오전', '아침', '새벽'].includes(period) && hour === 12) hour = 0;
    if (!period && hour < 12) return minute ? `${hour}시 ${minute}분` : `${hour}시`;
    return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 시간 추출 전에 날짜 부분(10.8 / 2026.10.8 / 10월 8일)을 제거 — '10.8'의 8을 시간으로 오인하지 않도록
export function stripDatePart(rawText: string): string {
    return rawText
        .normalize('NFKC')
        .replace(/(?:(?:\d{4}|1[3-9]|[2-9]\d)\s*[\-\/\.년]\s*)?\d{1,2}\s*[\-\/\.월]\s*\d{1,2}\s*일?/, ' ');
}

// 보고서 항목 내용 추출: 라벨 줄의 나머지 + 다음 항목 전까지의 줄, 라벨이 없으면 null
// 줄 머리의 기호/번호 (예: '▶️', '▪️', '•', '2.')
const REPORT_LINE_PREFIX = String.raw`^\s*[•\-*▪◾■□○●▶►✔✅☑️\d.)]*\s*`;
// '• 항목: 값' 형태의 줄 (머리 기호가 있어야 항목으로 간주 — 본문의 '공과 제목 : ...' 같은 줄은 내용)
const REPORT_FIELD_LINE = /^\s*[•▪◾■□○●▶►✔✅☑️]+\s*[가-힣A-Za-z][가-힣A-Za-z0-9 ()\/·,\-]{0,20}\s*[:：]/u;
const REPORT_KNOWN_LABEL = new RegExp(
    REPORT_LINE_PREFIX +
        String.raw`(?:진행\s*내용|진행\s*내역|상담\s*반응|교육\s*후\s*반응|특이\s*사항|섭외자\s*느낀\s*점|입막음|다음\s*만남)`,
    'u'
);
// 양식의 섹션 머리 기호 (▶️ 진행내용, ▪️만남일시, 🖤 해결해야 할 것 등)
const REPORT_SECTION_HEAD = /^\s*(?:▶|►|▪|◾|■|🖤|🏷)/u;

export function extractReportField(text: string, label: RegExp): string | null {
    const lines = text.split(/\r?\n/);
    const anchored = new RegExp(REPORT_LINE_PREFIX + label.source, 'u');
    const start = lines.findIndex((l) => anchored.test(l));
    if (start < 0) return null;

    const m = lines[start].match(anchored)!;
    const first = lines[start].slice(m[0].length).replace(/^\s*[:：\-]?\s*/, '');
    const body = [first];
    for (
        let i = start + 1;
        i < lines.length &&
        !REPORT_FIELD_LINE.test(lines[i]) &&
        !REPORT_KNOWN_LABEL.test(lines[i]) &&
        !REPORT_SECTION_HEAD.test(lines[i]);
        i++
    ) {
        body.push(lines[i]);
    }
    return body.join('\n').trim();
}

// 괄호 안내문구·번호(1. 2.)·기호만 있으면 빈칸으로 간주
export function isBlankReportField(value: string | null): boolean {
    if (value === null) return true;
    const stripped = value
        .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
        .replace(/^\s*\d+\s*[.)]/gm, '')
        .replace(/[\s\-_.·~:：xX]/g, '');
    return stripped.length === 0;
}

// 보고서의 '다음만남일' 값 추출
// 1순위: 줄 맨 앞(기호·이모지 뒤)에 있는 라벨 줄 — 본문 속 "다음 만남 때 ~" 같은 문장 오인 방지
//        라벨 뒤가 비어 있으면 바로 아래 줄에 적은 날짜/미정을 사용
// 2순위: 기존 방식 (문장 어디든 첫 번째 '다음 만남 …')
export function extractNextMeetingRaw(text: string): string | null {
    const lines = text.split(/\r?\n/);
    const labelRe = /^[^가-힣\d]*다음\s*(?:만남\s*(?:일시|일자|예정일|일)?|일정)\s*[:：\-]?\s*(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(labelRe);
        if (!m) continue;
        const rest = m[1].trim();
        if (rest) return rest;
        const next = lines.slice(i + 1).find((l) => l.trim() !== '');
        if (next && (parseFlexibleDate(next) || next.includes('미정'))) return next.trim();
        return null;
    }
    const match = text.match(/다음[ \t]*(?:만남일시|만남[ \t]*일시|만남일|만남[ \t]*일|만남|일정)[ \t]*[:：\-]?[ \t]*([^\n\r]+)/i);
    return match && match[1] ? match[1].trim() : null;
}

// 만남 보고서에서 비어 있는 필수 항목 이름 목록 (진행내용 / 상담반응 및 특이사항)
// 양식마다 제목이 달라 후보 라벨 중 하나라도 작성되어 있으면 인정
export function findMissingReportFields(text: string): string[] {
    return [
        { name: '진행내용', labels: [/진행\s*내용/] },
        {
            name: '상담반응 및 특이사항',
            labels: [/상담\s*반응(?:\s*및\s*특이\s*사항)?/, /교육\s*후\s*반응/, /특이\s*사항/],
        },
    ]
        .filter((f) => f.labels.every((label) => isBlankReportField(extractReportField(text, label))))
        .map((f) => f.name);
}

// 다음 만남일 버튼에 쓸 날짜: 이번 주(오늘~일요일), 다음 주(월~일) — 한 주는 월요일 시작
export function weekDateOptions(todayYmd: string): { thisWeek: string[]; nextWeek: string[] } {
    const today = dayjs(todayYmd);
    const daysToSunday = (7 - today.day()) % 7; // 오늘이 일요일이면 0
    const days = (start: dayjs.Dayjs, n: number) =>
        Array.from({ length: n }, (_, i) => start.add(i, 'day').format('YYYY-MM-DD'));
    return { thisWeek: days(today, daysToSunday + 1), nextWeek: days(today.add(daysToSunday + 1, 'day'), 7) };
}
