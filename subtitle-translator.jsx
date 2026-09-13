import React, { useState, useRef, useEffect } from "react";
import {
  Upload,
  X,
  Download,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Ban,
} from "lucide-react";

const LANGUAGES = [
  { code: "auto", label: "Tự động nhận diện" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "en", label: "Tiếng Anh" },
  { code: "ja", label: "Tiếng Nhật" },
  { code: "ko", label: "Tiếng Hàn" },
  { code: "zh-Hans", label: "Tiếng Trung (giản thể)" },
  { code: "zh-Hant", label: "Tiếng Trung (phồn thể)" },
  { code: "fr", label: "Tiếng Pháp" },
  { code: "de", label: "Tiếng Đức" },
  { code: "es", label: "Tiếng Tây Ban Nha" },
  { code: "pt", label: "Tiếng Bồ Đào Nha" },
  { code: "ru", label: "Tiếng Nga" },
  { code: "th", label: "Tiếng Thái" },
  { code: "id", label: "Tiếng Indonesia" },
  { code: "ar", label: "Tiếng Ả Rập" },
  { code: "it", label: "Tiếng Ý" },
];
const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== "auto");
const BATCH_SIZE = 8;
const MAX_CONCURRENT_FILES = 3;

const PROVIDERS = [
  { code: "claude", label: "Claude (tích hợp sẵn, không cần API key)" },
  { code: "gemini", label: "Gemini (cần API key riêng)" },
];
const GEMINI_MODELS = [
  { code: "gemini-3.8-flash", label: "Gemini 3.8 Flash (mới nhất)" },
  { code: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
];

function langLabel(code) {
  return LANGUAGES.find((l) => l.code === code)?.label || code;
}

function parseSRT(content) {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const blocks = normalized.split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;
    let timeLineIdx = -1;
    if (/-->/.test(lines[0])) timeLineIdx = 0;
    else if (/^\d+$/.test(lines[0].trim()) && lines[1] && /-->/.test(lines[1]))
      timeLineIdx = 1;
    if (timeLineIdx === -1) continue;
    const m = lines[timeLineIdx].match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!m) continue;
    const textLines = lines.slice(timeLineIdx + 1);
    const text = textLines.join("\n").trim();
    if (!text) continue;
    cues.push({ start: m[1], end: m[2], text });
  }
  return cues;
}

function serializeSRT(cues, bilingual) {
  return (
    cues
      .map((c, i) => {
        const translated = c.translated !== undefined ? c.translated : c.text;
        const body =
          bilingual && c.translated !== undefined
            ? `${translated}\n${c.text}`
            : translated;
        return `${i + 1}\n${c.start} --> ${c.end}\n${body}`;
      })
      .join("\n\n") + "\n"
  );
}

function buildTranslationPrompt(texts, prevContext, sourceLangLabel, targetLangLabel, note) {
  const numbered = texts
    .map((t, i) => `${i + 1}. ${t.replace(/\n/g, " / ")}`)
    .join("\n");
  const contextPart = prevContext
    ? `Mạch câu ngay trước (chỉ để tham khảo văn phong, không dịch lại):\n"${prevContext}"\n\n`
    : "";
  const notePart = note ? `Bối cảnh nội dung: ${note}\n\n` : "";
  return `Bạn là biên dịch phụ đề chuyên nghiệp. Dịch các dòng phụ đề sau từ ${sourceLangLabel} sang ${targetLangLabel}.
Yêu cầu: dịch tự nhiên theo đúng ngữ cảnh (không dịch máy móc từng từ), giữ giọng điệu và cách xưng hô nhất quán giữa các dòng, câu văn ngắn gọn dễ đọc trên màn hình.

${notePart}${contextPart}Dịch chính xác ${texts.length} dòng sau, đúng thứ tự. Chỉ trả về một mảng JSON gồm ${texts.length} chuỗi (không markdown, không giải thích thêm, không đánh số lại):
${numbered}`;
}

