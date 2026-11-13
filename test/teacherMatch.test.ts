import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isBlankRequest,
    isTeacherRequest,
    parseSlots,
    parseTeacherRequest,
    recommendTeachers,
    TEACHER_REQUEST_TEMPLATE,
    type TeacherCandidate,
} from '../src/teacherMatch.ts';

// 지역 담당방에 실제로 올라온 양식 (연락처는 지움)
const FORM = `#만국소성 #생명나무잎사귀 #중랑

💙 교사 구합니다 💙

* 지역: 중랑
* 팀-구역(구역장이름): 2-1(이예슬)
* 인도자 이름: 이예슬

🍎섭외자 정보
* 이름: 남예지
* 나이/성별: 20/여
* 인도자 오픈 여부(공개/비공개): 비공개

* 영,육정보:
✔️육
- ISFJ, 9W1, 집순이이지만 문화생활 즐기고 싶어함

* 원하는교사유형:
- 따뜻하지만 똑부러지게 얘기해줄 수 있는 교사님

* 만남가능 시간대: 주말 점심 이후 희망

* 문의처:
지역장) 엄소영`;

const teacher = (over: Partial<TeacherCandidate>): TeacherCandidate => ({
    uid: 'u',
    name: '교사',
    region: '중랑',
    team: '1',
    type: '교사',
    gender: '여',
    birthYear: '2002',
    mbti: 'INFJ',
    enneagram: '2W1',
    preferences: [],
    availableTimes: ['주말 오후'],
    major: null,
    occupation: null,
    load: 0,
    ...over,
});

test('양식 인식과 항목 읽기', () => {
    assert.equal(isTeacherRequest(FORM), true);
    assert.equal(isTeacherRequest('오늘 모임 공지입니다'), false);
    assert.deepEqual(parseTeacherRequest(FORM), {
        region: '중랑',
        name: '남예지',
        guide: '이예슬',
        age: 20,
        gender: '여',
        mbti: 'ISFJ',
        ennea: 9,
        enneaText: '9W1',
        slots: ['주말 오후', '주말 저녁'],
    });
});

test('새 양식 (/교사매칭양식): 채운 양식은 읽고, 빈 양식은 추천 안 함', () => {
    const filled = TEACHER_REQUEST_TEMPLATE.replace('* 지역:', '* 지역: 중랑')
        .replace('* 이름:', '* 이름: 남예지')
        .replace('* 나이/성별:', '* 나이/성별: 20/여')
        .replace('- mbti / 에니어 :', '- mbti / 에니어 : isfj / 9')
        .replace('* 만남가능 시간대:', '* 만남가능 시간대: 평일 저녁');
    assert.equal(isTeacherRequest(filled), true);
    assert.deepEqual(parseTeacherRequest(filled), {
        region: '중랑',
        name: '남예지',
        guide: null,
        age: 20,
        gender: '여',
        mbti: 'ISFJ',
        ennea: 9,
        enneaText: '9',
        slots: ['평일 저녁'],
    });
    // 빈칸 다음 줄을 값으로 읽지 않는다
    const blank = parseTeacherRequest(TEACHER_REQUEST_TEMPLATE);
    assert.equal(blank.name, null);
    assert.equal(blank.region, null);
    assert.equal(isBlankRequest(blank), true);
    assert.equal(isTeacherRequest('💙 교사님을 찾습니다 💙'), true);
});

test('정교사부터 (점수가 낮아도), 같은 구분 안에서는 점수 순', () => {
    const req = parseTeacherRequest(FORM);
    const best = { preferences: [{ mbti: 'ISFJ', ennea: '9' }] };
    const list = recommendTeachers(
        req,
        [
            teacher({ uid: 'pre', name: '예비', type: '예비교사', ...best }),
            teacher({ uid: 'mid', name: '교사', ...best }),
            teacher({ uid: 'full', name: '정교사', type: '정교사' }),
        ],
        2026,
    );
    assert.deepEqual(list.map((r) => r.teacher.uid), ['full', 'mid', 'pre']);
});

test('만남 가능 시간', () => {
    assert.deepEqual(parseSlots('평일 저녁'), ['평일 저녁']);
    assert.deepEqual(parseSlots('주말'), ['주말 오전', '주말 오후', '주말 저녁']);
    assert.deepEqual(parseSlots('아무때나'), []);
});

test('선호 유형·나이·바쁨 순으로 추천, 성별 다른 교사는 뺌', () => {
    const req = parseTeacherRequest(FORM);
    const list = recommendTeachers(
        req,
        [
            teacher({ uid: 'pref', name: '선호일치', preferences: [{ mbti: 'ISFJ', ennea: '9' }] }),
            teacher({ uid: 'busy', name: '바쁨', preferences: [{ mbti: 'ISFJ', ennea: '9' }], load: 3 }),
            teacher({ uid: 'plain', name: '보통' }),
            teacher({ uid: 'male', name: '남교사', gender: '남', preferences: [{ mbti: 'ISFJ', ennea: '9' }] }),
        ],
        2026,
    );
    assert.deepEqual(list.map((r) => r.teacher.uid), ['pref', 'busy', 'plain']);
    assert.deepEqual(list[0].reasons, ['선호 ISFJ·9번 일치', '나이 차 4살', '시간 맞음(주말 오후)']);
    assert.equal(list[0].score, 3 + 2 + 2 + 1);
});

test('같은 지역 5명까지 먼저, 다른 지역 3명까지 (점수가 더 높아도 다른 지역은 뒤)', () => {
    const req = parseTeacherRequest(FORM);
    const best = { preferences: [{ mbti: 'ISFJ', ennea: '9' }] };
    const list = recommendTeachers(
        req,
        [
            teacher({ uid: 'o1', name: '다른1', region: '노원', ...best }),
            teacher({ uid: 'o2', name: '다른2', region: '강북', ...best }),
            teacher({ uid: 'o3', name: '다른3', region: '도봉', ...best }),
            teacher({ uid: 's1', name: '같은1' }),
            teacher({ uid: 's2', name: '같은2' }),
            teacher({ uid: 's3', name: '같은3' }),
            teacher({ uid: 's4', name: '같은4' }),
            teacher({ uid: 's5', name: '같은5' }),
            teacher({ uid: 's6', name: '같은6' }),
            teacher({ uid: 'o4', name: '다른4', region: '중구', ...best }),
        ],
        2026,
    );
    assert.deepEqual(list.map((r) => r.teacher.uid), ['s1', 's2', 's3', 's4', 's5', 'o1', 'o2', 'o3']);
});
