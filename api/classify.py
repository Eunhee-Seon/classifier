# -*- coding: utf-8 -*-
"""Gemini 분류 — Vercel 서버 함수.

이 앱에서 서버가 필요한 유일한 자리다. **키를 숨기기 위해서** 존재한다.
키를 app.js 에 적으면 브라우저 개발자 도구에서 그대로 보인다.

  받는 것   {"texts": ["가려진 문장", ...최대 20개], "criteria": {...criteria.json...}, "model": "모델 이름 또는 빈 문자열"}
  주는 것   {"results": [{"category", "sentiment", "urgency", "reason"}, ...], "model": "실제로 쓴 모델"}
            키가 없거나 실패하면 {"results": null, "reason": "..."} — 200 으로 돌려준다.
            AI가 60초 안에 답하지 않으면 {"results": null, "timeout": true, "reason": "..."}.
            **앱은 AI 없이도 규칙으로 계속 돈다.**
  GET       {"default": "기본 모델 이름"} — 화면에 «서버 기본값»이 무엇인지 보여 주려고. 키는 돌려주지 않는다.

모델은 요청의 "model" → 환경 변수 GEMINI_MODEL → 코드의 기본값 순서로 정한다.
모델 이름은 호출 주소에 그대로 들어가므로, 어디서 왔든 MODEL_RE 를 통과해야만 쓴다.

문장은 브라우저에서 **이미 가려진 채로** 온다(mask.js). 여기서 다시 가리지 않는다 —
서버에 도착했다는 것은 이미 내 컴퓨터를 떠났다는 뜻이다.

기준(criteria)은 사람이 정한 것을 그대로 받아 프롬프트에 넣는다. 이 함수는 기준을 만들지 않는다.
외부 라이브러리를 쓰지 않는다 (requirements.txt 가 필요 없다).
"""
import json
import os
import re
import socket
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

# 모델 이름과 무료 한도는 자주 바뀐다 — 00_지침/도구_무료확인.md 를 본다.
#   2.5 계열은 예전 사용자에게만 열려 있다(2026-09). Vercel 환경 변수 GEMINI_MODEL 로 바꿀 수 있다.
#   화면에서 고른 모델이 있으면 그것이 먼저다.
FALLBACK_MODEL = "gemini-3.8-flash"
# 영문·숫자로 시작하고 영문·숫자·. _ - 만, 64자까지. fullmatch 로 쓴다 — $ 는 끝의 줄바꿈 하나를 통과시킨다.
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]{0,63}")
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT = 60
MAX_TEXTS = 20
MAX_LEN = 400
# 파이썬 3.10 부터 socket.timeout 은 TimeoutError 와 같다. 그 아래 판에서도 잡히게 둘 다 적는다.
TIMEOUTS = (TimeoutError, socket.timeout)

CATS = ["요금", "품질", "서비스", "앱기능", "해지관련", "기타"]
SENTS = ["긍정", "중립", "부정"]
URGS = ["높음", "보통", "낮음"]


def default_model():
    return os.environ.get("GEMINI_MODEL", "").strip() or FALLBACK_MODEL


def build_prompt(texts, crit):
    cats = "\n".join(f"  - {c['name']}: {c['definition']}" for c in crit.get("categories", []))
    lines = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    return f"""너는 통신사 고객 문의를 분류하는 담당자다. 아래 기준을 **그대로** 따른다. 기준에 없는 판단을 더하지 않는다.

[분류 — 하나만 고른다]
{cats}
  여러 분류에 걸치면 이 순서로 먼저 고른다: {' > '.join(crit.get('priority', CATS))}
  이유: {crit.get('priority_reason', '')}

[감정 — 긍정 · 중립 · 부정]
  {crit.get('sentiment', {}).get('guide', '')}

[긴급도 — 높음 · 보통 · 낮음]
  {crit.get('urgency', {}).get('guide', '')}

[] 안의 말(예: [전화번호])은 가려진 개인정보다. 추측하지 않는다.

각 문장마다 아래 모양의 JSON 배열 하나로만 답한다. 설명을 덧붙이지 않는다.
[{{"i": 0, "category": "...", "sentiment": "...", "urgency": "...", "reason": "왜 그렇게 골랐는지 한 문장"}}]

[문장]
{lines}
"""


def call_gemini(key, model, prompt):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT.format(model=model), data=body, method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def clean(items, n):
    """AI가 돌려준 것을 기준 안의 값으로만 받는다. 기준 밖의 값은 버린다."""
    out = [None] * n
    for it in items if isinstance(items, list) else []:
        try:
            i = int(it.get("i"))
        except (TypeError, ValueError, AttributeError):
            continue
        if not 0 <= i < n:
            continue
        c, s, u = it.get("category"), it.get("sentiment"), it.get("urgency")
        if c in CATS and s in SENTS and u in URGS:
            out[i] = {"category": c, "sentiment": s, "urgency": u,
                      "reason": str(it.get("reason", ""))[:200], "by": "AI"}
    return out


class handler(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        return self._send({"default": default_model()})

    def do_POST(self):
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            return self._send({"results": None, "reason": "키가 없습니다 — Vercel 환경 변수 GEMINI_API_KEY"})
        model = default_model()
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(n, 60000)).decode("utf-8"))
            texts = [str(t)[:MAX_LEN] for t in req.get("texts", [])][:MAX_TEXTS]
            crit = req.get("criteria") or {}
            model = str(req.get("model") or "").strip() or default_model()
            if not MODEL_RE.fullmatch(model):
                return self._send({"results": None,
                                   "reason": "모델 이름이 올바르지 않습니다 — 영문·숫자·. _ - 만, 64자까지"})
            if not texts:
                return self._send({"results": None, "reason": "보낸 문장이 없습니다"})
            items = call_gemini(key, model, build_prompt(texts, crit))
            return self._send({"results": clean(items, len(texts)), "model": model})
        except urllib.error.HTTPError as e:
            return self._send({"results": None, "reason": f"AI 호출 실패 ({e.code}, {model}) — 모델 이름·한도를 확인"})
        except TIMEOUTS:                # 읽는 중에 끊김
            return self._send(self._timeout(model))
        except urllib.error.URLError as e:
            if isinstance(e.reason, TIMEOUTS):       # 연결하는 중에 끊김
                return self._send(self._timeout(model))
            return self._send({"results": None, "reason": f"AI 호출 실패 ({model}) — URLError"})
        except Exception as e:  # noqa: BLE001
            return self._send({"results": None, "reason": f"AI 호출 실패 ({model}) — {type(e).__name__}"})

    @staticmethod
    def _timeout(model):
        return {"results": None, "timeout": True,
                "reason": f"AI가 {TIMEOUT}초 안에 답하지 않았습니다 — 모델({model})이 느리거나 혼잡합니다"}