function parseTranslationJson(textBlock) {
  const cleaned = textBlock.replace(/```json|```/g, "").trim();
  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) arr = JSON.parse(match[0]);
    else throw new Error("Không đọc được kết quả dịch trả về");
  }
  if (!Array.isArray(arr)) throw new Error("Kết quả dịch không hợp lệ");
  return arr;
}

async function translateBatchClaude(texts, prevContext, sourceLangLabel, targetLangLabel, note) {
  const prompt = buildTranslationPrompt(texts, prevContext, sourceLangLabel, targetLangLabel, note);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Lỗi kết nối API Claude (mã ${res.status})`);
  const data = await res.json();
  const textBlock = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseTranslationJson(textBlock);
}

async function translateBatchGemini(texts, prevContext, sourceLangLabel, targetLangLabel, note, apiKey, model) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Thiếu Gemini API key. Nhập API key ở phần cài đặt phía trên.");
  }
  const prompt = buildTranslationPrompt(texts, prevContext, sourceLangLabel, targetLangLabel, note);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    }
  );
  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = errBody?.error?.message ? `: ${errBody.error.message}` : "";
    } catch {
      // ignore body parse failure
    }
    throw new Error(`Lỗi kết nối API Gemini (mã ${res.status})${detail}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textBlock = parts.map((p) => p.text || "").join("");
  return parseTranslationJson(textBlock);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

.st-app {
  --bg: #121316;
  --surface: #1b1d21;
  --surface-2: #202329;
  --border: #2b2e34;
  --text: #ece9e2;
  --text-dim: #8b909a;
  --accent: #f2c14e;
  --accent-dim: #b89638;
  --ok: #7fbf8f;
  --err: #e0665c;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  border-radius: 12px;
  padding: 28px;
  max-width: 880px;
  margin: 0 auto;
}
.st-app * { box-sizing: border-box; }
.st-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 24px; }
.st-mark { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; flex-shrink: 0; }
.st-mark-line { display: block; height: 4px; border-radius: 2px; background: var(--accent); }
.st-mark-line--long { width: 26px; }
.st-mark-line--short { width: 15px; opacity: 0.55; }
.st-header h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
.st-tagline { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; max-width: 46ch; }

.st-controls {
  display: flex; flex-wrap: wrap; gap: 14px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; margin-bottom: 14px;
}
.st-field { display: flex; flex-direction: column; gap: 6px; min-width: 150px; }
.st-field--grow { flex: 1 1 220px; }
.st-field label { font-size: 12px; color: var(--text-dim); }
.st-field select, .st-field input[type="text"], .st-field input[type="password"] {
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
  border-radius: 6px; padding: 8px 10px; font-family: inherit; font-size: 13.5px;
}
.st-field select:focus-visible, .st-field input:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
.st-field-hint { font-size: 11px; color: var(--text-dim); }
.st-field-hint a { color: var(--accent-dim); }
.st-provider-row { display: flex; flex-wrap: wrap; gap: 14px; width: 100%; }
.st-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-dim); align-self: flex-end; padding-bottom: 8px; cursor: pointer; }
.st-checkbox input { accent-color: var(--accent); width: 15px; height: 15px; }
.st-note { font-size: 11.5px; color: var(--text-dim); margin: -4px 0 14px 2px; }

.st-dropzone {
  border: 1.5px dashed var(--border); border-radius: 8px; padding: 26px 16px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  color: var(--text-dim); font-size: 13.5px; cursor: pointer; text-align: center;
  transition: border-color .15s ease, background .15s ease;
  margin-bottom: 18px;
}
.st-dropzone:hover, .st-dropzone--active {
  border-color: var(--accent); background: rgba(242, 193, 78, 0.06); color: var(--text);
}
.st-dropzone svg { color: var(--accent); }

