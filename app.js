/* 고객 한마디 분류기 — 화면.
 *
 * 흐름: 문장 → 가림(mask.js, 브라우저 안) → AI(api/classify) → 실패하면 규칙(rules.js)
 * 채점: 정답 100건을 규칙으로, 또는 AI로(BATCH 건씩 나눠) 돌려 맞힌 비율을 잰다.
 * 모델: 화면에서 고른다. «서버 기본값»이면 빈 문자열을 보내고 서버가 정한다.
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const S = { criteria: null, test: [], practice: [], aiResults: null, serverDefault: "" };

  // 채점 묶음 — 20건이면 느린 모델에서 서버의 60초를 넘긴다. 서버의 MAX_TEXTS(20) 이하로 둔다.
  const BATCH = 10;

  // 공식 가격표(https://aistudio.google.com/docs/pricing, 2026-11-06 확인)에서 Free tier 가 무료인
  // 글쓰기 모델 가운데 다섯. 음성·번역·임베딩·TTS 는 뺐다.
  // 순서는 «추정»이다 — 무료 한도(하루 요청 수)는 로그인해야 보이고 공식 표가 없다.
  //   Flash-Lite 의 한도가 더 넉넉하다는 비공식 글을 따라 앞에 두었을 뿐, 확인한 것이 아니다.
  const MODELS = [
    { id: "gemini-3.5-flash-lite", note: "" },
    { id: "gemini-3.1-flash-lite", note: "" },
    { id: "gemini-3.8-flash", note: "" },
    { id: "gemini-3.6-flash", note: "이전 세대" },
    { id: "gemini-3-flash-preview", note: "프리뷰" },
  ];
  const CUSTOM = "__custom__";
  const STORE = "classifier.model";
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;   // 서버와 같은 검사 — 여기서는 안내만 한다

  async function load() {
    const [c, t, p] = await Promise.all([
      fetch("criteria.json").then(r => r.json()),
      fetch("data/answer100.json").then(r => r.json()),
      fetch("data/practice200.json").then(r => r.json()),
    ]);
    S.criteria = c; S.test = t; S.practice = p;
    renderCriteria();
  }

  // ── AI 모델 ─────────────────────────────────────────
  // localStorage 는 시크릿 창 등에서 막힐 수 있다 — 막히면 기억만 못 하고 앱은 그대로 돈다
  function remember(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* 기억 못 함 */ }
  }
  function recall() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }

  function chosenModel() {
    const v = $("#model").value;
    return v === CUSTOM ? $("#model-custom").value.trim() : v;
  }

  function showModel() {
    const m = chosenModel();
    const now = $("#model-now");
    if (m) {
      now.textContent = `지금 호출: ${m}` + (MODEL_RE.test(m) ? "" : " — 이름 모양이 올바르지 않아 서버가 거절합니다");
    } else if ($("#model").value === CUSTOM) {
      now.textContent = "모델 이름을 입력하세요 — 비어 있으면 서버 기본값으로 호출합니다";
    } else {
      now.textContent = `지금 호출: 서버 기본값 (${S.serverDefault || "확인 못 함 — 서버 함수가 없거나 닿지 않음"})`;
    }
  }

  function setupModel() {
    const sel = $("#model");
    sel.innerHTML = [
      `<option value="">서버 기본값</option>`,
      ...MODELS.map(m => `<option value="${m.id}">${m.id}${m.note ? " · " + m.note : ""}</option>`),
      `<option value="${CUSTOM}">직접 입력…</option>`,
    ].join("");
    const saved = recall();
    sel.value = [...sel.options].some(o => o.value === saved.pick) ? saved.pick : "";
    $("#model-custom").value = saved.custom || "";
    const sync = () => {
      $("#model-custom").hidden = sel.value !== CUSTOM;
      remember({ pick: sel.value, custom: $("#model-custom").value.trim() });
      showModel();
    };
    sel.addEventListener("change", sync);
    $("#model-custom").addEventListener("input", sync);
    sync();
  }

  async function loadServerDefault() {
    try {
      const r = await fetch("api/classify");
      if (r.ok) S.serverDefault = (await r.json()).default || "";
    } catch (e) { /* 로컬에는 서버 함수가 없다 */ }
    showModel();
  }

  // ── 탭 ──────────────────────────────────────────────
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    ["try", "score", "rules"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
  }));

  // ── AI 호출 ─────────────────────────────────────────
  async function askAI(maskedTexts, model = chosenModel()) {
    try {
      const r = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: maskedTexts, criteria: S.criteria, model }),
      });
      if (!r.ok) return { results: null, reason: `서버 함수가 없습니다 (${r.status}) — 배포하면 생깁니다` };
      return await r.json();
    } catch (e) {
      return { results: null, reason: "서버 함수에 닿지 못했습니다" };
    }
  }

  function chips(el, res) {
    el.innerHTML = ["category", "sentiment", "urgency"]
      .map(k => `<span class="chip ${res[k]}">${res[k]}</span>`).join("");
  }

  // ── 분류해 보기 ─────────────────────────────────────
  $("#btn-sample").addEventListener("click", () => {
    const r = S.practice[Math.floor(Math.random() * S.practice.length)];
    $("#input").value = r.text;
  });

  $("#btn-classify").addEventListener("click", async () => {
    const text = $("#input").value.trim();
    if (!text) return;
    const btn = $("#btn-classify");
    btn.disabled = true; btn.textContent = "분류 중…";

    const m = Mask.mask(text);
    $("#sent").hidden = false;
    $("#sent-text").textContent = m.masked;
    $("#sent-found").innerHTML = m.found.length
      ? m.found.map(f => `<span class="tag">${f.type} 가림</span>`).join("")
      : `<span class="muted">가린 것 없음</span>`;

    const rule = Rules.classify(m.masked, S.criteria);
    const ai = await askAI([m.masked]);
    const got = ai.results && ai.results[0];

    $("#result").hidden = false;
    if (got) {
      $("#main-by").textContent = "AI · " + (ai.model || "");
      chips($("#main-chips"), got);
      $("#main-reason").textContent = got.reason || "";
      $("#note").hidden = true;
    } else {
      $("#main-by").textContent = "규칙";
      chips($("#main-chips"), rule);
      $("#main-reason").textContent = `분류: ${rule.why.category} · 감정: ${rule.why.sentiment} · 긴급도: ${rule.why.urgency}`;
      $("#note").hidden = false;
      $("#note").textContent = `AI 없이 규칙으로만 분류했습니다 — ${ai.reason || "AI 응답 없음"}`;
    }
    chips($("#rule-chips"), rule);
    $("#rule-reason").textContent = `분류: ${rule.why.category}`;
    $("#card-rule").hidden = !got;

    btn.disabled = false; btn.textContent = "분류하기";
  });

  // ── 채점 ───────────────────────────────────────────
  function pct(x) { return x.toFixed(x % 1 ? 1 : 0) + "%"; }

  function showScore(who, s) {
    $("#score-table").hidden = false;
    for (const k of ["category", "sentiment", "urgency"]) {
      document.querySelector(`[data-k="${who}-${k}"]`).textContent = pct(s.accuracy[k]);
    }
    document.querySelector(`[data-k="${who}-all"]`).textContent = `${s.n - s.wrong.length} / ${s.n}`;
    $("#wrong").hidden = false;
    $("#wrong-who").textContent = (who === "ai" ? "— AI" : "— 규칙") + " · 정답 → 판정";
    $("#wrong-list").innerHTML = s.wrong.slice(0, 15).map(w => {
      const diff = ["category", "sentiment", "urgency"].filter(k => w.got[k] !== w.want[k])
        .map(k => `${w.want[k]}→${w.got[k]}`).join(" · ");
      return `<li><span class="t">${w.text}</span><br><span class="d">${diff}${w.note ? " · " + w.note : ""}</span></li>`;
    }).join("") + (s.wrong.length > 15 ? `<li class="d">… 외 ${s.wrong.length - 15}건</li>` : "");
  }

  $("#btn-score-rule").addEventListener("click", () => {
    const s = Rules.score(S.test, r => Rules.classify(Mask.mask(r.text).masked, S.criteria));
    showScore("rule", s);
    $("#score-msg").hidden = true;
  });

  $("#btn-score-ai").addEventListener("click", async () => {
    const btn = $("#btn-score-ai");
    btn.disabled = true;
    const masked = S.test.map(r => Mask.mask(r.text).masked);
    const model = chosenModel();   // 채점 도중 드롭다운을 바꿔도 한 모델로만 잰다
    let used = "";
    const results = [];
    for (let i = 0; i < masked.length; i += BATCH) {
      const part = masked.slice(i, i + BATCH);
      btn.textContent = `AI 채점 중… ${i}/${masked.length}`;
      let r = await askAI(part, model);
      if (!r.results && r.timeout) {   // 느려서 끊긴 묶음만 한 번 더
        btn.textContent = `다시 시도… ${i}/${masked.length}`;
        r = await askAI(part, model);
      }
      if (!r.results) {
        $("#score-msg").hidden = false;
        $("#score-msg").textContent = `AI로 채점하지 못했습니다 — ${r.reason}`;
        btn.disabled = false; btn.textContent = "AI로 채점";
        return;
      }
      used = r.model || used;
      results.push(...r.results);
    }
    // 답을 못 받은 문장은 «오답»으로 센다 — 빠진 것을 빼고 세면 점수가 부풀려진다
    const miss = { category: "-", sentiment: "-", urgency: "-" };
    S.aiResults = results;
    const s = Rules.score(S.test, (r, i) => results[i] || miss);
    showScore("ai", s);
    $("#ai-col").textContent = used ? `AI · ${used}` : "AI";
    const blank = results.filter(x => !x).length;
    $("#score-msg").hidden = !blank;
    if (blank) $("#score-msg").textContent = `AI가 답하지 않은 문장 ${blank}건은 오답으로 셌습니다.`;
    $("#btn-download").hidden = false;
    btn.disabled = false; btn.textContent = "AI로 채점";
  });

  $("#btn-download").addEventListener("click", () => {
    const rows = S.test.map((r, i) => ({ id: r.id, text: r.text, 정답: r, AI: S.aiResults[i] }));
    const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ai_채점결과.json"; a.click();
  });

  // ── 기준 ───────────────────────────────────────────
  function renderCriteria() {
    const c = S.criteria;
    $("#owner").textContent = c.owner;
    $("#crit-cats").innerHTML = c.categories
      .map(x => `<tr><td>${x.name}</td><td>${x.definition}</td></tr>`).join("");
    $("#crit-priority").textContent = c.priority.join(" → ") + " 순서로 먼저 봅니다.";
    $("#crit-priority-reason").textContent = c.priority_reason;
    $("#crit-sent").textContent = c.sentiment.guide;
    $("#crit-urg").textContent = c.urgency.guide;
  }

  setupModel();
  loadServerDefault();
  load();
})();
