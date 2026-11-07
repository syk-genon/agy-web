# 🚀 Antigravity (agy) Web Console

웹 브라우저에서 ChatGPT 형태로 `agy`를 사용할 수 있는 경량 웹 콘솔입니다.
외부 npm 패키지 설치 없이 Node.js 내장 모듈만으로 동작하며, **Firebase Studio (구 Project IDX)** 설정 파일(`.idx/dev.nix`)이 포함되어 있어 클라우드에 올리면 자동으로 웹 프리뷰 화면이 열립니다.

---

## 주요 기능
- **실시간 스트리밍 대화**: 답변 텍스트, 생각 과정(`thoughts`), 도구 호출(`tool_calls`) 실시간 표시
- **모델 선택 (Model Selector)**: Gemini 4 Argon, Gemini 3.8 Flash, Claude Sonnet 5.5 등 드롭다운으로 즉시 변경
- **모드 전환 (Mode Selector)**: Auto, Plan, Accept-Edits 모드 지원
- **이전 대화 이어하기 (`/resume`)**: 과거 대화 세션 목록을 열어 원하는 시점부터 이어서 대화
- **슬래시 명령어**: `/resume`, `/reset`, `/clear`, `/help`

---

## ☁️ Firebase Studio (Project IDX) 배포 가이드

1. **GitHub에 저장소 생성 및 푸시**
   ```bash
   cd D:\workspace\agy-web
   git init
   git add .
   git commit -m "Initial commit of agy-web"
   git branch -M main
   git remote add origin https://github.com/<본인아이디>/<저장소이름>.git
   git push -u origin main
   ```

2. **Firebase Studio에서 불러오기**
   - [Firebase Studio (idx.google.com)](https://idx.google.com) 또는 [studio.firebase.google.com](https://studio.firebase.google.com) 접속
   - 구글 계정으로 로그인 후 **"Import a repo"** 클릭
   - GitHub 저장소 주소 붙여넣기 후 워크스페이스 생성

3. **자동 실행 및 외부 접속**
   - 워크스페이스가 열리면 `.idx/dev.nix`가 자동으로 Node.js 환경을 세팅하고 웹 서버를 실행합니다.
   - 우측 Web Preview 창 상단의 **"새 탭에서 열기(Open in New Tab)"** 또는 공유 URL을 복사하면 PC/스마트폰/태블릿 브라우저 어디서나 외부 접속이 가능합니다.
