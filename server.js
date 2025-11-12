// 1. 필요한 라이브러리(부품) 가져오기
const express = require('express');
const cors = require('cors');
require('dotenv').config(); // .env 파일의 비밀번호를 불러옴
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 2. 서버 설정
const app = express();
const port = 3000; // 우리 서버는 3000번 문으로 통신
app.use(cors()); // CROS 에러 방지 (doctor.html과 통신 허용)
app.use(express.json()); // JSON 요청을 받을 수 있게 설정

// 3. Gemini AI 초기화 (API 키는 .env 파일에서 안전하게 불러옴)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * [수정] 10개 문항에 맞게 척도형 답변을 텍스트로 변환
 */
const mapScaleResponse = (qName, value) => {
    const scale3 = { '0': '전혀(0)', '1': '며칠(1)', '2': '절반(2)', '3': '매일(3)' };
    const scale5 = { '0': '전혀 영향 없음', '1': '조금 영향 있음', '2': '보통', '3': '많이 영향 있음', '4': '매우 심각함' };
    const scaleSafety = { '0': '아니오, 전혀 없습니다.', '1': '네, 며칠 정도', '2': '네, 자주' };

    if (!value) return '(무응답)';
    if (qName.startsWith('q3')) return scale3[value] || value;
    if (qName === 'q7_impact') return scale5[value] || value; // [수정] ID 변경 (q5 -> q7)
    if (qName === 'q8_safety') return scaleSafety[value] || value; // [수정] ID 변경 (q6 -> q8)
    return value;
}

/**
 * [수정] 10개 문항에 맞게 AI 요약을 위해 문진표 데이터를 텍스트 프롬프트로 변환
 */
const formatDataForPrompt = (qData) => {
    if (!qData) return "환자 데이터가 없습니다.";
    
    // 척도형 질문을 텍스트로 변환
    const q3a = mapScaleResponse('q3', qData.q3_symptoms_a);
    const q3b = mapScaleResponse('q3', qData.q3_symptoms_b);
    const q3c = mapScaleResponse('q3', qData.q3_symptoms_c);
    const q3d = mapScaleResponse('q3', qData.q3_symptoms_d);
    const q7 = mapScaleResponse('q7_impact', qData.q7_impact);
    const q8 = mapScaleResponse('q8_safety', qData.q8_safety);
    const emotions = qData.q2_emotions.length > 0 ? qData.q2_emotions.join(', ') : '특정 감정 선택 안함';

    // [수정] Q1부터 Q10까지 모든 항목 반영
    return `
다음은 정신과 환자의 사전 문진표 응답 내용입니다:

- Q1 (주 호소): ${qData.q1_main_complaint}
- Q2 (주요 감정): ${emotions}
- Q3 (주요 증상):
    - 수면 문제: ${q3a}
    - 식욕 문제: ${q3b}
    - 피로감: ${q3c}
    - 집중력 저하: ${q3d}
- Q4 (악화/완화 상황): ${qData.q4_context}
- Q5 (반복적 사고): ${qData.q5_cognition}
- Q6 (행동 변화): ${qData.q6_behavior}
- Q7 (일상 기능 저하): ${q7}
- Q8 (안전 문제-자해/자살 사고): ${q8}
- Q9 (환자 생각 원인): ${qData.q9_cause}
- Q10 (진료 시 목표): ${qData.q10_goals}
`;
};

// [신규] AI가 반환할 JSON 객체의 형태를 정의
const responseSchema = {
    type: "OBJECT",
    properties: {
        "summary": { "type": "STRING" },
        "sentiment": { "type": "STRING" },
        "keywords": {
            "type": "ARRAY",
            "items": { "type": "STRING" }
        }
    },
    required: ["summary", "sentiment", "keywords"]
};

// 4. "AI 요약" API 엔드포인트 수정
app.post('/summarize', async (req, res) => {
    try {
        const questionnaireData = req.body.questionnaireData;

        // 1. AI에게 보낼 프롬프트(명령어) 생성
        const userPrompt = formatDataForPrompt(questionnaireData);
        
        // [수정] 시스템 프롬프트를 JSON 반환에 맞게 수정
        const systemPrompt = `당신은 정신과 의사를 보조하는 전문 의료 AI입니다. 환자의 문진표를 분석하여 의사가 진료 전에 핵심을 파악할 수 있도록 JSON 형식으로 응답합니다.
- summary: 환자의 주 호소(Q1, Q4, Q5)와 일상 기능(Q7), 목표(Q10)를 중심으로 한 문단 요약.
- sentiment: 환자의 Q2(주요 감정)와 Q1(주 호소)을 분석하여 가장 지배적인 단일 감정(예: '우울', '불안', '무기력', '분노', '복합적')을 추출.
- keywords: 문진표 전체(특히 Q1, Q5, Q6)에서 의사가 주목해야 할 핵심 증상 키워드를 3~5개 배열로 추출 (예: "불면증", "대인기피", "자살 사고").
- [매우 중요] Q8(안전 문제)이 '아니오, 전혀 없습니다.'가 아닐 경우, '자살 사고' 또는 '자해'를 keywords 배열에 *반드시* 포함해야 합니다.`;

        // 2. Gemini AI 모델 실행
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            systemInstruction: systemPrompt,
            // [신규] JSON 모드 설정
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
            },
        });
        
        const result = await model.generateContent(userPrompt);
        const response = await result.response;
        const aiResponseText = response.text();

        // 3. AI가 보낸 텍스트(JSON)를 객체로 파싱
        const aiJson = JSON.parse(aiResponseText);

        // 4. 요약 결과를 doctor.html에게 전송 (이제 JSON 객체를 보냄)
        res.json(aiJson); // { summary: "...", sentiment: "...", keywords: [...] }

    } catch (error) {
        console.error("Error generating summary:", error);
        res.status(500).json({ error: "AI 요약 생성에 실패했습니다." });
    }
});

// 5. 서버 실행
app.listen(port, () => {
    console.log(`AI 요약 서버가 http://localhost:${port} 에서 실행 중입니다.`);
});