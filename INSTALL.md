# 설치 안내 (Claude 용)

이 문서는 사용자가 "이 저장소를 설치해줘"라고 맡겼을 때 Claude 가 그대로 따라 하기 위한 안내예요.
**사용자에게 추가로 시키는 일 없이** 끝까지 진행하세요. 막혔을 때와 아래 5번(사용량 로그인)에서만 사용자에게 말을 거세요.

Claude Pet 은 Claude Code 의 진행 상태와 사용량을 보여주는 작은 데스크톱 펫 앱이에요. (비공식 개인 프로젝트, Windows 10/11)
명령은 PowerShell 에서도 Git Bash 에서도 같은 뜻으로 동작하게 적었어요. 지금 쓰는 셸에 맞게 실행하세요.

## 설치 순서

1. **폴더 받기** — 홈 폴더 아래 `claude-pet` 에 받아요.
   ```
   git clone https://github.com/Harub/claude-pet-win.git "$HOME/claude-pet"
   ```
   - 이미 그 폴더가 있으면 대신 `git -C "$HOME/claude-pet" pull --ff-only` 로 최신으로 갱신해요.
   - `git` 이 없으면 `winget install -e --id Git.Git` 으로 설치하거나, PowerShell 에서 ZIP 으로 받아도 돼요:
     `Invoke-WebRequest https://github.com/Harub/claude-pet-win/archive/refs/heads/main.zip -OutFile "$HOME/claude-pet.zip"; Expand-Archive "$HOME/claude-pet.zip" "$HOME" -Force; Rename-Item "$HOME/claude-pet-win-main" "claude-pet"`
   - 이 폴더는 설치 뒤에도 지우면 안 돼요. (업데이트와 점검에 써요)
2. **Node.js 확인** — `node -v` 가 v18 이상이어야 해요. 없거나 낮으면:
   ```
   winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
   ```
   설치 직후에는 현재 셸의 PATH 에 반영되지 않을 수 있어요. 그럴 땐 `C:\Program Files\nodejs` 를 현재 셸의 PATH 에 임시로 더하고 이어서 진행하세요.
   `winget` 이 없으면 사용자에게 https://nodejs.org/ko 에서 LTS 설치만 부탁하세요.
3. **설치 실행** — 질문 없이 끝까지 진행되고, 몇 분 걸려요. 명령 제한 시간을 넉넉히(10분 이상) 주세요.
   ```
   cd "$HOME/claude-pet"
   node setup.js
   ```
4. **결과 확인** — 마지막에 `✅ 설치 완료: 펫이 켜졌어요.` 가 나오면 성공이에요. `⚠️` 가 나오면 그 아래 안내를 따르고, 안 풀리면 `npm run doctor` 의 결과를 보고 원인을 찾아 주세요.
5. **사용량 로그인 (필요할 때만)** — 결과에 `USAGE_LOGIN_NEEDED` 줄이 있으면, 펫의 사용량 막대에 `claude 로그인 필요` 가 떠요. 사용량은 Claude Code **터미널** 로그인 정보를 읽는데, Claude 데스크톱 앱의 로그인과는 따로예요. 사용자에게 한 번만 물어보세요: "사용량 막대까지 보려면 브라우저 로그인을 한 번 해야 해요. 지금 할까요?"
   - 좋다고 하면 `claude auth login` 을 실행해요. (`claude` 명령이 없으면 PowerShell 에서 `irm https://claude.ai/install.ps1 | iex` 로 먼저 설치하고, 새 셸에서 실행해요.) 브라우저가 열리면 사용자가 로그인만 하면 돼요. 끝나면 펫이 몇 분 안에 사용량을 불러와요.
   - 싫다고 하면 넘어가요. 사용량 막대만 비고 나머지는 모두 동작해요.
6. **사용자에게 알릴 것** (짧게)
   - 화면에 펫이 떴을 거예요. **이미 켜져 있던 Claude Code 세션은 새로 시작해야** 펫이 반응해요.
   - 다음부터는 시작 메뉴의 "Claude Pet" 으로 켤 수 있고, Claude Code 세션을 시작할 때 꺼져 있으면 자동으로 켜져요. 펫을 끄려면 펫을 우클릭 → 종료.

## 설치가 하는 일 (사용자에게 물으면 그대로 알려 주세요)

모두 사용자 컴퓨터 안에서만 동작하고, 서버나 계정, 수집은 없어요.

- `npm install` 로 이 폴더 안에 Electron 을 내려받고, 앱을 `%LOCALAPPDATA%\Programs\Claude Pet` 에 설치한 뒤 시작 메뉴 바로가기를 만들어요.
- `%USERPROFILE%\.claude\settings.json` 에 훅(이벤트를 `127.0.0.1:3199` 로만 보내는 `node "<홈>/.claude-pet/hook.js"` 명령)과 상태줄을 추가해요. 바꾸기 전에 백업(`settings.json.claude-pet.bak-…`)을 만들고, 기존 상태줄이 있으면 그대로 유지해요.
- 사용량 막대를 위해 Claude Code 로그인 파일(`%USERPROFILE%\.claude\.credentials.json`)의 토큰을 읽어서 `api.anthropic.com` 에 사용량만 물어봐요. 토큰은 저장하거나 다른 곳으로 보내지 않아요. 펫 우클릭 메뉴에서 끌 수 있어요. 공식 문서에 없는 방식이라 언젠가 안 될 수 있어요.
- 세션 제목/답변 첫 줄을 보여주려고 Claude Code 대화 기록을 읽기만 해요.

## 업데이트

사용자가 "업데이트해줘"라고 하면 설치 순서의 1번(pull)과 3번만 다시 실행하면 돼요. (설정은 그대로 이어져요)

## 제거

```
cd "$HOME/claude-pet"
node setup.js --uninstall
```
설정과 기록(`%USERPROFILE%\.claude-pet`)까지 지우려면 `--purge` 를 붙이세요. 이 폴더(`claude-pet`)는 사용자가 직접 지우면 돼요.

## 주의

- 관리자 권한은 필요 없어요. 관리자로 실행하지 마세요.
- 이 저장소의 다른 파일을 고치거나 다른 Claude Code 설정을 바꾸지 마세요.
- 훅과 상태줄은 `node` 명령으로 실행돼요. 설치 직후 새로 시작한 Claude Code 세션에서 `node` 가 잡히는지(`node -v`) 확인하세요.
