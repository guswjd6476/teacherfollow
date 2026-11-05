// 개강 5주차 찾기 확인: 봇 서버와 분리한 순수 함수 (테스트용)
// - 개강이 5주차가 되면 목표월이 그 개강 월인데 아직 찾인 학생의 상담방에 잔존/탈락을 묻는다
// - 잔존 = 목표월을 다음 달로, 탈락 = 오늘 날짜로 행정 탈락 (단계 '탈락', 탈락일 = 지금)

export const CHAK_CHECK_WEEK = 5; // 몇 주차부터 묻는지

export interface CampaignSetting {
    year: number;
    month: number;
    weekCount: number;
    week1Start: string; // 'YYYY-MM-DD'
}

// 오늘(YYYY-MM-DD)이 5주차 이후이고 아직 개강 기간인 개강 (week5Start = 5주차 시작일)
export function campaignsInChakCheck(settings: CampaignSetting[], today: string) {
    const day = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
    return settings
        .map((c) => {
            const weekIdx = Math.floor((day(today) - day(c.week1Start)) / 7);
            const week5 = day(c.week1Start) + (CHAK_CHECK_WEEK - 1) * 7;
            return {
                ...c,
                week: weekIdx + 1,
                week5Start: new Date(week5 * 86_400_000).toISOString().slice(0, 10),
                active: weekIdx >= CHAK_CHECK_WEEK - 1 && weekIdx < c.weekCount,
            };
        })
        .filter((c) => c.active)
        .map(({ active: _a, ...c }) => c);
}

export const nextMonthOf = (month: number) => (month % 12) + 1;
// 버튼 data용 개강 키 (예: 2026년 11월 → '202611')
export const campaignKey = (year: number, month: number) => `${year}${String(month).padStart(2, '0')}`;

const esc = (t?: string | null) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export function chakAskText(o: { name: string | null; month: number; week5Start: string }): string {
    const who = o.name ? ` (👤 ${esc(o.name)})` : '';
    return (
        `🗂 <b>[${o.month}월 개강 5주차 찾기 확인]</b>${who}\n` +
        `${o.month}월 개강이 5주차(${md(o.week5Start)}~)가 되었는데 아직 <b>찾</b> 단계입니다.\n\n` +
        `• <b>잔존</b>: 목표월을 <b>${nextMonthOf(o.month)}월</b>로 바꿉니다.\n` +
        `• <b>탈락</b>: 오늘 날짜로 <b>행정 탈락</b> 처리합니다.\n\n` +
        `잔존할까요, 탈락할까요?`
    );
}