.st-list { display: flex; flex-direction: column; gap: 10px; }
.st-row {
  border: 1px solid var(--border); background: var(--surface);
  border-radius: 8px; padding: 12px 14px;
  display: grid; grid-template-columns: minmax(140px, 1.4fr) minmax(140px, 1.6fr) auto auto;
  align-items: center; gap: 14px; position: relative;
}
.st-row-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.st-row-icon { color: var(--accent-dim); flex-shrink: 0; }
.st-row-info { min-width: 0; }
.st-row-name { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-row-meta { font-size: 11.5px; color: var(--text-dim); margin-top: 2px; }

.st-row-progress { display: flex; align-items: center; gap: 10px; min-width: 0; }
.st-track {
  flex: 1; height: 8px; border-radius: 4px; background:
    repeating-linear-gradient(90deg, var(--surface-2) 0 6px, #26292f 6px 7px);
  overflow: hidden; position: relative;
}
.st-track-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width .3s ease; }
.st-count { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--text-dim); white-space: nowrap; }

.st-row-status { display: flex; align-items: center; justify-content: center; width: 20px; }
.st-spin { animation: st-spin 0.8s linear infinite; color: var(--accent); }
@keyframes st-spin { to { transform: rotate(360deg); } }
.st-ok { color: var(--ok); }
.st-err { color: var(--err); }
.st-muted { color: var(--text-dim); }
.st-muted-text { font-size: 11px; color: var(--text-dim); }

