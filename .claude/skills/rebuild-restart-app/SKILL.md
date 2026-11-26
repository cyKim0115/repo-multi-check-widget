---
name: rebuild-restart-app
description: >-
  Stops the running Repo Multi-Check Widget process, force-rebuilds the Tauri
  release, reinstalls to LOCALAPPDATA, and restarts. Use when implementation
  work is done and the user wants the installed app refreshed, or when they
  mention rebuild-restart / 빌드 최신화 / 재시작 / 작업 완료 후 실행.
---

# Repo Multi-Check Widget — rebuild & restart

구현 작업이 끝난 뒤 **설치본을 최신 코드로 갱신**할 때 사용한다.

## 한 줄 실행

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/rebuild-restart.ps1
```

프로젝트 루트에서 실행한다. `시작.bat`과 동일한 `launch-user.ps1` 경로이며 `-ForceRebuild`로 **항상** release 빌드한다.

## 절차 (스크립트가 수행)

1. `repo-multi-check-widget` 프로세스 종료 (`Stop-RunningWidget`, 이름 바꾸기 전 `git-multi-check-widget`도 함께)
2. `npm run build:app` (VS Build Tools `vcvars64.bat` 경유, 필요 시 `npm install`)
3. `src-tauri/target/release/repo-multi-check-widget.exe` → `%LOCALAPPDATA%\RepoMultiCheckWidget\`
4. 설치 exe 실행

## 성공 확인

- `Get-Process -Name repo-multi-check-widget` — 프로세스 1개 이상
- Release exe `LastWriteTime`이 방금 빌드 시각 근처
- 스크립트 exit code `0`

실패 시: Node/Rust/VS C++ Build Tools 메시지를 사용자에게 전달. `npm run build:app` 단독 재시도 안내.

## 에이전트 규칙

- 사용자가 **작업 완료 + 빌드/재시작**을 요청하면 이 스킬을 읽고 **직접 스크립트를 실행**한다 (안내만 하지 않음).
- 빌드는 수 분 걸릴 수 있음 — `block_until_ms`를 충분히 둔다.
- 성공 후 사용자가 RAG 캡처를 요청했거나 작업 맥락상 교훈이 있으면 `capture-to-rag`를 이어서 수행한다.

## 관련 파일

- `scripts/rebuild-restart.ps1` — 강제 재빌드 래퍼
- `scripts/launch-user.ps1` — 빌드·설치·시작 본체 (`-ForceRebuild` 지원)
- `시작.bat` — 일반 사용자용 (소스가 exe보다 최신일 때만 빌드)