.st-row-actions { display: flex; align-items: center; gap: 6px; }
.st-btn {
  display: inline-flex; align-items: center; gap: 5px; font-family: inherit;
  font-size: 12px; border-radius: 6px; padding: 6px 10px; border: 1px solid var(--border);
  background: var(--surface-2); color: var(--text); cursor: pointer; white-space: nowrap;
}
.st-btn:hover { border-color: var(--accent-dim); }
.st-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.st-btn--accent { background: var(--accent); border-color: var(--accent); color: #1a1a1a; font-weight: 600; }
.st-btn--accent:hover { background: #f6cd6d; }
.st-btn--icon { padding: 6px; }
.st-row-error {
  grid-column: 1 / -1; font-size: 12px; color: var(--err);
  border-top: 1px solid var(--border); margin-top: 6px; padding-top: 8px;
}
.st-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }

@media (max-width: 640px) {
  .st-row { grid-template-columns: 1fr; align-items: stretch; }
  .st-row-status { justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .st-spin { animation: none; }
  .st-track-fill { transition: none; }
}
`;

export default function SubtitleTranslator() {
  const [files, setFiles] = useState([]);
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("vi");
  const [bilingual, setBilingual] = useState(false);
  const [contextNote, setContextNote] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [provider, setProvider] = useState("claude");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState(GEMINI_MODELS[0].code);

  const cancelFlags = useRef({});
  const activeCountRef = useRef(0);
  const queueRef = useRef([]);
  const filesRef = useRef([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  function tryStartNext() {
    while (activeCountRef.current < MAX_CONCURRENT_FILES && queueRef.current.length > 0) {
      const id = queueRef.current.shift();
      translateFile(id);
    }
  }

  async function translateFile(fileId) {
    activeCountRef.current += 1;
    const fileObj = filesRef.current.find((f) => f.id === fileId);
    if (!fileObj) {
      activeCountRef.current -= 1;
      return;
    }
    cancelFlags.current[fileId] = false;
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status: "running", error: null } : f))
    );

    const cues = fileObj.cues;
    const {
      sourceLang: sLang,
      targetLang: tLang,
      contextNote: note,
      provider: prov,
      geminiApiKey: gKey,
      geminiModel: gModel,
    } = fileObj.settings;
    const sourceLangLabel =
      sLang === "auto" ? "ngôn ngữ gốc của phụ đề (tự nhận diện)" : langLabel(sLang);
    const targetLangLabel = langLabel(tLang);

    let doneCount = cues.filter((c) => c.translated !== undefined).length;
    let prevContext = "";

    try {
      for (let i = 0; i < cues.length; i += BATCH_SIZE) {
        if (cancelFlags.current[fileId]) {
          setFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, status: "cancelled" } : f))
          );
          activeCountRef.current -= 1;
          tryStartNext();
          return;
        }
        const slice = cues.slice(i, i + BATCH_SIZE);
        if (slice.every((c) => c.translated !== undefined)) continue;

        const texts = slice.map((c) => c.text);
        const translations =
          prov === "gemini"
            ? await translateBatchGemini(
                texts,
                prevContext,
                sourceLangLabel,
                targetLangLabel,
                note,
                gKey,
                gModel
              )
            : await translateBatchClaude(texts, prevContext, sourceLangLabel, targetLangLabel, note);
        translations.forEach((t, j) => {
          if (slice[j]) slice[j].translated = (t ?? slice[j].text).toString();
        });
        doneCount = cues.filter((c) => c.translated !== undefined).length;
        prevContext = slice
          .slice(-2)
          .map((c) => c.translated)
          .join(" ");
        setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, doneCount } : f)));
      }
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: "done", doneCount: cues.length } : f))
      );
    } catch (err) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status: "error", error: err.message || "Lỗi không xác định", doneCount }
            : f
        )
      );
    } finally {
      activeCountRef.current -= 1;
      tryStartNext();
    }
  }

  function handleFiles(fileList) {
    Array.from(fileList).forEach((f) => {
      if (!f.name.toLowerCase().endsWith(".srt")) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const cues = parseSRT(String(e.target.result));
        if (cues.length === 0) return;
        const fileObj = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          cues,
          status: "queued",
          doneCount: 0,
          error: null,
          settings: { sourceLang, targetLang, bilingual, contextNote, provider, geminiApiKey, geminiModel },
        };
        setFiles((prev) => [...prev, fileObj]);
        queueRef.current.push(fileObj.id);
      };
      reader.readAsText(f, "utf-8");
    });
  }

  function startTranslating() {
    tryStartNext();
  }

  function cancelFile(id) {
    cancelFlags.current[id] = true;
    queueRef.current = queueRef.current.filter((x) => x !== id);
    setFiles((prev) =>
      prev.map((f) => (f.id === id && f.status === "queued" ? { ...f, status: "cancelled" } : f))
    );
  }

  function retryFile(id) {
    cancelFlags.current[id] = false;
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: "queued", error: null } : f)));
    queueRef.current.push(id);
    tryStartNext();
  }

  function removeFile(id) {
    delete cancelFlags.current[id];
    queueRef.current = queueRef.current.filter((x) => x !== id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function downloadFile(file) {
    const content = serializeSRT(file.cues, file.settings.bilingual);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = file.name.replace(/\.srt$/i, "");
    a.download = `${base}.${file.settings.targetLang}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const hasActive = files.some((f) => f.status === "running" || f.status === "queued");
  const queuedCount = files.filter((f) => f.status === "queued").length;

  return (
    <div className="st-app">
      <style>{CSS}</style>

      <div className="st-header">
        <div className="st-mark" aria-hidden="true">
          <span className="st-mark-line st-mark-line--long" />
          <span className="st-mark-line st-mark-line--short" />
        </div>
        <div>
          <h1>Dịch phụ đề .srt</h1>
          <p className="st-tagline">
            Dịch theo ngữ cảnh bằng AI, xử lý nhiều file cùng lúc. Hủy giữa chừng vẫn giữ nguyên
            phần đã dịch xong.
          </p>
        </div>
      </div>

      <div className="st-controls">
        <div className="st-provider-row">
          <div className="st-field">
            <label htmlFor="st-provider">Mô hình dịch</label>
            <select id="st-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {provider === "gemini" && (
            <>
              <div className="st-field">
                <label htmlFor="st-gemini-model">Phiên bản Gemini</label>
                <select
                  id="st-gemini-model"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                >
                  {GEMINI_MODELS.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="st-field st-field--grow">
                <label htmlFor="st-gemini-key">Gemini API key</label>
                <input
                  id="st-gemini-key"
                  type="password"
                  placeholder="Dán API key từ Google AI Studio"
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  autoComplete="off"
                />
                <span className="st-field-hint">
                  Lấy key miễn phí tại aistudio.google.com — key chỉ lưu tạm trong bộ nhớ trình
                  duyệt, gửi thẳng tới Google, không đi qua Claude.
                </span>
              </div>
            </>
          )}
        </div>
        <div className="st-field">
          <label htmlFor="st-src">Ngôn ngữ gốc</label>
          <select id="st-src" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="st-field">
          <label htmlFor="st-tgt">Dịch sang</label>
          <select id="st-tgt" value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
            {TARGET_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="st-field st-field--grow">
          <label htmlFor="st-note">Bối cảnh nội dung (tuỳ chọn)</label>
          <input
            id="st-note"
            type="text"
            placeholder="VD: phim hài lãng mạn, nhân vật xưng hô thân mật..."
            value={contextNote}
            onChange={(e) => setContextNote(e.target.value)}
          />
        </div>
        <label className="st-checkbox">
          <input type="checkbox" checked={bilingual} onChange={(e) => setBilingual(e.target.checked)} />
          <span>Song ngữ (giữ câu gốc)</span>
        </label>
      </div>
      <p className="st-note">Cài đặt phía trên áp dụng cho các file được thêm vào sau đó.</p>

      <div
        className={`st-dropzone ${isDragging ? "st-dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <Upload size={20} />
        <span>
          Kéo thả file .srt vào đây, hoặc bấm để chọn (nhiều file cùng lúc) — sau đó bấm "Bắt đầu
          dịch"
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="st-toolbar">
          {queuedCount > 0 && (
            <button className="st-btn st-btn--accent" onClick={startTranslating}>
              <Upload size={13} /> Bắt đầu dịch ({queuedCount})
            </button>
          )}
          {hasActive && (
            <button
              className="st-btn"
              onClick={() =>
                files.forEach((f) => {
                  if (f.status === "running" || f.status === "queued") cancelFile(f.id);
                })
              }
            >
              <Ban size={13} /> Hủy tất cả
            </button>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="st-list">
          {files.map((file) => {
            const total = file.cues.length;
            const pct = total ? Math.round((file.doneCount / total) * 100) : 0;
            return (
              <div className="st-row" key={file.id}>
                <div className="st-row-main">
                  <FileText size={16} className="st-row-icon" />
                  <div className="st-row-info">
                    <div className="st-row-name" title={file.name}>
                      {file.name}
                    </div>
                    <div className="st-row-meta">
                      {langLabel(file.settings.sourceLang)} → {langLabel(file.settings.targetLang)}
                      {" · "}
                      {file.settings.provider === "gemini"
                        ? GEMINI_MODELS.find((m) => m.code === file.settings.geminiModel)?.label ||
                          "Gemini"
                        : "Claude"}
                    </div>
                  </div>
                </div>

                <div className="st-row-progress">
                  <div className="st-track">
                    <div className="st-track-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="st-count">
                    {file.doneCount}/{total}
                  </span>
                </div>

                <div className="st-row-status">
                  {file.status === "running" && <Loader2 size={16} className="st-spin" />}
                  {file.status === "done" && <CheckCircle2 size={16} className="st-ok" />}
                  {file.status === "cancelled" && <Ban size={16} className="st-muted" />}
                  {file.status === "error" && <AlertCircle size={16} className="st-err" />}
                  {file.status === "queued" && <span className="st-muted-text">Đang chờ</span>}
                </div>

                <div className="st-row-actions">
                  {(file.status === "running" || file.status === "queued") && (
                    <button className="st-btn" onClick={() => cancelFile(file.id)}>
                      <X size={13} /> Hủy
                    </button>
                  )}
                  {file.status === "error" && (
                    <button className="st-btn" onClick={() => retryFile(file.id)}>
                      <RotateCcw size={13} /> Thử lại
                    </button>
                  )}
                  {file.doneCount > 0 && (
                    <button className="st-btn st-btn--accent" onClick={() => downloadFile(file)}>
                      <Download size={13} /> Tải xuống
                    </button>
                  )}
                  {(file.status === "done" || file.status === "cancelled" || file.status === "error") && (
                    <button className="st-btn st-btn--icon" title="Xóa" onClick={() => removeFile(file.id)}>
                      <X size={13} />
                    </button>
                  )}
                </div>

                {file.status === "error" && <div className="st-row-error">{file.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
